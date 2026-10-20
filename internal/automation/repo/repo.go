// Package automationrepo runs the automation SQL inside the caller's transaction.
package automationrepo

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/automation/contract"
	"github.com/xxww0098/podhub-go/internal/automation/domain"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// BeginApp is the opener the process passes (tenant.BeginApp). Tenant
// transactions go through db.InTx; a nil opener still fails closed. Grant
// routes begin a plain transaction under the login role.
type BeginApp func(ctx context.Context, begin func(context.Context) (pgx.Tx, error), orgID int64) (pgx.Tx, error)

// errStop rolls the transaction back and reports success to the caller.
// Progress and settle use it when the command is gone.
var errStop = errors.New("automation rollback")

// Repo is the automation store.
type Repo struct {
	pool  *pgxpool.Pool
	begin BeginApp
}

// New keeps the pool and the tenant opener.
func New(pool *pgxpool.Pool, begin BeginApp) Repo {
	return Repo{pool: pool, begin: begin}
}

func mapDB(err error) error {
	if err == nil {
		return nil
	}
	var fault *contract.Fault
	if errors.As(err, &fault) || errors.Is(err, contract.ErrMissing) || errors.Is(err, contract.ErrAuthority) {
		return err
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "55P03":
			return contract.Busy()
		case "P0M01":
			return contract.Conflict()
		}
	}
	return contract.Unavailable()
}

// withTenant runs fn in an app session for orgID. org id <= 0 is rejected
// by db.InTx before Begin and maps to Unavailable.
func (r Repo) withTenant(ctx context.Context, orgID int64, fn func(pgx.Tx) error) error {
	if r.pool == nil || r.begin == nil {
		return contract.Unavailable()
	}
	err := db.InTx(ctx, r.pool, db.App(orgID), fn)
	if errors.Is(err, errStop) {
		return nil
	}
	return mapDB(err)
}

func (r Repo) withPlain(ctx context.Context, fn func(pgx.Tx) error) error {
	if r.pool == nil {
		return contract.Unavailable()
	}
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return mapDB(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(tx); err != nil {
		if errors.Is(err, errStop) {
			return nil
		}
		return mapDB(err)
	}
	return mapDB(tx.Commit(ctx))
}

func (r Repo) ListAssetSets(ctx context.Context, orgID, userID int64) ([]domain.AssetSet, error) {
	var sets []domain.AssetSet
	err := r.withTenant(ctx, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, sqlListAssets, orgID, userID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id, name string
			var created time.Time
			var itemID, file, sum, runtime *string
			var size *int64
			if err := rows.Scan(&id, &name, &created, &itemID, &file, &sum, &size, &runtime); err != nil {
				return err
			}
			if len(sets) == 0 || sets[len(sets)-1].ID != id {
				sets = append(sets, domain.AssetSet{ID: id, Name: name, CreatedAtMS: millis(created), Items: []domain.AssetItem{}})
			}
			if itemID == nil {
				continue
			}
			item := domain.AssetItem{ID: *itemID}
			if file != nil {
				item.FileName = *file
			}
			if sum != nil {
				item.SHA256 = *sum
			}
			if size != nil {
				item.SizeBytes = *size
			}
			item.RuntimeID = blankRuntime(runtime)
			sets[len(sets)-1].Items = append(sets[len(sets)-1].Items, item)
		}
		return rows.Err()
	})
	return sets, err
}

func (r Repo) CreateAssetSet(ctx context.Context, orgID, userID int64, name string, items []domain.ItemInput) (domain.AssetSet, error) {
	var set domain.AssetSet
	err := r.withTenant(ctx, orgID, func(tx pgx.Tx) error {
		var created time.Time
		if err := tx.QueryRow(ctx, sqlInsertSet, orgID, userID, name).Scan(&set.ID, &set.Name, &created); err != nil {
			return err
		}
		set.CreatedAtMS = millis(created)
		set.Items = []domain.AssetItem{}
		for _, item := range items {
			var runtime any
			if item.RuntimeID != nil {
				runtime = *item.RuntimeID
			}
			var row domain.AssetItem
			var size int64
			var rt *string
			err := tx.QueryRow(ctx, sqlInsertItem, set.ID, item.Key, item.FileName, item.SHA256, item.SizeBytes, runtime, orgID, userID).
				Scan(&row.ID, &row.FileName, &row.SHA256, &size, &rt)
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			if err != nil {
				return err
			}
			row.SizeBytes = size
			row.RuntimeID = blankRuntime(rt)
			set.Items = append(set.Items, row)
		}
		return nil
	})
	return set, err
}

