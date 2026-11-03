package submit

import (
	"bytes"
	"context"
	"encoding/json"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	ozoncontract "github.com/xxww0098/podhub-go/internal/seller/ozon/contract"
)

func sliceReceiptsCurrent(ctx context.Context, tx pgx.Tx, orgID int64, urls []string) (bool, error) {
	unique := make(map[string]struct{})
	for _, raw := range urls {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		_, ok := ParseUploadKey(raw)
		if !ok {
			return false, nil
		}
		unique[raw] = struct{}{}
	}
	if len(unique) == 0 {
		return true, nil
	}
	values := make([]string, 0, len(unique))
	for raw := range unique {
		values = append(values, raw)
	}
	var count int
	err := tx.QueryRow(ctx, `SELECT count(DISTINCT l.public_url) FROM public.media_object_leases l
		JOIN public.organizations o ON o.id=l.org_id AND o.uuid=l.workspace_uuid
		JOIN public.workspace_slice_storage s ON s.org_id=l.org_id AND s.id::text=l.media_account_id
		WHERE l.org_id=$1 AND l.public_url=ANY($2::text[]) AND l.verification_status='verified'
		AND l.object_key LIKE 'podhub-slices/'||s.id::text||'/uploads/%'
		AND l.public_url=rtrim(s.public_base_url,'/')||'/'||l.object_key
		AND l.public_ready_at IS NOT NULL AND l.expires_at>clock_timestamp() AND l.retired_at IS NULL AND l.deleted_at IS NULL AND l.gc_claim_token IS NULL
		AND CASE WHEN l.batch_id ~ '^[0-9]{13,18}-' THEN
		  NOT EXISTS (SELECT 1 FROM public.workspace_slice_clear_requests r WHERE r.org_id=l.org_id AND r.storage_id::text=l.media_account_id
		    AND split_part(l.batch_id,'-',1)::numeric < extract(epoch FROM r.requested_at)*1000)
		ELSE false END`, orgID, values).Scan(&count)
	return count == len(values), err
}

func sliceImportsCurrent(ctx context.Context, pool *pgxpool.Pool, orgID int64, bodies ...[]byte) (bool, error) {
	for _, body := range bodies {
		if !bytes.Contains(body, []byte("/podhub-slices/")) {
			continue
		}
		tx, err := tenant.BeginApp(ctx, pool.Begin, orgID)
		if err != nil {
			return false, err
		}
		defer tx.Rollback(ctx)
		current, err := sliceImportsCurrentTx(ctx, tx, orgID, bodies...)
		if err != nil {
			return false, err
		}
		if err := tx.Commit(ctx); err != nil {
			return false, err
		}
		return current, nil
	}
	return true, nil
}

func sliceImportsCurrentTx(ctx context.Context, tx pgx.Tx, orgID int64, bodies ...[]byte) (bool, error) {
	var urls []string
	for _, body := range bodies {
		if !bytes.Contains(body, []byte("/podhub-slices/")) {
			continue
		}
		var doc struct {
			Items []struct {
				Images  []string `json:"images"`
				Primary string   `json:"primary_image"`
			} `json:"items"`
		}
		if err := json.Unmarshal(body, &doc); err != nil {
			return false, err
		}
		for _, item := range doc.Items {
			for _, raw := range append(item.Images, item.Primary) {
				if parsed, err := url.Parse(raw); err == nil && strings.Contains(parsed.Path, "/podhub-slices/") {
					urls = append(urls, raw)
				}
			}
		}
	}
	if len(urls) == 0 {
		return true, nil
	}
	return sliceReceiptsCurrent(ctx, tx, orgID, urls)
}

func sliceExpiredOutcome() Outcome {
	out := Classify(Reply{Connect: true})
	out.IntentError, out.JobError = "MEDIA_LEASE_UNAVAILABLE", "MEDIA_LEASE_UNAVAILABLE"
	return out
}

func sliceImageURLs(body []byte) []string {
	urls := []string{}
	for _, raw := range ozoncontract.ImportImageURLs(body) {
		parsed, err := url.Parse(raw)
		if err == nil && strings.Contains(parsed.Path, "/podhub-slices/") {
			urls = append(urls, raw)
		}
	}
	return urls
}
