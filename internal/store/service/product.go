package service

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// ProductDirectory is the repo side of the products mirror. Reads are scoped by
// the roster the service already loaded, so visibility is decided once and never
// re-derived per query.
type ProductDirectory interface {
	ListProducts(ctx context.Context, orgID int64, scope []domain.Row, query domain.ProductQuery) (domain.ProductPage, *contract.APIError)
	LoadOverview(ctx context.Context, orgID int64, rows []domain.Row, nowMS int64, syncDisabled bool) (domain.ProductOverview, *contract.APIError)
	ProductRead(ctx context.Context, clientID, apiKey string, offerIDs []string) (status int, body []byte, err error)
}

// WithProducts binds the products mirror and the captured sync kill switch.
func (s Service) WithProducts(dir ProductDirectory, syncDisabled bool) Service {
	s.products = dir
	s.syncDisabled = syncDisabled
	return s
}

// SyncDisabled is OZON_PRODUCT_SYNC_DISABLED as captured at assembly. The
// read-side switch still lets stores render; it only stops scheduling and
// verify from leaving.
func (s Service) SyncDisabled() bool { return s.syncDisabled }

// Products is GET /api/workspaces/products.
func (s Service) Products(ctx context.Context, orgID, userID int64, storeID, status, q, cursor string, includeGone bool, limit *int64) (domain.ProductPage, *contract.APIError) {
	if s.products == nil || s.roster == nil {
		return domain.ProductPage{}, contract.Internal()
	}
	query, api := domain.NormalizeProductQuery(status, q, cursor, includeGone, limit)
	if api != nil {
		return domain.ProductPage{}, api
	}
	actor, api := s.roster.LoadActor(ctx, userID, orgID)
	if api != nil {
		return domain.ProductPage{}, api
	}
	scope, api := s.visibleScope(ctx, orgID, actor, storeID)
	if api != nil {
		return domain.ProductPage{}, api
	}
	return s.products.ListProducts(ctx, orgID, scope, query)
}

// ProductsOverview is GET /api/workspaces/products/overview.
func (s Service) ProductsOverview(ctx context.Context, orgID, userID int64) (domain.ProductOverview, *contract.APIError) {
	if s.products == nil || s.roster == nil {
		return domain.ProductOverview{}, contract.Internal()
	}
	actor, api := s.roster.LoadActor(ctx, userID, orgID)
	if api != nil {
		return domain.ProductOverview{}, api
	}
	roster, api := s.roster.LoadRoster(ctx, orgID, actor)
	if api != nil {
		return domain.ProductOverview{}, api
	}
	return s.products.LoadOverview(ctx, orgID, roster.Stores, domain.NowMS(), s.SyncDisabled())
}

// SyncNow is POST /api/workspaces/stores/{uuid}/products/sync. A press queues a
// walk or attaches to the one in flight; either way it is audited, and the
// answer is 202 with the generation the page already reports.
func (s Service) SyncNow(ctx context.Context, orgID, userID int64, uuid string) (domain.SyncPress, *contract.APIError) {
	if s.roster == nil {
		return domain.SyncPress{}, contract.Internal()
	}
	normalized, ok := domain.NormalizeStoreUUID(uuid)
	if !ok {
		return domain.SyncPress{}, contract.NotFound(contract.MsgProductStoreMiss)
	}
	actor, api := s.roster.LoadActor(ctx, userID, orgID)
	if api != nil {
		return domain.SyncPress{}, api
	}
	if _, api := s.visibleScope(ctx, orgID, actor, normalized); api != nil {
		return domain.SyncPress{}, api
	}
	var press domain.SyncPress
	api = s.roster.WriteTx(ctx, orgID, userID, contract.MsgWritesStores, func(ctx context.Context, tx domain.RosterTx) error {
		written, err := tx.SyncNow(ctx, orgID, normalized, domain.NowMS(), s.SyncDisabled())
		if err != nil {
			return err
		}
		press = written
		return tx.Record(ctx, domain.AuditRow{
			Module:     moduleProducts,
			EntityType: entityProduct,
			EntityID:   normalized,
			Method:     "POST",
			Path:       "/api/workspaces/stores/{uuid}/products/sync",
			Action:     "product_sync_now",
			Message: map[string]any{
				"uuid":                      normalized,
				"generation":                written.Generation,
				"attached":                  written.Attached,
				"manual_next_allowed_at_ms": written.ManualNextAllowedAtMS,
			},
		})
	})
	if api != nil {
		return domain.SyncPress{}, api
	}
	return press, nil
}