func (r Repo) Claim(ctx context.Context, orgID, userID int64, runtimeID string, limit int64) ([]domain.Claimed, error) {
	var out []domain.Claimed
	err := r.withTenant(ctx, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, sqlClaim, orgID, userID, runtimeID, limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			claimed, err := scanClaimed(rows)
			if err != nil {
				return err
			}
			out = append(out, claimed)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, sqlTouchHeartbeat, orgID, userID, runtimeID)
		return err
	})
	return out, err
}

func (r Repo) Renew(ctx context.Context, orgID, userID int64, runtimeID string, ids []string, epochs []int64) ([]domain.RenewHit, error) {
	hits := make([]domain.RenewHit, 0, len(ids))
	err := r.withTenant(ctx, orgID, func(tx pgx.Tx) error {
		for i := range ids {
			var cancel bool
			err := tx.QueryRow(ctx, sqlRenew, orgID, userID, ids[i], epochs[i], runtimeID).Scan(&cancel)
			if errors.Is(err, pgx.ErrNoRows) {
				hits = append(hits, domain.RenewHit{})
				continue
			}
			if err != nil {
				return err
			}
			hits = append(hits, domain.RenewHit{Matched: true, Cancel: cancel})
		}
		return nil
	})
	return hits, err
}

func (r Repo) Progress(ctx context.Context, orgID, userID int64, id string, epoch int64, progress json.RawMessage) (domain.WriteResult, error) {
	return r.writeBack(ctx, orgID, id, func(tx pgx.Tx) (domain.WriteResult, error) {
		var res domain.WriteResult
		_, _, _, _, _, cancel, err := scanCommand(tx.QueryRow(ctx, sqlProgress, orgID, userID, id, string(progress), epoch))
		if errors.Is(err, pgx.ErrNoRows) {
			return r.missing(ctx, tx, orgID, id)
		}
		if err != nil {
			return res, err
		}
		res.Applied = true
		res.CancelRequested = cancel != nil
		return res, nil
	})
}

func (r Repo) Settle(ctx context.Context, orgID, userID int64, id string, epoch int64, status string, result, errJSON *json.RawMessage) (domain.WriteResult, error) {
	return r.writeBack(ctx, orgID, id, func(tx pgx.Tx) (domain.WriteResult, error) {
		var res domain.WriteResult
		_, _, _, _, _, cancel, err := scanCommand(tx.QueryRow(ctx, sqlSettle, orgID, userID, id, status, jsonbArg(result), jsonbArg(errJSON), epoch))
		if errors.Is(err, pgx.ErrNoRows) {
			return r.missing(ctx, tx, orgID, id)
		}
		if err != nil {
			return res, err
		}
		res.Applied = true
		res.CancelRequested = cancel != nil
		return res, nil
	})
}

func (r Repo) writeBack(ctx context.Context, orgID int64, id string, fn func(pgx.Tx) (domain.WriteResult, error)) (domain.WriteResult, error) {
	var res domain.WriteResult
	err := r.withTenant(ctx, orgID, func(tx pgx.Tx) error {
		var err error
		res, err = fn(tx)
		if err != nil {
			return err
		}
		if res.Gone {
			return errStop
		}
		return nil
	})
	return res, err
}

func (r Repo) missing(ctx context.Context, tx pgx.Tx, orgID int64, id string) (domain.WriteResult, error) {
	var one int
	err := tx.QueryRow(ctx, sqlCommandExists, orgID, id).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.WriteResult{Gone: true}, nil
	}
	if err != nil {
		return domain.WriteResult{}, err
	}
	return domain.WriteResult{}, nil
}

