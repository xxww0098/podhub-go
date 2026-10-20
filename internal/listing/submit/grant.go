package submit

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

// GrantTTLMS is how long a browser may hold one issued plaintext before
// the server refuses another grant of that same issuance. The number is
// not taken from Rust. Only the grant path reads it.
const GrantTTLMS int64 = 120_000

// ErrGrantLimited is the GCRA refusal. The slot was not spent.
var ErrGrantLimited = errors.New("browser grant rate limited")

// GrantInput is one browser key grant. OrgID comes from the session.
// WritesDisabled is the bool the API process already captured. This
// function does not read the environment.
type GrantInput struct {
	OrgID             int64
	StoreID           string
	ListingRowID      string
	RowRevision       int64
	ClientOperationID string
	RequestHash       string
	OfferID           string
	CardID            string
	WritesDisabled    bool
	Now               time.Time
}

// GrantResult is the plaintext response. It is not logged.
type GrantResult struct {
	IntentID    string `json:"intentId"`
	State       string `json:"state"`
	ClientID    string `json:"clientId"`
	APIKey      string `json:"apiKey"`
	ExpiresAtMS int64  `json:"expiresAtMs"`
	TTLMS       int64  `json:"ttlMs"`
}

// ReportInput is the browser's report of one import attempt.
// HasTask is false when the body omitted taskId. HTTPStatus nil means
// the browser saw no status code.
type ReportInput struct {
	OrgID      int64
	IntentID   string
	TaskID     int64
	HasTask    bool
	HTTPStatus *int
}

// ReportResult is the intent after a successful report.
type ReportResult struct {
	IntentID string `json:"intentId"`
	State    string `json:"state"`
}

// ReserveFunc spends one GCRA grant slot. Nil refuses the grant.
type ReserveFunc func(ctx context.Context) error

// OpenFunc decrypts one store envelope. Nil refuses the grant.
type OpenFunc func(seal.Store) (seal.Secret, error)

// Grant inserts or replays the offer fence, commits submitting, and only
// then opens the store envelope. It does not enqueue listing.submit.
func Grant(ctx context.Context, pool *pgxpool.Pool, in GrantInput, reserve ReserveFunc, open OpenFunc) (GrantResult, error) {
	if pool == nil {
		return GrantResult{}, statusErr(503, "服务暂不可用", "internal")
	}
	if in.WritesDisabled {
		tx, err := tenant.BeginApp(ctx, pool.Begin, in.OrgID)
		if err != nil {
			return GrantResult{}, statusErr(503, "服务暂不可用", "internal")
		}
		_ = tx.Rollback(ctx)
		return GrantResult{}, statusErr(503, "Ozon 写入已停止", CodeWritesDisabled)
	}
	if reserve == nil || open == nil {
		return GrantResult{}, statusErr(503, "服务暂不可用", "internal")
	}
	if err := reserve(ctx); err != nil {
		if errors.Is(err, ErrGrantLimited) {
			return GrantResult{}, statusErr(429, "发放过于频繁", "rate_limited")
		}
		return GrantResult{}, statusErr(503, "服务暂不可用", "internal")
	}
	tx, err := tenant.BeginApp(ctx, pool.Begin, in.OrgID)
	if err != nil {
		return GrantResult{}, statusErr(503, "服务暂不可用", "internal")
	}
	defer tx.Rollback(ctx)
	var storePK int64
	err = tx.QueryRow(ctx, `
		SELECT id FROM public.organization_stores
		 WHERE org_id = $1 AND uuid = $2::uuid`, in.OrgID, in.StoreID).Scan(&storePK)
	if errors.Is(err, pgx.ErrNoRows) {
		return GrantResult{}, statusErr(404, "店铺不存在", "not_found")
	}
	if err != nil {
		return GrantResult{}, statusErr(503, "服务暂不可用", "internal")
	}
	_ = storePK
	revoked, err := offerRevoked(ctx, tx, in)
	if err != nil {
		return GrantResult{}, statusErr(503, "服务暂不可用", "internal")
	}
	if revoked {
		return GrantResult{}, statusErr(409, "这次发放已撤销", "grant_revoked")
	}
	id := uuid.NewString()
	var offer any
	if strings.TrimSpace(in.OfferID) != "" {
		offer = strings.TrimSpace(in.OfferID)
	}
	var inserted string
	err = tx.QueryRow(ctx, `
		INSERT INTO public.submission_intents (
			id, org_id, store_id, listing_row_id, row_revision, client_operation_id,
			request_hash, state, offer_id, card_id
		) VALUES (
			$1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, 'queued', $8, NULLIF($9, '')::uuid
		)
		ON CONFLICT ON CONSTRAINT submission_intents_client_op DO NOTHING
		RETURNING id::text`,
		id, in.OrgID, in.StoreID, in.ListingRowID, in.RowRevision, in.ClientOperationID,
		in.RequestHash, offer, in.CardID).Scan(&inserted)
	if errors.Is(err, pgx.ErrNoRows) {
		return GrantResult{}, replayGrant(ctx, tx, in)
	}
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return GrantResult{}, statusErr(409, "该货号已有未完成的提交", "submission_intents_offer_busy")
		}
		return GrantResult{}, statusErr(503, "服务暂不可用", "internal")
	}
	var grantedMS int64
	err = tx.QueryRow(ctx, `
		UPDATE public.submission_intents
		   SET state = 'submitting',
		       credential_granted_at = clock_timestamp(),
		       updated_at = clock_timestamp()
		 WHERE org_id = $1 AND id = $2::uuid AND state = 'queued'
		 RETURNING (extract(epoch FROM credential_granted_at) * 1000)::bigint`,
		in.OrgID, inserted).Scan(&grantedMS)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return GrantResult{}, statusErr(409, "该货号已有未完成的提交", "submission_intents_offer_busy")
		}
		return GrantResult{}, statusErr(503, "服务暂不可用", "internal")
	}
	tag, err := tx.Exec(ctx, `
		UPDATE public.listing_rows
		   SET submission_state = 'submitting', updated_at = clock_timestamp()
		 WHERE org_id = $1 AND id = $2::uuid AND revision = $3`,
		in.OrgID, in.ListingRowID, in.RowRevision)
	if err != nil {
		return GrantResult{}, statusErr(503, "服务暂不可用", "internal")
	}
	if tag.RowsAffected() != 1 {
		return GrantResult{}, statusErr(409, "行修订不一致", "conflict")
	}
	if err := tx.Commit(ctx); err != nil {
		return GrantResult{}, statusErr(503, "服务暂不可用", "internal")
	}
	secret, err := openGrantSecret(ctx, pool, in, open)
	if err != nil {
		return GrantResult{}, err
	}
	return GrantResult{
		IntentID: inserted, State: Submitting,
		ClientID: secret.ClientID, APIKey: secret.APIKey,
		ExpiresAtMS: grantedMS + GrantTTLMS, TTLMS: GrantTTLMS,
	}, nil
}

