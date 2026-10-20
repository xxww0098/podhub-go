package submit

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
)

// RequeueRetryable is requeue_retryable_intent. The UPDATE is the fixture
// statement. can_resume's function body is not in the export; a rejected
// snapshot is resumable when an unresolved issue lists allowedActions resume,
// the same predicate the intent view already uses. released_for_resend is the
// operator audit or probeReleased with passes >= 2. Zero rows means refused.
func RequeueRetryable(ctx context.Context, tx pgx.Tx, orgID int64, intentID string, rowRevision int64, requestHash, clientOperationID, offerID string) (bool, error) {
	var (
		state, storedHash string
		storedRevision    int64
		last              *string
		issues, outcome   []byte
	)
	err := tx.QueryRow(ctx, `
		SELECT state, row_revision, request_hash, last_error_code, submission_issues, reconciliation_outcome
		FROM submission_intents
		WHERE org_id = $1 AND id = $2::uuid`, orgID, intentID).Scan(
		&state, &storedRevision, &storedHash, &last, &issues, &outcome)
	if err != nil {
		if err == pgx.ErrNoRows {
			return false, nil
		}
		return false, err
	}
	if len(issues) == 0 {
		issues = []byte("[]")
	}
	var outcomeArg any
	if len(outcome) > 0 && string(outcome) != "null" {
		outcomeArg = string(outcome)
	}
	tag, err := tx.Exec(ctx, requeueSQL,
		orgID, intentID, rowRevision, requestHash, clientOperationID, offerID,
		canResumeRejected(state, last, issues),
		storedRevision, storedHash, last, string(issues), state,
		releasedForResend(state, outcome), outcomeArg)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// StampAcceptRows runs stamp_accept. A row that is not unknown updates 0 rows.
func StampAcceptRows(ctx context.Context, tx pgx.Tx, orgID int64, intentID string, productID, sku int64) (int64, error) {
	tag, err := tx.Exec(ctx, stampAcceptSQL, orgID, intentID, productID, sku)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// StampReleaseRows runs stamp_release.
func StampReleaseRows(ctx context.Context, tx pgx.Tx, orgID int64, intentID string, atMs int64, passes int32) (int64, error) {
	tag, err := tx.Exec(ctx, stampReleaseSQL, orgID, intentID, atMs, passes)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// StampRetryRows runs stamp_retry.
func StampRetryRows(ctx context.Context, tx pgx.Tx, orgID int64, intentID string, passes int32, observation, code string, backoff int64) (int64, error) {
	tag, err := tx.Exec(ctx, stampRetrySQL, orgID, intentID, passes, observation, code, backoff)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func canResumeRejected(state string, last *string, issues []byte) bool {
	if state != "rejected" || last == nil {
		return false
	}
	var batch []struct {
		Code         string   `json:"code"`
		ResolvedAtMs *int64   `json:"resolvedAtMs"`
		Allowed      []string `json:"allowedActions"`
	}
	if json.Unmarshal(issues, &batch) != nil {
		return false
	}
	for _, issue := range batch {
		if issue.Code != *last || issue.ResolvedAtMs != nil {
			continue
		}
		for _, action := range issue.Allowed {
			if action == "resume" {
				return true
			}
		}
	}
	return false
}

func releasedForResend(state string, outcome []byte) bool {
	if state != "superseded" || len(outcome) == 0 {
		return false
	}
	var body struct {
		Released *struct {
			ByUserID int64 `json:"byUserId"`
			AtMs     int64 `json:"atMs"`
		} `json:"released"`
		Probe *struct {
			AtMs   int64 `json:"atMs"`
			Passes int64 `json:"passes"`
		} `json:"probeReleased"`
	}
	if json.Unmarshal(outcome, &body) != nil {
		return false
	}
	if body.Probe != nil && body.Probe.AtMs > 0 && body.Probe.Passes >= 2 {
		return true
	}
	return body.Released != nil && body.Released.ByUserID > 0 && body.Released.AtMs > 0
}

const requeueSQL = `
UPDATE submission_intents
SET state = 'queued',
    row_revision = $3,
    request_hash = $4,
    client_operation_id = $5,
    offer_id = $6,
    external_task_id = NULL,
    last_error_code = NULL,
    reconciliation_outcome = NULL,
    submission_receipt = NULL,
    submission_issues = (SELECT COALESCE(jsonb_agg(CASE WHEN issue->>'resolvedAtMs' IS NULL
        AND (issue->>'retryAfterMs' IS NULL OR
             (issue->>'createdAtMs')::numeric + (issue->>'retryAfterMs')::numeric <=
             extract(epoch from clock_timestamp()) * 1000)
        THEN jsonb_set(issue, '{resolvedAtMs}',
            to_jsonb((extract(epoch from clock_timestamp()) * 1000)::bigint))
        ELSE issue END ORDER BY ord), '[]'::jsonb)
        FROM jsonb_array_elements(submission_issues) WITH ORDINALITY e(issue, ord)),
    reconcile_after = NULL,
    cancel_requested_at = NULL,
    updated_at = clock_timestamp()
WHERE org_id = $1
  AND id = $2::uuid
  AND state = $12
  AND row_revision = $8
  AND request_hash = $9
  AND last_error_code IS NOT DISTINCT FROM $10
  AND submission_issues = $11::jsonb
  AND reconciliation_outcome IS NOT DISTINCT FROM $14::jsonb
  AND (
    ($7::boolean AND state = 'rejected')
    OR (state = 'conflict' AND request_hash <> $4)
    OR ($13::boolean AND state = 'superseded')
  )`