func (r Repo) ListGrants(ctx context.Context, userID, orgID int64) ([]domain.GrantView, error) {
	var out []domain.GrantView
	err := r.withPlain(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, sqlListGrants, userID, domain.ScopeWorkspace, orgID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			view, err := scanGrant(rows)
			if err != nil {
				return err
			}
			out = append(out, view)
		}
		return rows.Err()
	})
	return out, err
}

func (r Repo) CreateGrant(ctx context.Context, userID, orgID int64, name, tokenHash, tokenPrefix string, actions []string, expiresDays *int64) (domain.GrantView, error) {
	var view domain.GrantView
	err := r.withPlain(ctx, func(tx pgx.Tx) error {
		if err := lockUser(ctx, tx, userID); err != nil {
			return err
		}
		if _, err := liveRole(ctx, tx, userID, orgID); err != nil {
			return err
		}
		if err := lockUserRole(ctx, tx, userID); err != nil {
			return err
		}
		role, err := liveRole(ctx, tx, userID, orgID)
		if err != nil {
			return err
		}
		for _, action := range actions {
			if !domain.LiveAllows(role, action) {
				return contract.ErrAuthority
			}
		}
		var exp any
		if expiresDays != nil {
			exp = *expiresDays
		}
		view, err = scanGrant(tx.QueryRow(ctx, sqlInsertGrant, userID, orgID, domain.ScopeWorkspace, nil, name, tokenHash, tokenPrefix, actions, exp))
		return err
	})
	return view, err
}

func (r Repo) RevokeGrant(ctx context.Context, userID, orgID int64, id string) (string, error) {
	var revoked string
	err := r.withPlain(ctx, func(tx pgx.Tx) error {
		var org *int64
		err := tx.QueryRow(ctx, sqlLockGrant, id, userID, domain.ScopeWorkspace, orgID).Scan(&revoked, &org)
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.ErrMissing
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT set_config($1, $2, true)`, tenantx.GUCAutomationGrantID, revoked); err != nil {
			return err
		}
		if org != nil {
			if _, err := tx.Exec(ctx, `SELECT set_config($1, $2, true)`, tenantx.GUCCurrentOrgID, strconv.FormatInt(*org, 10)); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `DELETE FROM browser_commands WHERE grant_id=$1::uuid`, revoked); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `DELETE FROM automation_runtimes WHERE grant_id=$1::uuid`, revoked); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `DELETE FROM automation_call_receipts WHERE grant_id=$1::uuid`, revoked); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM automation_executions WHERE grant_id=$1::uuid`, revoked); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, sqlDeleteGrant, revoked, userID, domain.ScopeWorkspace, orgID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			revoked = ""
			return contract.ErrMissing
		}
		return nil
	})
	return revoked, err
}

func (r Repo) ListRuntimes(ctx context.Context, orgID, userID int64) ([]domain.RuntimeRow, error) {
	var out []domain.RuntimeRow
	err := r.withTenant(ctx, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, sqlListRuntimes, orgID, userID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			row, err := scanRuntime(rows)
			if err != nil {
				return err
			}
			out = append(out, row)
		}
		return rows.Err()
	})
	return out, err
}

func (r Repo) RegisterRuntime(ctx context.Context, orgID, userID int64, grantID, label, renderer string) (domain.RuntimeRow, error) {
	var row domain.RuntimeRow
	err := r.withTenant(ctx, orgID, func(tx pgx.Tx) error {
		scanned, err := scanRuntime(tx.QueryRow(ctx, sqlInsertRuntime, orgID, userID, label, renderer, grantID))
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.ErrMissing
		}
		row = scanned
		return err
	})
	return row, err
}

func (r Repo) DeregisterRuntime(ctx context.Context, orgID, userID int64, id string) (domain.RuntimeRow, error) {
	var row domain.RuntimeRow
	err := r.withTenant(ctx, orgID, func(tx pgx.Tx) error {
		scanned, err := scanRuntime(tx.QueryRow(ctx, sqlDeregister, orgID, userID, id))
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.ErrMissing
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, sqlReleaseCommands, orgID, id); err != nil {
			return err
		}
		row = scanned
		return nil
	})
	return row, err
}