func offerRevoked(ctx context.Context, tx pgx.Tx, in GrantInput) (bool, error) {
	var offer any
	if strings.TrimSpace(in.OfferID) != "" {
		offer = strings.TrimSpace(in.OfferID)
	}
	var n int
	err := tx.QueryRow(ctx, `
		SELECT count(*) FROM public.submission_intents
		 WHERE org_id = $1 AND store_id = $2::uuid
		   AND revoked_at IS NOT NULL
		   AND (
		        offer_id IS NOT DISTINCT FROM $3::text
		        OR offer_id IS NULL
		        OR $3::text IS NULL
		   )`, in.OrgID, in.StoreID, offer).Scan(&n)
	return n > 0, err
}

func replayGrant(ctx context.Context, tx pgx.Tx, in GrantInput) error {
	var state string
	var revoked bool
	var granted *time.Time
	err := tx.QueryRow(ctx, `
		SELECT state, revoked_at IS NOT NULL, credential_granted_at
		  FROM public.submission_intents
		 WHERE org_id = $1 AND store_id = $2::uuid AND client_operation_id = $3`,
		in.OrgID, in.StoreID, in.ClientOperationID).Scan(&state, &revoked, &granted)
	if err != nil {
		return statusErr(503, "服务暂不可用", "internal")
	}
	if revoked {
		return statusErr(409, "这次发放已撤销", "grant_revoked")
	}
	if granted != nil && in.Now.After(granted.Add(time.Duration(GrantTTLMS)*time.Millisecond)) {
		return statusErr(409, "发放期限已过，不会再次发放密钥", "grant_expired")
	}
	switch state {
	case Queued, Submitting, Unknown, Accepted, Rejected, Cancelled:
		return statusErr(409, "该货号正在提交，不会再次发放密钥", "grant_in_flight")
	default:
		return statusErr(409, "该货号正在提交，不会再次发放密钥", "grant_in_flight")
	}
}

