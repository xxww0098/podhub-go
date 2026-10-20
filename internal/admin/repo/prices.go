package adminrepo

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

func scanPrice(row pgx.Row) (domain.PriceRow, error) {
	var p domain.PriceRow
	err := row.Scan(&p.Model, &p.BillingMode, &p.Input, &p.Cached, &p.Output, &p.Reasoning, &p.PerRequest, &p.Max, &p.Effective)
	return p, err
}

const priceSelect = `
SELECT model, billing_mode,
    input_microfen_per_million, cached_input_microfen_per_million,
    output_microfen_per_million, reasoning_microfen_per_million,
    per_request_microfen, max_request_microfen, effective_from
FROM ai_price_schedules
WHERE effective_from <= clock_timestamp()
ORDER BY model`

// CurrentPrices lists prices already in effect.
func (s *Store) CurrentPrices(ctx context.Context) ([]domain.PriceRow, *contract.Fault) {
	rows, err := s.pool.Query(ctx, priceSelect)
	if err != nil {
		return nil, dbFault(err)
	}
	defer rows.Close()
	var out []domain.PriceRow
	for rows.Next() {
		p, err := scanPrice(rows)
		if err != nil {
			return nil, dbFault(err)
		}
		out = append(out, p)
	}
	if out == nil {
		out = []domain.PriceRow{}
	}
	return out, nil
}

// PublishPrice upserts one model, audits after commit, then lists current prices.
func (s *Store) PublishPrice(ctx context.Context, actor domain.Actor, model string, price domain.Price) ([]domain.PriceRow, *contract.Fault) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, dbFault(err)
	}
	defer tx.Rollback(ctx)
	defer endLease(tx)
	var id int64
	err = tx.QueryRow(ctx, `
INSERT INTO ai_price_schedules
    (model, billing_mode,
     input_microfen_per_million, cached_input_microfen_per_million,
     output_microfen_per_million, reasoning_microfen_per_million,
     per_request_microfen, max_request_microfen,
     effective_from, created_by_user_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp(), $9)
ON CONFLICT (model) DO UPDATE SET
    billing_mode = EXCLUDED.billing_mode,
    input_microfen_per_million = EXCLUDED.input_microfen_per_million,
    cached_input_microfen_per_million = EXCLUDED.cached_input_microfen_per_million,
    output_microfen_per_million = EXCLUDED.output_microfen_per_million,
    reasoning_microfen_per_million = EXCLUDED.reasoning_microfen_per_million,
    per_request_microfen = EXCLUDED.per_request_microfen,
    max_request_microfen = EXCLUDED.max_request_microfen,
    effective_from = clock_timestamp(),
    created_by_user_id = EXCLUDED.created_by_user_id
RETURNING id`, model, price.BillingMode, price.Input, price.Cached, price.Output, price.Reasoning, price.PerRequest, price.MaxRequest, actor.ID).Scan(&id)
	if err != nil {
		return nil, dbFault(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, dbFault(err)
	}
	msg := jsonText(struct {
		Summary     string `json:"summary"`
		BillingMode string `json:"billing_mode"`
	}{fmt.Sprintf("发布模型「%s」价格（%s）", model, price.BillingMode), price.BillingMode})
	if err := s.auditAfter(ctx, auditRow{
		OrgID: orgFloor(actor.OrgID), UserID: actor.ID, Module: "ai", EntityType: "ai_price_schedules",
		EntityID: model, Method: "PUT", Path: "/api/admin/ai/prices", Action: "ai_price_published", Message: msg,
	}); err != nil {
		return nil, dbFault(err)
	}
	return s.CurrentPrices(ctx)
}