// Verify is POST /api/workspaces/stores/{uuid}/products/verify — the only page
// path allowed to spend a Seller read.
//
// Phase one claims (and answers from the mirror when the same batch was claimed
// inside 60 s). The Seller call holds no transaction. Phase two lands the answer
// and re-reads the rows.
func (s Service) Verify(ctx context.Context, orgID, userID int64, uuid string, offerIDs []string) ([]domain.Product, *contract.APIError) {
	if s.roster == nil || s.credential == nil {
		return nil, contract.Internal()
	}
	normalized, ok := domain.NormalizeStoreUUID(uuid)
	if !ok {
		return nil, contract.NotFound(contract.MsgProductStoreMiss)
	}
	ids, api := domain.NormalizeOfferIDs(offerIDs)
	if api != nil {
		return nil, api
	}
	actor, api := s.roster.LoadActor(ctx, userID, orgID)
	if api != nil {
		return nil, api
	}
	if _, api := s.visibleScope(ctx, orgID, actor, normalized); api != nil {
		return nil, api
	}
	if s.SyncDisabled() {
		return nil, contract.Cooldown(contract.MsgSyncDisabled)
	}
	nowMS := domain.NowMS()
	digest := domain.VerifyDigest(ids)
	var claim domain.VerifyClaim
	api = s.roster.WriteTx(ctx, orgID, userID, contract.MsgWritesStores, func(ctx context.Context, tx domain.RosterTx) error {
		written, err := tx.ClaimVerify(ctx, orgID, normalized, digest, nowMS, s.SyncDisabled())
		if err != nil {
			return err
		}
		claim = written
		if !written.Won {
			// The deduped path answered from the mirror; the audit says so.
			return tx.Record(ctx, domain.AuditRow{
				Module:     moduleProducts,
				EntityType: entityProduct,
				EntityID:   normalized,
				Method:     "POST",
				Path:       "/api/workspaces/stores/{uuid}/products/verify",
				Action:     "product_verify",
				Message:    map[string]any{"offer_ids": len(ids), "deduped": true},
			})
		}
		return nil
	})
	if api != nil {
		return nil, api
	}
	if !claim.Won {
		if claim.Rows == nil {
			return []domain.Product{}, nil
		}
		return claim.Rows, nil
	}
	opened, api := s.credential.OpenCurrentCredential(ctx, orgID, normalized)
	if api != nil {
		s.releaseVerify(ctx, orgID, userID, normalized, digest, nowMS)
		return nil, api
	}
	status, body, callErr := s.products.ProductRead(ctx, opened.ClientID, opened.APIKey, ids)
	if callErr != nil {
		s.releaseVerify(ctx, orgID, userID, normalized, digest, nowMS)
		return nil, contract.Unreachable(contract.MsgVerifyUpstream)
	}
	items, api := decodeProductItems(status, body)
	if api != nil {
		s.recordIncident(ctx, orgID, userID, normalized, opened.ClientID, status, nowMS)
		s.releaseVerify(ctx, orgID, userID, normalized, digest, nowMS)
		return nil, api
	}
	var rows []domain.Product
	api = s.roster.WriteTx(ctx, orgID, userID, contract.MsgWritesStores, func(ctx context.Context, tx domain.RosterTx) error {
		if err := tx.UpsertProducts(ctx, orgID, claim.StorePK, normalized, items, nowMS); err != nil {
			return err
		}
		saved, err := tx.MirrorProducts(ctx, orgID, normalized, ids)
		if err != nil {
			return err
		}
		rows = saved
		return tx.Record(ctx, domain.AuditRow{
			Module:     moduleProducts,
			EntityType: entityProduct,
			EntityID:   normalized,
			Method:     "POST",
			Path:       "/api/workspaces/stores/{uuid}/products/verify",
			Action:     "product_verify",
			Message:    map[string]any{"offer_ids": len(ids), "deduped": false},
		})
	})
	if api != nil {
		return nil, api
	}
	if rows == nil {
		rows = []domain.Product{}
	}
	return rows, nil
}