func openGrantSecret(ctx context.Context, pool *pgxpool.Pool, in GrantInput, open OpenFunc) (seal.Secret, error) {
	tx, err := tenant.BeginApp(ctx, pool.Begin, in.OrgID)
	if err != nil {
		return seal.Secret{}, statusErr(503, "店铺密钥不可用", "credential_unavailable")
	}
	defer tx.Rollback(ctx)
	var env seal.Store
	var clientID *string
	var expires *int64
	err = tx.QueryRow(ctx, `
		SELECT c.envelope_version, c.client_id, c.key_id, c.nonce, c.ciphertext,
		       c.wrapped_dek, c.dek_nonce, c.key_fingerprint, c.key_expires_at_ms
		  FROM public.store_seller_credentials c
		  JOIN public.organization_stores s ON s.id = c.store_id
		 WHERE c.org_id = $1 AND s.uuid = $2::uuid AND s.org_id = $1`,
		in.OrgID, in.StoreID).Scan(
		&env.Version, &clientID, &env.KeyID, &env.Nonce, &env.Ciphertext,
		&env.WrappedDEK, &env.DEKNonce, &env.Fingerprint, &expires)
	if err != nil {
		return seal.Secret{}, statusErr(503, "店铺密钥不可用", "credential_unavailable")
	}
	if expires != nil {
		now := in.Now
		if now.IsZero() {
			now = time.Now()
		}
		if *expires <= now.UnixMilli() {
			return seal.Secret{}, statusErr(503, "Seller 密钥已过期", "credential_expired")
		}
	}
	if clientID != nil {
		env.ClientID = *clientID
	}
	secret, err := open(env)
	if err != nil || secret.ClientID == "" || secret.APIKey == "" {
		return seal.Secret{}, statusErr(503, "店铺密钥不可用", "credential_unavailable")
	}
	return secret, nil
}

// Report settles a submitting or unknown attempt. A positive task id accepts;
// a definitive 4xx rejects. An identical classified receipt is a read-only
// replay. Conflicting terminal receipts cannot overwrite a confirmed result.
func Report(ctx context.Context, pool *pgxpool.Pool, in ReportInput) (ReportResult, error) {
	if pool == nil {
		return ReportResult{}, statusErr(503, "服务暂不可用", "internal")
	}
	reply := Reply{Sent: true}
	if in.HasTask && in.TaskID > 0 {
		reply.Status = 200
		reply.TaskID = in.TaskID
		reply.Body = `{"result":{"task_id":` + strconv.FormatInt(in.TaskID, 10) + `}}`
	} else if in.HTTPStatus == nil || *in.HTTPStatus == 0 {
		reply.Status = 0
	} else {
		reply.Status = *in.HTTPStatus
	}
	out := Classify(reply)
	switch out.IntentState {
	case Accepted, Rejected, Unknown:
	default:
		return ReportResult{}, statusErr(409, "这次报回不能改变提交状态", "conflict")
	}
	tx, err := tenant.BeginApp(ctx, pool.Begin, in.OrgID)
	if err != nil {
		return ReportResult{}, statusErr(503, "服务暂不可用", "internal")
	}
	defer tx.Rollback(ctx)
	var task *string
	if out.IntentState == Accepted && in.TaskID > 0 {
		text := strconv.FormatInt(in.TaskID, 10)
		task = &text
	}
	// Serialize reports for the same attempt before deciding whether to write.
	// In particular, a replay must not fire intent/listing revision triggers.
	var rowID, state, previousError string
	var previousTask *string
	var revision int64
	err = tx.QueryRow(ctx, `
		SELECT listing_row_id::text, row_revision, state, external_task_id,
		       COALESCE(last_error_code, '')
		  FROM public.submission_intents
		 WHERE org_id = $1 AND id = $2::uuid
		 FOR UPDATE`, in.OrgID, in.IntentID).Scan(&rowID, &revision, &state, &previousTask, &previousError)
	if errors.Is(err, pgx.ErrNoRows) {
		return ReportResult{}, statusErr(404, "提交意图不存在", "not_found")
	}
	if err != nil {
		return ReportResult{}, statusErr(503, "服务暂不可用", "internal")
	}
	sameTask := (task == nil && previousTask == nil) ||
		(task != nil && previousTask != nil && *task == *previousTask)
	if state == out.IntentState && sameTask && previousError == out.IntentError {
		if err := tx.Commit(ctx); err != nil {
			return ReportResult{}, statusErr(503, "服务暂不可用", "internal")
		}
		return ReportResult{IntentID: in.IntentID, State: state}, nil
	}
	if (state != Submitting && state != Unknown) ||
		(previousTask != nil && (task == nil || *previousTask != *task)) {
		return ReportResult{}, statusErr(409, "这次报回不能改变提交状态", "conflict")
	}
	_, err = tx.Exec(ctx, `
		UPDATE public.submission_intents
		   SET state = $3,
		       last_error_code = NULLIF($4, ''),
		       external_task_id = COALESCE($5, external_task_id),
		       reconcile_after = CASE
		           WHEN $3 = 'unknown' THEN clock_timestamp() + interval '30 seconds'
		           ELSE NULL
		       END,
		       updated_at = clock_timestamp()
		 WHERE org_id = $1 AND id = $2::uuid`,
		in.OrgID, in.IntentID, out.IntentState, out.IntentError, task)
	if err != nil {
		return ReportResult{}, statusErr(503, "服务暂不可用", "internal")
	}
	rowState := out.IntentState
	tag, err := tx.Exec(ctx, `
		UPDATE public.listing_rows
		   SET submission_state = $4, updated_at = clock_timestamp()
		 WHERE org_id = $1 AND id = $2::uuid AND revision = $3
		   AND $5::uuid = (
		       SELECT id FROM public.submission_intents
		        WHERE org_id = $1 AND listing_row_id = $2::uuid
		        ORDER BY row_revision DESC, created_at DESC, id DESC LIMIT 1
		   )`,
		in.OrgID, rowID, revision, rowState, in.IntentID)
	if err != nil {
		return ReportResult{}, statusErr(503, "服务暂不可用", "internal")
	}
	if tag.RowsAffected() != 1 {
		return ReportResult{}, statusErr(409, "这次报回不能改变提交状态", "conflict")
	}
	if err := tx.Commit(ctx); err != nil {
		return ReportResult{}, statusErr(503, "服务暂不可用", "internal")
	}
	return ReportResult{IntentID: in.IntentID, State: out.IntentState}, nil
}