func (r Repo) HeartbeatRuntime(ctx context.Context, orgID, userID int64, id string) (domain.RuntimeRow, error) {
	var row domain.RuntimeRow
	err := r.withTenant(ctx, orgID, func(tx pgx.Tx) error {
		scanned, err := scanRuntime(tx.QueryRow(ctx, sqlHeartbeat, orgID, userID, id))
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.ErrMissing
		}
		row = scanned
		return err
	})
	return row, err
}

func lockUser(ctx context.Context, tx pgx.Tx, userID int64) error {
	var id int64
	err := tx.QueryRow(ctx, sqlLockUser, userID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return contract.ErrAuthority
	}
	return err
}

func lockUserRole(ctx context.Context, tx pgx.Tx, userID int64) error {
	var role string
	err := tx.QueryRow(ctx, sqlLockUserRole, userID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return contract.ErrAuthority
	}
	return err
}

func liveRole(ctx context.Context, tx pgx.Tx, userID, orgID int64) (string, error) {
	var role string
	err := tx.QueryRow(ctx, sqlLiveMember, userID, orgID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", contract.ErrAuthority
	}
	if err != nil {
		return "", err
	}
	var id int64
	err = tx.QueryRow(ctx, sqlLiveOrg, orgID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", contract.ErrAuthority
	}
	return role, err
}

type scannable interface {
	Scan(dest ...any) error
}

func scanClaimed(row scannable) (domain.Claimed, error) {
	id, client, action, payload, epoch, cancel, err := scanCommand(row)
	if err != nil {
		return domain.Claimed{}, err
	}
	return domain.Claimed{
		OperationID: id, Action: action, ClientRequestID: client,
		ClaimEpoch: epoch, Payload: canonicalJSON(payload), CancelRequested: cancel != nil,
	}, nil
}

func scanCommand(row scannable) (id, client, action string, payload []byte, epoch int64, cancel *time.Time, err error) {
	var status string
	var progress, result, errJSON []byte
	var created, updated time.Time
	err = row.Scan(&id, &client, &action, &payload, &status, &epoch, &progress, &result, &errJSON, &cancel, &created, &updated)
	return id, client, action, payload, epoch, cancel, err
}

func scanGrant(row scannable) (domain.GrantView, error) {
	var view domain.GrantView
	var actions []string
	var expires, revoked, used *time.Time
	var created time.Time
	err := row.Scan(&view.ID, &view.Name, &view.TokenPrefix, &actions, &expires, &revoked, &used, &created)
	if err != nil {
		return view, err
	}
	if actions == nil {
		actions = []string{}
	}
	view.Actions = actions
	view.CreatedAtMS = millis(created)
	view.ExpiresAtMS = millisPtr(expires)
	view.RevokedAtMS = millisPtr(revoked)
	view.LastUsedAtMS = millisPtr(used)
	return view, nil
}

func scanRuntime(row scannable) (domain.RuntimeRow, error) {
	var rowOut domain.RuntimeRow
	var beat, created time.Time
	err := row.Scan(&rowOut.ID, &rowOut.GrantID, &rowOut.Label, &rowOut.RendererContract, &beat, &created)
	if err != nil {
		return rowOut, err
	}
	rowOut.HeartbeatAtMS = millis(beat)
	rowOut.CreatedAtMS = millis(created)
	return rowOut, nil
}

func millis(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

func millisPtr(t *time.Time) *int64 {
	if t == nil {
		return nil
	}
	v := t.UnixMilli()
	return &v
}

func blankRuntime(id *string) *string {
	if id == nil || *id == "" {
		return nil
	}
	return id
}

func jsonbArg(raw *json.RawMessage) any {
	if raw == nil {
		return nil
	}
	return string(*raw)
}

func canonicalJSON(b []byte) json.RawMessage {
	if len(b) == 0 {
		return json.RawMessage(`null`)
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, b); err != nil {
		return json.RawMessage(append([]byte(nil), b...))
	}
	return buf.Bytes()
}