// visibleScope is the roster filtered to the stores the caller may see. A
// `storeId` naming an invisible store answers "no such store": existence never
// leaks through the difference between 403 and 404.
func (s Service) visibleScope(ctx context.Context, orgID int64, actor domain.Actor, storeID string) ([]domain.Row, *contract.APIError) {
	roster, api := s.roster.LoadRoster(ctx, orgID, actor)
	if api != nil {
		return nil, api
	}
	if storeID == "" {
		return roster.Stores, nil
	}
	normalized, ok := domain.NormalizeStoreUUID(storeID)
	if !ok {
		return nil, contract.NotFound(contract.MsgProductStoreMiss)
	}
	for _, row := range roster.Stores {
		if row.UUID == normalized {
			return []domain.Row{row}, nil
		}
	}
	return nil, contract.NotFound(contract.MsgProductStoreMiss)
}

// releaseVerify undoes this request's dedup stamp in its own transaction. The
// audit row is a fact too: the seller read was refunded, not completed.
func (s Service) releaseVerify(ctx context.Context, orgID, userID int64, uuid, digest string, nowMS int64) {
	_ = s.roster.WriteTx(ctx, orgID, userID, contract.MsgWritesStores, func(ctx context.Context, tx domain.RosterTx) error {
		tx.ReleaseVerify(ctx, orgID, uuid, digest, nowMS)
		return tx.Record(ctx, domain.AuditRow{
			Module:     moduleProducts,
			EntityType: entityProduct,
			EntityID:   uuid,
			Method:     "POST",
			Path:       "/api/workspaces/stores/{uuid}/products/verify",
			Action:     "product_verify_released",
			Message:    map[string]any{"uuid": uuid},
		})
	})
}

// recordIncident writes one pressure signal for a 429/5xx. Best effort: the
// seller answer is already refused, and the ledger must not mask it.
func (s Service) recordIncident(ctx context.Context, orgID, userID int64, uuid, clientID string, status int, nowMS int64) {
	if status != 429 && status < 500 {
		return
	}
	_ = s.roster.WriteTx(ctx, orgID, userID, contract.MsgWritesStores, func(ctx context.Context, tx domain.RosterTx) error {
		tx.RecordProductIncident(ctx, orgID, uuid, clientID, status, nowMS)
		return tx.Record(ctx, domain.AuditRow{
			Module:     moduleProducts,
			EntityType: entityProduct,
			EntityID:   uuid,
			Method:     "POST",
			Path:       "/api/workspaces/stores/{uuid}/products/verify",
			Action:     "product_verify_pressure",
			Message:    map[string]any{"uuid": uuid, "status": status},
		})
	})
}

// decodeProductItems reads POST /v3/product/info/list's answer. A non-2xx is
// the Seller's refusal, translated; a malformed 2xx is a gateway fault.
func decodeProductItems(status int, body []byte) ([]domain.SellerProduct, *contract.APIError) {
	switch {
	case status == 429:
		return nil, contract.RateLimited(contract.MsgVerifyThrottled)
	case status >= 500 || status == 0:
		return nil, contract.Unreachable(contract.MsgVerifyUpstream)
	case status >= 400:
		reason := domain.OzonReason(body)
		if reason == "" {
			reason = contract.MsgVerifyUpstream
		}
		return nil, contract.Validation(reason)
	}
	var answer struct {
		Items []domain.SellerProduct `json:"items"`
	}
	if err := json.Unmarshal(body, &answer); err != nil {
		slog.Warn("product verify body is not JSON", "err", err.Error())
		return nil, contract.Unreachable(contract.MsgVerifyGateway)
	}
	return answer.Items, nil
}

// ThumbnailSource reads the stored image for one product. The caller has
// already proved the store is visible; a missing row is "no such product".
func (s Service) ThumbnailSource(ctx context.Context, orgID int64, uuid string, productID int64) (string, *contract.APIError) {
	if s.thumbs == nil {
		return "", contract.Internal()
	}
	return s.thumbs.ThumbnailSource(ctx, orgID, uuid, productID)
}

// WithThumbnails binds the image source the thumbnail route proxies from.
func (s Service) WithThumbnails(source ThumbnailSource) Service {
	s.thumbs = source
	return s
}

// ThumbnailSource reads one product's stored image URL.
type ThumbnailSource interface {
	ThumbnailSource(ctx context.Context, orgID int64, uuid string, productID int64) (string, *contract.APIError)
}
