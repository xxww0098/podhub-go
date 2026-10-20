package scans

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/listing/submit"
	"github.com/xxww0098/podhub-go/internal/platform/httpx"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	"github.com/xxww0098/podhub-go/internal/seller"
	sellerdomain "github.com/xxww0098/podhub-go/internal/seller/domain"
)

// probeAccepted reads due accepted intents. A hit clears reconcile_after and
// leaves state accepted. An absence or an unreadable read only backs off.
// Release and supersede are not applied. Header names Client-Id and Api-Key
// are the public Seller names; the Rust header source was not opened (无法对照).
// A non-loopback base URL is not dialed.
func probeAccepted(ctx context.Context, pool *pgxpool.Pool, eg *seller.Egress, ring seal.Ring, limit int) (bool, error) {
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
		sights := readAccepted(ctx, pool, eg, ring, k.org, k.store, batch)
		if err := applyAccepted(ctx, pool, k.org, batch, sights); err != nil {
			return true, err
		}
	}
	return true, nil
}

type acceptedRow struct {
	ID          string
	OrgID       int64
	StoreID     string
	OfferID     string
	Passes      int32
	Observation string
}

type acceptedSight struct {
	sight submit.Sight
	found submit.Found
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
			          COALESCE(i.reconciliation_outcome->'probe'->>'observation', '')`, limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var row acceptedRow
			if err := rows.Scan(&row.ID, &row.OrgID, &row.StoreID, &row.OfferID, &row.Passes, &row.Observation); err != nil {
				return err
			}
			claimed = append(claimed, row)
		}
		return rows.Err()
	})
	return claimed, err
}

func readAccepted(ctx context.Context, pool *pgxpool.Pool, eg *seller.Egress, ring seal.Ring, orgID int64, storeID string, rows []acceptedRow) map[string]acceptedSight {
	out := map[string]acceptedSight{}
	mark := func(sight submit.Sight) {
		for _, row := range rows {
			out[row.ID] = acceptedSight{sight: sight}
		}
	}
	base := ""
	if eg != nil {
		base = eg.Base()
	}
	if eg == nil || base == sellerdomain.ProductionBaseURL {
		mark(submit.SightUnreadable)
		return out
	}
	secret, ok := openCredential(ctx, pool, ring, orgID, storeID)
	if !ok {
		mark(submit.SightUnreadable)
		return out
	}
	offers := make([]string, 0, len(rows))
	for _, row := range rows {
		offers = append(offers, row.OfferID)
	}
	body, err := json.Marshal(map[string]any{"offer_id": offers})
	if err != nil {
		mark(submit.SightUnreadable)
		return out
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	status, raw, err := postInfoList(ctx, base, secret.ClientID, secret.APIKey, body)
	found, parsed := parseAccepted(status, raw, err)
	if !parsed {
		mark(submit.SightUnreadable)
		return out
	}
	for _, row := range rows {
		if product, ok := found[row.OfferID]; ok {
			out[row.ID] = acceptedSight{sight: submit.SightFound, found: product}
			continue
		}
		out[row.ID] = acceptedSight{sight: submit.SightAbsent}
	}
	return out
}

// infoListClient does not follow redirects and does not use a proxy.
// The 10s limit sits on the readAccepted context. This client has no Timeout.
var infoListClient = httpx.OzonClient()

// postInfoList posts one info/list read. Redirects are not followed and
// HTTP_PROXY is not consulted. A non-loopback base fails in the dialer.
func postInfoList(ctx context.Context, base, clientID, apiKey string, body []byte) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(base, "/")+"/v3/product/info/list", strings.NewReader(string(body)))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Client-Id", clientID)
	req.Header.Set("Api-Key", apiKey)
	resp, err := infoListClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	raw, err := httpx.ReadLimit(resp.Body, 1<<20)
	return resp.StatusCode, raw, err
}

func openCredential(ctx context.Context, pool *pgxpool.Pool, ring seal.Ring, orgID int64, storeID string) (seal.Secret, bool) {
	var env seal.Store
	var clientID *string
	err := asWorker(ctx, pool, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT c.envelope_version, c.client_id, c.key_id, c.nonce, c.ciphertext,
			       c.wrapped_dek, c.dek_nonce, c.key_fingerprint
			  FROM store_seller_credentials c
			  JOIN organization_stores s ON s.id = c.store_id
			 WHERE c.org_id = $1 AND s.uuid = $2::uuid`, orgID, storeID).Scan(
			&env.Version, &clientID, &env.KeyID, &env.Nonce, &env.Ciphertext,
			&env.WrappedDEK, &env.DEKNonce, &env.Fingerprint)
	})
	if err != nil {
		return seal.Secret{}, false
	}
	if clientID != nil {
		env.ClientID = *clientID
	}
	secret, err := ring.OpenStore(env)
	if err != nil || secret.ClientID == "" || secret.APIKey == "" {
		return seal.Secret{}, false
	}
	return secret, true
}

func parseAccepted(status int, body []byte, err error) (map[string]submit.Found, bool) {
	if err != nil || status < 200 || status >= 300 {
		return nil, false
	}
	var parsed struct {
		Items []struct {
			ID      int64  `json:"id"`
			OfferID string `json:"offer_id"`
			Sources []struct {
				SKU int64 `json:"sku"`
			} `json:"sources"`
		} `json:"items"`
	}
	if json.Unmarshal(body, &parsed) != nil {
		return nil, false
	}
	out := map[string]submit.Found{}
	for _, item := range parsed.Items {
		if item.ID <= 0 || item.OfferID == "" {
			continue
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
			sight := sights[row.ID]
			action := submit.DecideProbe(submit.ProbeMemory{Passes: row.Passes, Observation: row.Observation}, sight.sight, sight.found)
			if action.Kind == "accept" {
				if _, err := tx.Exec(ctx, `
					UPDATE submission_intents
					   SET reconcile_after = NULL,
					       reconcile_claim_until = NULL,
					       updated_at = clock_timestamp()
					 WHERE org_id = $1 AND id = $2::uuid AND state = 'accepted'`, orgID, row.ID); err != nil {
					return err
				}
				continue
			}
			wait := action.BackoffSecs
			if wait <= 0 {
				wait = 900
			}
			if _, err := tx.Exec(ctx, `
				UPDATE submission_intents
				   SET reconcile_after = clock_timestamp() + ($3::bigint * interval '1 second'),
				       reconcile_claim_until = NULL,
				       reconciliation_outcome = jsonb_set(
				           COALESCE(reconciliation_outcome, '{}'::jsonb),
				           '{probe}',
				           jsonb_build_object('passes', $4::int, 'observation', $5::text),
				           true),
				       updated_at = clock_timestamp()
				 WHERE org_id = $1 AND id = $2::uuid AND state = 'accepted'`,
				orgID, row.ID, wait, action.Passes, action.Observation); err != nil {
				return err
			}
		}
		return nil
	})
}
