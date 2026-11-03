package scans

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/xxww0098/podhub-go/internal/app/worker"

	"github.com/xxww0098/podhub-go/internal/listing/submit"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	sellercontract "github.com/xxww0098/podhub-go/internal/seller/contract"
	seller "github.com/xxww0098/podhub-go/internal/seller/ozon"
	ozoncontract "github.com/xxww0098/podhub-go/internal/seller/ozon/contract"
)

// probeAccepted reads due accepted intents. A hit without pending images clears reconcile_after and
// leaves state accepted. Unreadable reads back off; two agreeing absences stop
// the probe, and eight unreadable passes give up. Release and supersede are
// not applied. The existing ledger grants read-only convergence, even after
// its original member or subscription expires.
func probeAccepted(ctx context.Context, pool *pgxpool.Pool, eg *seller.Egress, ring seal.Ring, keyID string, limit int) (bool, error) {
	rows, err := claimAccepted(ctx, pool, limit)
	if err != nil || len(rows) == 0 {
		return len(rows) > 0, err
	}
	type key struct {
		org   int64
		store string
	}
	groups := map[key][]acceptedRow{}
	for _, row := range rows {
		k := key{row.OrgID, row.StoreID}
		groups[k] = append(groups[k], row)
	}
	for k, batch := range groups {
		sights := readAccepted(ctx, pool, eg, ring, keyID, k.org, k.store, batch)
		if err := applyAccepted(ctx, pool, k.org, batch, sights); err != nil {
			return true, err
		}
	}
	return true, nil
}

type acceptedRow struct {
	ID            string
	OrgID         int64
	StoreID       string
	RowID         string
	Revision      int64
	RequestHash   string
	OfferID       string
	Passes        int32
	Observation   string
	TaskID        string
	ClaimUntil    time.Time
	ImageURLs     []string
	ImagesFetched bool
}

type acceptedSight struct {
	sight    submit.Sight
	found    submit.Found
	task     *importTaskItem
	terminal bool
	failed   bool
	pictures json.RawMessage
}

