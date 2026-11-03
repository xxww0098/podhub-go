package submit

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/listing/read/domain"
	readrepo "github.com/xxww0098/podhub-go/internal/listing/read/repo"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	queue "github.com/xxww0098/podhub-go/internal/queue/contract"
)

func TestTaskRecordsReportPolicyWaitFromCurrentSplitJob(t *testing.T) {
	f, _, _, job, storePK := queuedTransportFixture(t, 986958, 3)
	worker := policyWorkerPool(t, f.pool)
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO store_listing_policies(org_id,store_id,daily_cap) VALUES($1,$2,1)`, f.org, storePK); err != nil {
		t.Fatal(err)
	}
	tr := &capturedBatchTransport{}
	if err := testSubmit().Work(f.ctx, worker, job, tr); err != nil {
		t.Fatal(err)
	}
	var next queue.Claimed
	err := f.pool.QueryRow(f.ctx, `UPDATE jobs SET state='running',attempt=4,lease_owner='policy-records',lease_epoch=1,lease_until=clock_timestamp()+interval '10 minutes'
		WHERE org_id=$1 AND state='queued' RETURNING id,org_id,kind,submitter_user_id,payload`, f.org).Scan(&next.ID, &next.OrgID, &next.Kind, &next.SubmitterUserID, &next.Payload)
	if err != nil {
		t.Fatal(err)
	}
	next.Owner, next.Epoch, next.Attempt, next.MaxAttempts = "policy-records", 1, 4, 8
	if err := testSubmit().Work(f.ctx, worker, next, tr); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE jobs SET attempt=7 WHERE id=$1`, job.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `ALTER ROLE podhub_login_api PASSWORD 'policy-records-api'`); err != nil {
		t.Fatal(err)
	}
	cfg := f.pool.Config().Copy()
	cfg.ConnConfig.User, cfg.ConnConfig.Password = "podhub_login_api", "policy-records-api"
	api, err := pgxpool.NewWithConfig(f.ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer api.Close()
	var page domain.TaskRecordsPage
	err = db.InTx(f.ctx, api, db.App(f.org), func(tx pgx.Tx) error {
		var member int64
		if err := tx.QueryRow(f.ctx, `SELECT id FROM organization_members WHERE org_id=$1 AND user_id=$2`, f.org, f.user).Scan(&member); err != nil {
			return err
		}
		var err error
		page, err = readrepo.TaskRecords(f.ctx, tx, f.org, f.user, member, true, domain.TaskRecordFilter{Kind: "listing", Limit: 50})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 3 {
		t.Fatalf("records=%d", len(page.Items))
	}
	waiting, accepted := 0, 0
	for _, item := range page.Items {
		if item.State == Accepted {
			accepted++
			if item.Attempt == nil || *item.Attempt != 7 {
				t.Fatalf("accepted receipt did not use its own shrunken job: %+v", item)
			}
			continue
		}
		waiting++
		if item.State != Queued || item.Attempt == nil || *item.Attempt != 3 || item.NextAttemptAt == nil || !item.NextAttemptAt.Equal(policyDayStart(time.Now()).Add(24*time.Hour)) || item.ErrorCode != CodeStoreDailyCap {
			t.Fatalf("policy wait not projected from the remainder job: %+v", item)
		}
	}
	if waiting != 2 || accepted != 1 || tr.writes != 1 {
		t.Fatalf("reading task records changed business state: waiting=%d accepted=%d sends=%d", waiting, accepted, tr.writes)
	}
}