// ParseGrantBody reads the grant JSON. A blank offer is stored as NULL
// and the offer fence rejects it.
func ParseGrantBody(raw []byte) (GrantInput, error) {
	var body struct {
		StoreID           string `json:"storeId"`
		ListingRowID      string `json:"listingRowId"`
		RowRevision       int64  `json:"rowRevision"`
		ClientOperationID string `json:"clientOperationId"`
		RequestHash       string `json:"requestHash"`
		OfferID           string `json:"offerId"`
		CardID            string `json:"cardId"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return GrantInput{}, statusErr(400, ErrBadRequest.Error(), "bad_request")
	}
	body.StoreID = strings.TrimSpace(body.StoreID)
	body.ListingRowID = strings.TrimSpace(body.ListingRowID)
	body.ClientOperationID = strings.TrimSpace(body.ClientOperationID)
	body.RequestHash = strings.TrimSpace(body.RequestHash)
	body.CardID = strings.TrimSpace(body.CardID)
	if _, err := uuid.Parse(body.StoreID); err != nil {
		return GrantInput{}, statusErr(400, "店铺编号无效", "bad_request")
	}
	if _, err := uuid.Parse(body.ListingRowID); err != nil {
		return GrantInput{}, statusErr(400, "行编号无效", "bad_request")
	}
	if body.CardID != "" {
		if _, err := uuid.Parse(body.CardID); err != nil {
			return GrantInput{}, statusErr(400, "卡片编号无效", "bad_request")
		}
	}
	if body.RowRevision < 1 {
		return GrantInput{}, statusErr(400, "行修订无效", "bad_request")
	}
	if body.ClientOperationID == "" || len(body.ClientOperationID) > 200 {
		return GrantInput{}, statusErr(400, "客户端操作号无效", "bad_request")
	}
	if body.RequestHash == "" || len(body.RequestHash) > 200 {
		return GrantInput{}, statusErr(400, "请求摘要无效", "bad_request")
	}
	if len(strings.TrimSpace(body.OfferID)) > 200 {
		return GrantInput{}, statusErr(400, "货号无效", "bad_request")
	}
	return GrantInput{
		StoreID: body.StoreID, ListingRowID: body.ListingRowID, RowRevision: body.RowRevision,
		ClientOperationID: body.ClientOperationID, RequestHash: body.RequestHash,
		OfferID: strings.TrimSpace(body.OfferID), CardID: body.CardID,
	}, nil
}

// ParseReportBody reads the report JSON. Omitting taskId and httpStatus
// is a lost connection.
func ParseReportBody(raw []byte) (ReportInput, error) {
	var body struct {
		IntentID   string `json:"intentId"`
		TaskID     *int64 `json:"taskId"`
		HTTPStatus *int   `json:"httpStatus"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return ReportInput{}, statusErr(400, ErrBadRequest.Error(), "bad_request")
	}
	body.IntentID = strings.TrimSpace(body.IntentID)
	if _, err := uuid.Parse(body.IntentID); err != nil {
		return ReportInput{}, statusErr(400, "提交意图编号无效", "bad_request")
	}
	out := ReportInput{IntentID: body.IntentID, HTTPStatus: body.HTTPStatus}
	if body.TaskID != nil {
		out.HasTask = true
		out.TaskID = *body.TaskID
	}
	return out, nil
}
