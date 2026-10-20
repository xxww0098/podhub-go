package readhttp

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/listing/read/domain"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

const infoListPath = "/v3/product/info/list"

func (h Host) runProbe(w http.ResponseWriter, r *http.Request, org, user int64, id, offer, storeID string) {
	if h.Pool == nil {
		writeErr(w, http.StatusInternalServerError, "服务暂不可用", "internal")
		return
	}
	tx, err := tenant.BeginApp(r.Context(), h.Pool.Begin, org)
	if err != nil {
		writeDB(w, err)
		return
	}
	var (
		passes      int32
		observation string
		rowID       string
		revision    int64
		claimed     bool
	)
	err = tx.QueryRow(r.Context(), `
		SELECT listing_row_id::text, row_revision,
		       COALESCE((reconciliation_outcome->'probe'->>'passes')::int, 0),
		       COALESCE(reconciliation_outcome->'probe'->>'observation', '')
		FROM submission_intents
		WHERE org_id = $1 AND id = $2::uuid AND state = 'unknown'
		  AND last_error_code = 'OZON_RECONCILE_STILL_UNKNOWN'
		  AND btrim(COALESCE(offer_id, '')) <> ''
		  AND (reconcile_claim_until IS NULL OR reconcile_claim_until <= clock_timestamp())
		FOR UPDATE`, org, id).Scan(&rowID, &revision, &passes, &observation)
	if errors.Is(err, pgx.ErrNoRows) {
		_ = tx.Rollback(r.Context())
		h.probeRefused(w, r, org, user, id)
		return
	}
	if err != nil {
		_ = tx.Rollback(r.Context())
		writeDB(w, err)
		return
	}
	tag, err := tx.Exec(r.Context(), `
		UPDATE submission_intents
		SET reconcile_claim_until = clock_timestamp() + interval '2 minutes',
		    updated_at = clock_timestamp()
		WHERE org_id = $1 AND id = $2::uuid AND state = 'unknown'
		  AND last_error_code = 'OZON_RECONCILE_STILL_UNKNOWN'
		  AND (reconcile_claim_until IS NULL OR reconcile_claim_until <= clock_timestamp())`, org, id)
	if err != nil {
		_ = tx.Rollback(r.Context())
		writeDB(w, err)
		return
	}
	claimed = tag.RowsAffected() == 1
	if !claimed {
		_ = tx.Rollback(r.Context())
		h.probeRefused(w, r, org, user, id)
		return
	}
	clientID, apiKey, opened := h.openStoreKey(r, tx, org, storeID)
	if err := tx.Commit(r.Context()); err != nil {
		writeDB(w, err)
		return
	}
	sight, productID, sku := sightUnreadable, int64(0), int64(0)
	if opened && h.Seller != nil {
		body, _ := json.Marshal(struct {
			OfferID []string `json:"offer_id"`
		}{OfferID: []string{offer}})
		status, resp, callErr := h.Seller(r.Context(), infoListPath, body, clientID, apiKey)
		if callErr == nil && status >= 200 && status < 300 {
			sight, productID, sku = readInfoList(resp, offer)
		}
	}
	action := manualProbe(passes, observation, sight, productID, sku)
	err = h.withOrg(r.Context(), org, func(tx pgx.Tx) error {
		return applyManualProbe(r, tx, org, id, rowID, revision, action)
	})
	if !h.writeTx(w, err) {
		return
	}
	var view domain.IntentView
	err = h.withOrg(r.Context(), org, func(tx pgx.Tx) error {
		item, err := oneIntent(r.Context(), tx, org, user, id)
		if err != nil {
			return err
		}
		view = domain.ProjectIntent(item.src)
		return nil
	})
	if !h.writeTx(w, err) {
		return
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data domain.IntentView `json:"data"`
	}{Data: view})
}