func claimAccepted(ctx context.Context, pool *pgxpool.Pool, limit int) ([]acceptedRow, error) {
	var claimed []acceptedRow
	err := asWorker(ctx, pool, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			WITH due AS (
			    SELECT id FROM submission_intents
			     WHERE state = 'accepted'
			       AND reconcile_after IS NOT NULL
			       AND reconcile_after <= clock_timestamp()
			       AND (reconcile_claim_until IS NULL OR reconcile_claim_until <= clock_timestamp())
			       AND offer_id IS NOT NULL AND btrim(offer_id) <> ''
			     ORDER BY reconcile_after, updated_at, id
			     LIMIT $1
			     FOR UPDATE SKIP LOCKED
			)
			UPDATE submission_intents i
			   SET reconcile_claim_until = clock_timestamp() + interval '60 seconds',
			       updated_at = clock_timestamp()
			  FROM due
			 WHERE i.id = due.id
			RETURNING i.id::text, i.org_id, i.store_id::text, i.offer_id,
		          COALESCE((i.reconciliation_outcome->'probe'->>'passes')::int, 0),
		          COALESCE(i.reconciliation_outcome->'probe'->>'observation', ''),
		          COALESCE(i.external_task_id,''),i.reconcile_claim_until,
		          i.listing_row_id::text,i.row_revision,i.request_hash,i.slice_image_urls,i.slice_images_fetched_at IS NOT NULL`, limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var row acceptedRow
			if err := rows.Scan(&row.ID, &row.OrgID, &row.StoreID, &row.OfferID, &row.Passes, &row.Observation, &row.TaskID, &row.ClaimUntil, &row.RowID, &row.Revision, &row.RequestHash, &row.ImageURLs, &row.ImagesFetched); err != nil {
				return err
			}
			claimed = append(claimed, row)
		}
		return rows.Err()
	})
	return claimed, err
}

func readAccepted(ctx context.Context, pool *pgxpool.Pool, eg *seller.Egress, ring seal.Ring, keyID string, orgID int64, storeID string, rows []acceptedRow) map[string]acceptedSight {
	out := map[string]acceptedSight{}
	mark := func(sight submit.Sight) {
		for _, row := range rows {
			out[row.ID] = acceptedSight{sight: sight}
		}
	}
	ids := make([]string, len(rows))
	for i, row := range rows {
		ids[i] = row.ID
	}
	tr, err := worker.ListingTransport(eg, pool, ring, keyID).BindStore(ctx, sellercontract.StoreBinding{
		OrgID: orgID, StoreUUID: storeID, IntentIDs: ids, ReadOnly: true,
	})
	if err != nil {
		mark(submit.SightUnreadable)
		return out
	}
	return observeAccepted(ctx, tr, rows)
}

type importTaskItem struct {
	OfferID   string            `json:"offer_id"`
	ProductID int64             `json:"product_id"`
	Status    string            `json:"status"`
	Errors    []json.RawMessage `json:"errors"`
	failed    bool
	// failureCode is the provider's first error-level code. It is not part of
	// the wire shape; it only makes the stored issue specific.
	failureCode string
}

// providerCodeLimit keeps a provider string from bloating the issue history.
const providerCodeLimit = 64

func parseImportTask(status int, body string, err error) (map[string]importTaskItem, bool) {
	if err != nil || status < 200 || status >= 300 {
		return nil, false
	}
	var decoded struct {
		Result *struct {
			Items *[]importTaskItem `json:"items"`
		} `json:"result"`
	}
	if json.Unmarshal([]byte(body), &decoded) != nil || decoded.Result == nil || decoded.Result.Items == nil {
		return nil, false
	}
	out := map[string]importTaskItem{}
	for _, item := range *decoded.Result.Items {
		if item.OfferID == "" {
			return nil, false
		}
		if _, duplicate := out[item.OfferID]; duplicate {
			return nil, false
		}
		switch item.Status {
		case "pending", "imported", "failed", "skipped":
		default:
			return nil, false
		}
		for _, raw := range item.Errors {
			var issue struct {
				Level   string `json:"level"`
				Code    string `json:"code"`
				Message string `json:"message"`
			}
			if json.Unmarshal(raw, &issue) != nil {
				return nil, false
			}
			if item.Status != "failed" {
				switch strings.ToLower(issue.Level) {
				case "warning":
				case "error":
					// Ozon can report moderation errors while status remains imported.
					item.failed = true
				default:
					return nil, false
				}
			}
			if item.failureCode == "" && strings.EqualFold(issue.Level, "error") {
				item.failureCode = providerCode(issue.Code)
			}
		}
		if item.failureCode == "" && item.Status == "failed" {
			// A failed item without an error-level entry still names a reason
			// in its first coded error; do not drop it from the issue.
			for _, raw := range item.Errors {
				var issue struct {
					Code string `json:"code"`
				}
				if json.Unmarshal(raw, &issue) == nil {
					if code := providerCode(issue.Code); code != "" {
						item.failureCode = code
						break
					}
				}
			}
		}
		out[item.OfferID] = item
	}
	return out, true
}

func providerCode(raw string) string {
	code := strings.TrimSpace(raw)
	if len(code) > providerCodeLimit {
		code = code[:providerCodeLimit]
	}
	return code
}

// acceptedFailureSummary keeps Ozon's own reason in the issue text. The
// generic wording stays when the receipt carries no code.
func acceptedFailureSummary(item *importTaskItem) string {
	const generic = "Ozon 异步导入失败，请核对卖家后台并保留本次受理记录，勿重复发送。"
	if item == nil || item.failureCode == "" {
		return generic
	}
	switch item.failureCode {
	case "currency_differs_from_contract":
		return "Ozon 异步导入失败：商品币种与店铺合同币种不一致。请在卖家后台核对合同币种；本记录保持已受理，不可重复发送。"
	}
	return "Ozon 异步导入失败（" + item.failureCode + "），请核对卖家后台并保留本次受理记录，勿重复发送。"
}

// A task id is only acceptance. Inspect the asynchronous task first, then
// confirm imported/skipped products by offer id; neither is an on-sale claim.
// All tasks in one store share one product read per InfoListBatch offers.
func observeAccepted(ctx context.Context, tr submit.Transport, rows []acceptedRow) map[string]acceptedSight {
	out := map[string]acceptedSight{}
	for _, row := range rows {
		out[row.ID] = acceptedSight{sight: submit.SightUnreadable}
	}
	byTask := map[string][]acceptedRow{}
	for _, row := range rows {
		byTask[row.TaskID] = append(byTask[row.TaskID], row)
	}
	var confirm []acceptedRow
	for taskID, batch := range byTask {
		id, err := strconv.ParseInt(taskID, 10, 64)
		if err != nil || id <= 0 {
			continue
		}
		body, _ := json.Marshal(map[string]int64{"task_id": id})
		callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		status, raw, err := tr.Read(callCtx, "/v1/product/import/info", body)
		cancel()
		taskItems, ok := parseImportTask(status, raw, err)
		if !ok {
			continue
		}
		for _, row := range batch {
			item, ok := taskItems[row.OfferID]
			if !ok {
				continue
			}
			hit := acceptedSight{sight: submit.SightUnreadable, task: &item}
			if item.Status == "failed" || item.failed {
				hit.failed = true
				hit.terminal = true
			}
			out[row.ID] = hit
			if !hit.failed && (item.Status == "imported" || item.Status == "skipped") {
				confirm = append(confirm, row)
			}
		}
	}
	if len(confirm) == 0 {
		return out
	}
	offers := uniqueOffers(confirm)
	found, readable := readProductInfo(ctx, tr, offers)
	for _, row := range confirm {
		if !readable[row.OfferID] {
			continue
		}
		hit := out[row.ID]
		if product, ok := found[row.OfferID]; ok {
			if hit.task.ProductID > 0 && hit.task.ProductID != product.ProductID {
				continue
			}
			hit.sight, hit.found, hit.terminal = submit.SightFound, product, true
		} else {
			hit.sight = submit.SightAbsent
		}
		out[row.ID] = hit
	}
	for _, row := range confirm {
		hit := out[row.ID]
		if len(row.ImageURLs) == 0 || row.ImagesFetched || hit.sight != submit.SightFound {
			continue
		}
		body, _ := json.Marshal(map[string][]string{"product_id": {strconv.FormatInt(hit.found.ProductID, 10)}})
		callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		status, raw, err := tr.Read(callCtx, "/v2/product/pictures/info", body)
		cancel()
		if err == nil && status >= 200 && status < 300 && ozoncontract.PicturesFetched([]byte(raw), hit.found.ProductID, row.ImageURLs) {
			hit.pictures = json.RawMessage(raw)
			out[row.ID] = hit
		}
	}
	return out
}

func uniqueOffers(rows []acceptedRow) []string {
	seen := make(map[string]bool, len(rows))
	offers := make([]string, 0, len(rows))
	for _, row := range rows {
		if row.OfferID == "" || seen[row.OfferID] {
			continue
		}
		seen[row.OfferID] = true
		offers = append(offers, row.OfferID)
	}
	return offers
}

// readProductInfo reads the store's confirmed offers in the same bounded
// batches as the unknown-write probe. readable is the set of offers whose
// response was a complete list; only those may be treated as absent.
func readProductInfo(ctx context.Context, tr submit.Transport, offers []string) (map[string]submit.Found, map[string]bool) {
	found := map[string]submit.Found{}
	readable := map[string]bool{}
	for start := 0; start < len(offers); start += submit.InfoListBatch {
		end := start + submit.InfoListBatch
		if end > len(offers) {
			end = len(offers)
		}
		chunk := offers[start:end]
		body, _ := json.Marshal(map[string]any{"offer_id": chunk})
		callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		status, raw, err := tr.Read(callCtx, "/v3/product/info/list", body)
		cancel()
		parsed, ok := parseAccepted(status, []byte(raw), err)
		if !ok {
			continue
		}
		requested := make(map[string]bool, len(chunk))
		for _, offer := range chunk {
			requested[offer] = true
		}
		for offer := range parsed {
			if !requested[offer] {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		for offer, item := range parsed {
			found[offer] = item
		}
		for _, offer := range chunk {
			readable[offer] = true
		}
	}
	return found, readable
}

func parseAccepted(status int, body []byte, err error) (map[string]submit.Found, bool) {
	if err != nil || status < 200 || status >= 300 {
		return nil, false
	}
	var parsed struct {
		Items *[]struct {
			ID      int64  `json:"id"`
			OfferID string `json:"offer_id"`
			Sources []struct {
				SKU int64 `json:"sku"`
			} `json:"sources"`
		} `json:"items"`
	}
	if json.Unmarshal(body, &parsed) != nil || parsed.Items == nil {
		return nil, false
	}
	out := map[string]submit.Found{}
	for _, item := range *parsed.Items {
		if item.ID <= 0 || item.OfferID == "" {
			return nil, false
		}
		if _, duplicate := out[item.OfferID]; duplicate {
			return nil, false
		}
		sku := int64(0)
		for _, source := range item.Sources {
			if source.SKU > 0 {
				sku = source.SKU
				break
			}
		}
		out[item.OfferID] = submit.Found{ProductID: item.ID, SKU: sku}
	}
	return out, true
}

func applyAccepted(ctx context.Context, pool *pgxpool.Pool, orgID int64, rows []acceptedRow, sights map[string]acceptedSight) error {
	return asWorker(ctx, pool, func(tx pgx.Tx) error {
		for _, row := range rows {
			sight, ok := sights[row.ID]
			if !ok {
				sight.sight = submit.SightUnreadable
			}
			action := submit.DecideAcceptedProbe(submit.ProbeMemory{Passes: row.Passes, Observation: row.Observation}, sight.sight, sight.found)
			terminal := sight.terminal || action.Kind == "accept" || action.Kind == "stop" || action.Kind == "give_up"
			// Ozon can confirm the product before it publishes the SKU. Keep
			// reading the accepted import on the receipt backoff instead of
			// settling the row without identifiers; the pass cap still ends
			// the probe when the store never returns one.
			if action.Kind == "accept" && sight.found.SKU <= 0 {
				action = submit.AcceptedSKURetry(submit.ProbeMemory{Passes: row.Passes})
				terminal = action.Kind == "give_up"
			}
			wait := action.BackoffSecs
			if wait <= 0 {
				wait = 900
			}
			kind := action.Kind
			if sight.failed {
				kind = "failed"
				terminal = true
			}
			if len(row.ImageURLs) > 0 && !row.ImagesFetched && len(sight.pictures) == 0 && !sight.failed {
				terminal = false
				wait = max(wait, 60)
			}
			metadata := map[string]any{"probe": map[string]any{"passes": action.Passes, "observation": action.Observation, "kind": kind}}
			if len(sight.pictures) > 0 {
				metadata["slicePictures"] = sight.pictures
			}
			if sight.task != nil {
				metadata["importTask"] = sight.task
			}
			if sight.found.ProductID > 0 {
				metadata["found"] = map[string]int64{"productId": sight.found.ProductID, "sku": sight.found.SKU}
			}
			issues := []map[string]any{}
			if sight.failed {
				summary := acceptedFailureSummary(sight.task)
				issues = append(issues, map[string]any{
					"code": submit.CodeRowRejected, "phase": "submit", "scope": "row",
					"summary": summary, "safeMessage": summary,
					"remediation":    "核对卖家后台的导入结果；本记录保持已受理，不可恢复或重复发送。",
					"allowedActions": []string{"check_store"}, "dispatchEvidence": "rejected",
					"intentId": row.ID, "inputRevision": row.Revision, "requestHash": row.RequestHash,
					"rowId": row.RowID, "storeId": row.StoreID,
					// The accepted ledger predates this read and does not retain its
					// dispatch credential revision or a scanner job id. Keep them
					// unspecified instead of attributing current keys to that write.
					"credentialRevision": int64(0), "traceId": "", "retryAfterFallback": false,
					"createdAtMs": time.Now().UnixMilli(), "resolvedAtMs": nil,
					"endpoint": "/v1/product/import/info",
				})
			}
			rawMetadata, err := json.Marshal(metadata)
			if err != nil {
				return err
			}
			rawIssues, err := json.Marshal(issues)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
				UPDATE submission_intents
				   SET reconcile_after = CASE WHEN $4 THEN NULL ELSE clock_timestamp() + ($3::bigint * interval '1 second') END,
				       reconcile_claim_until = NULL,
				       reconciliation_outcome = COALESCE(reconciliation_outcome,'{}'::jsonb) || $5::jsonb,
				       submission_issues = CASE WHEN $7 THEN
				         (SELECT COALESCE(jsonb_agg(history.issue ORDER BY history.ord),'[]'::jsonb)
				            FROM jsonb_array_elements(submission_issues) WITH ORDINALITY history(issue,ord)
				           WHERE history.ord > jsonb_array_length(submission_issues)-7) || $6::jsonb
				         ELSE submission_issues END,
				       last_error_code=CASE WHEN $7 THEN $8::text ELSE last_error_code END,
				       slice_images_fetched_at=CASE WHEN $10 THEN COALESCE(slice_images_fetched_at,clock_timestamp()) ELSE slice_images_fetched_at END,
				       updated_at = clock_timestamp()
				 WHERE org_id = $1 AND id = $2::uuid AND state = 'accepted' AND reconcile_claim_until=$9::timestamptz`,
				orgID, row.ID, wait, terminal, string(rawMetadata), string(rawIssues), sight.failed, submit.CodeRowRejected, row.ClaimUntil, len(sight.pictures) > 0); err != nil {
				return err
			}
		}
		return nil
	})
}