// UnpublishPrice deletes one model after the caller has checked the default OCR model.
func (s *Store) UnpublishPrice(ctx context.Context, actor domain.Actor, model string) (bool, []domain.PriceRow, *contract.Fault) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM ai_price_schedules WHERE model = $1`, model)
	if err != nil {
		return false, nil, dbFault(err)
	}
	if tag.RowsAffected() == 0 {
		return false, nil, nil
	}
	msg := jsonText(struct {
		Summary string `json:"summary"`
	}{fmt.Sprintf("下架模型「%s」价格", model)})
	if err := s.auditAfter(ctx, auditRow{
		OrgID: orgFloor(actor.OrgID), UserID: actor.ID, Module: "ai", EntityType: "ai_price_schedules",
		EntityID: model, Method: "DELETE", Path: "/api/admin/ai/prices", Action: "ai_price_unpublished", Message: msg,
	}); err != nil {
		return true, nil, dbFault(err)
	}
	rows, fault := s.CurrentPrices(ctx)
	return true, rows, fault
}

// LoadConfig reads the singleton ciphertext. Found is false when the table is empty.
func (s *Store) LoadConfig(ctx context.Context) (domain.ConfigBlob, *contract.Fault) {
	var blob domain.ConfigBlob
	err := s.pool.QueryRow(ctx, `
SELECT revision, nonce, ciphertext
FROM public.platform_integration_config
WHERE singleton = true`).Scan(&blob.Revision, &blob.Nonce, &blob.Ciphertext)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ConfigBlob{}, nil
		}
		return domain.ConfigBlob{}, dbFault(err)
	}
	blob.Found = true
	return blob, nil
}

// RewriteSnapshot replaces a snake_case ciphertext with the camelCase
// sealing of the same snapshot. The revision is the fence and is not bumped.
func (s *Store) RewriteSnapshot(ctx context.Context, revision int64, nonce, cipher []byte) *contract.Fault {
	if s == nil || s.pool == nil {
		return contract.Internal("服务暂不可用")
	}
	_, err := s.pool.Exec(ctx, `
UPDATE public.platform_integration_config
SET nonce = $2, ciphertext = $3
WHERE singleton = true AND revision = $1`, revision, nonce, cipher)
	if err != nil {
		return dbFault(err)
	}
	return nil
}

// SaveConfig CAS-inserts the snapshot inside the admin writer gate.
func (s *Store) SaveConfig(ctx context.Context, actor domain.Actor, expected, next int64, nonce, cipher []byte, aiCount int, bucketRoles []string) *contract.Fault {
	return s.withGate(ctx, "admin", "平台连接配置写入未启用", func(ctx context.Context, tx pgx.Tx) error {
		var revision int64
		err := tx.QueryRow(ctx, `
INSERT INTO public.platform_integration_config
    (singleton, revision, nonce, ciphertext, updated_at_ms, updated_by_account_uuid)
SELECT true, $2, $3, $4, $5, $6
WHERE $1 = 0
   OR EXISTS (
        SELECT 1 FROM public.platform_integration_config WHERE singleton = true
   )
ON CONFLICT (singleton) DO UPDATE
SET revision = EXCLUDED.revision,
    nonce = EXCLUDED.nonce,
    ciphertext = EXCLUDED.ciphertext,
    updated_at_ms = EXCLUDED.updated_at_ms,
    updated_by_account_uuid = EXCLUDED.updated_by_account_uuid
WHERE platform_integration_config.revision = $1
RETURNING revision`, expected, next, nonce, cipher, s.Now().UnixMilli(), actor.PublicID).Scan(&revision)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return contract.Conflict("连接配置已被其他管理员更新，请刷新后重试")
			}
			return err
		}
		msg := jsonText(struct {
			Summary     string   `json:"summary"`
			AICount     int      `json:"aiCount"`
			BucketRoles []string `json:"bucketRoles"`
			Revision    int64    `json:"revision"`
		}{"更新平台 AI/存储桶连接配置", aiCount, bucketRoles, revision})
		return writeAudit(ctx, tx, auditRow{
			OrgID: orgFloor(actor.OrgID), UserID: actor.ID, Module: "admin",
			EntityType: "platform_integration_config", EntityID: "singleton",
			Method: "PUT", Path: "/api/admin/integrations/config",
			Action: "platform_integration_config_replaced", Message: msg,
		})
	})
}