func (h Host) probeRefused(w http.ResponseWriter, r *http.Request, org, user int64, id string) {
	var state, last, offer string
	var claim *time.Time
	err := h.withOrg(r.Context(), org, func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			SELECT state, COALESCE(last_error_code, ''), COALESCE(offer_id, ''), reconcile_claim_until
			FROM submission_intents WHERE org_id = $1 AND id = $2::uuid`, org, id).
			Scan(&state, &last, &offer, &claim)
		if errors.Is(err, pgx.ErrNoRows) {
			return halt{http.StatusConflict, "只有自动核对停止后才能按货号再核对，本次不会重发", "conflict"}
		}
		return err
	})
	if !h.writeTx(w, err) {
		return
	}
	msg, conflict := domain.ProbeRefusal(state, last, offer, claim, h.Now())
	if !conflict {
		msg = "只有自动核对停止后才能按货号再核对，本次不会重发"
	}
	writeErr(w, http.StatusConflict, msg, "conflict")
	_ = user
}

func (h Host) openStoreKey(r *http.Request, tx pgx.Tx, org int64, storeID string) (string, string, bool) {
	var env seal.Store
	var clientID *string
	var expires *int64
	err := tx.QueryRow(r.Context(), `
		SELECT c.envelope_version, c.client_id, c.key_id, c.nonce, c.ciphertext,
		       c.wrapped_dek, c.dek_nonce, c.key_fingerprint, c.key_expires_at_ms
		  FROM store_seller_credentials c
		  JOIN organization_stores s ON s.id = c.store_id
		 WHERE c.org_id = $1 AND s.uuid = $2::uuid`, org, storeID).Scan(
		&env.Version, &clientID, &env.KeyID, &env.Nonce, &env.Ciphertext,
		&env.WrappedDEK, &env.DEKNonce, &env.Fingerprint, &expires)
	if err != nil {
		return "", "", false
	}
	if expires != nil && *expires <= h.clock().UnixMilli() {
		return "", "", false
	}
	if clientID != nil {
		env.ClientID = *clientID
	}
	secret, err := h.Seals.OpenStore(env)
	if err != nil || secret.ClientID == "" || secret.APIKey == "" {
		return "", "", false
	}
	return secret.ClientID, secret.APIKey, true
}

const (
	sightAbsent int = iota
	sightUnreadable
	sightFound
)

func readInfoList(raw []byte, offer string) (sight int, productID, sku int64) {
	var parsed struct {
		Items []struct {
			ID      int64  `json:"id"`
			OfferID string `json:"offer_id"`
			Sources []struct {
				SKU int64 `json:"sku"`
			} `json:"sources"`
		} `json:"items"`
	}
	if json.Unmarshal(raw, &parsed) != nil {
		return sightUnreadable, 0, 0
	}
	for _, item := range parsed.Items {
		if item.ID <= 0 || strings.TrimSpace(item.OfferID) == "" || item.OfferID != offer {
			continue
		}
		var sku int64
		for _, source := range item.Sources {
			if source.SKU > 0 {
				sku = source.SKU
				break
			}
		}
		return sightFound, item.ID, sku
	}
	return sightAbsent, 0, 0
}

type probeWrite struct {
	kind, observation string
	productID, sku    int64
	passes            int32
}

func manualProbe(passes int32, observation string, sight int, productID, sku int64) probeWrite {
	switch sight {
	case sightFound:
		if productID > 0 {
			return probeWrite{kind: "accept", productID: productID, sku: sku}
		}
		return lingerProbe(passes, "unreadable")
	case sightAbsent:
		if observation == "absent" {
			return probeWrite{kind: "release", passes: passes + 1}
		}
		return lingerProbe(passes, "absent")
	default:
		return lingerProbe(passes, "unreadable")
	}
}

func lingerProbe(passes int32, observation string) probeWrite {
	next := passes + 1
	if next >= 8 {
		return probeWrite{kind: "give_up", passes: next, observation: observation}
	}
	return probeWrite{kind: "retry", passes: next, observation: observation}
}

func applyManualProbe(r *http.Request, tx pgx.Tx, org int64, id, rowID string, revision int64, action probeWrite) error {
	switch action.kind {
	case "accept":
		tag, err := tx.Exec(r.Context(), stampAcceptSQL, org, id, action.productID, action.sku)
		if err != nil {
			return err
		}
		if tag.RowsAffected() > 0 {
			_, err = tx.Exec(r.Context(), setRowStateSQL, org, rowID, revision, "accepted")
		}
		return err
	case "release":
		tag, err := tx.Exec(r.Context(), stampReleaseSQL, org, id, time.Now().UTC().UnixMilli(), action.passes)
		if err != nil {
			return err
		}
		if tag.RowsAffected() > 0 {
			_, err = tx.Exec(r.Context(), setRowStateSQL, org, rowID, revision, "none")
		}
		return err
	default:
		_, err := tx.Exec(r.Context(), stampRetrySQL, org, id, action.passes, action.observation, domain.ReconcileStillUnknown, int64(0))
		return err
	}
}

const stampAcceptSQL = `
UPDATE submission_intents
SET state = 'accepted',
    last_error_code = NULL,
    reconcile_after = NULL,
    reconcile_claim_until = NULL,
    reconciliation_outcome = jsonb_set(
      COALESCE(reconciliation_outcome, '{}'::jsonb) - 'probe',
      '{found}',
      jsonb_build_object('productId', $3::bigint, 'sku', $4::bigint),
      true),
    updated_at = clock_timestamp()
WHERE org_id = $1 AND id = $2::uuid AND state = 'unknown'`

const stampReleaseSQL = `
UPDATE submission_intents
SET state = 'superseded',
    last_error_code = NULL,
    reconcile_after = NULL,
    reconcile_claim_until = NULL,
    reconciliation_outcome = jsonb_set(
      COALESCE(reconciliation_outcome, '{}'::jsonb) - 'probe',
      '{probeReleased}',
      jsonb_build_object('atMs', $3::bigint, 'passes', $4::int),
      true),
    updated_at = clock_timestamp()
WHERE org_id = $1 AND id = $2::uuid AND state = 'unknown'`

const stampRetrySQL = `
UPDATE submission_intents
SET last_error_code = CASE WHEN $5 = '' THEN last_error_code ELSE $5 END,
    reconcile_after = CASE WHEN $6::bigint <= 0 THEN NULL
         ELSE clock_timestamp() + ($6::text || ' seconds')::interval END,
    reconcile_claim_until = NULL,
    reconciliation_outcome = jsonb_set(
      COALESCE(reconciliation_outcome, '{}'::jsonb),
      '{probe}',
      jsonb_build_object('passes', $3::int, 'observation', $4::text),
      true),
    updated_at = clock_timestamp()
WHERE org_id = $1 AND id = $2::uuid AND state = 'unknown'`

const setRowStateSQL = `
UPDATE listing_rows
   SET submission_state = $4, updated_at = clock_timestamp()
 WHERE org_id = $1 AND id = $2::uuid AND revision = $3`
