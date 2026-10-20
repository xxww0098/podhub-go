package adminrepo

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
	platformseal "github.com/xxww0098/podhub-go/internal/platform/seal"
)

const paymentLockKey int64 = 0x004f5a4f4e504159

func slotsOf(payment *platformseal.StoredPaymentConfig) []domain.PaymentSlot {
	if payment == nil {
		return domain.EmptyPayment()
	}
	out := make([]domain.PaymentSlot, 0, len(payment.Providers))
	for _, slot := range payment.Providers {
		values := slot.Values
		if values == nil {
			values = map[string]string{}
		}
		out = append(out, domain.PaymentSlot{Provider: slot.Provider, Enabled: slot.Enabled, Values: values})
	}
	return out
}

func paymentOf(slots []domain.PaymentSlot) *platformseal.StoredPaymentConfig {
	providers := make([]platformseal.StoredPaymentProvider, 0, len(slots))
	for _, slot := range slots {
		values := slot.Values
		if values == nil {
			values = map[string]string{}
		}
		providers = append(providers, platformseal.StoredPaymentProvider{Provider: slot.Provider, Enabled: slot.Enabled, Values: values})
	}
	return &platformseal.StoredPaymentConfig{Providers: providers}
}

func (r *Repo) loadPayment(ctx context.Context) (int64, []domain.PaymentSlot, domain.Snapshot, bool, error) {
	if fault := domain.IntegrationKey(r.Key); fault != nil {
		return 0, nil, domain.Snapshot{}, false, fault
	}
	var revision int64
	var nonce, ciphertext []byte
	err := r.Pool.QueryRow(ctx, `
		SELECT revision, nonce, ciphertext FROM public.platform_integration_config WHERE singleton = true`).Scan(&revision, &nonce, &ciphertext)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, domain.EmptyPayment(), domain.Snapshot{}, false, nil
	}
	if err != nil {
		return 0, nil, domain.Snapshot{}, false, mapBill(err, "INTERNAL", true)
	}
	if len(nonce) != 12 {
		return 0, nil, domain.Snapshot{}, false, domain.Internal("INTERNAL", msgUnavailable)
	}
	plain, err := open(aesKey(strings.TrimSpace(r.Key)), nonce, ciphertext)
	if err != nil {
		return 0, nil, domain.Snapshot{}, false, domain.Internal("INTERNAL", msgUnavailable)
	}
	snap, _, err := domain.ParseStored(plain)
	if err != nil {
		return 0, nil, domain.Snapshot{}, false, domain.Internal("INTERNAL", msgUnavailable)
	}
	return revision, slotsOf(snap.Payment), snap, true, nil
}

type providerView struct {
	Provider               string            `json:"provider"`
	Enabled                bool              `json:"enabled"`
	Configured             bool              `json:"configured"`
	Values                 map[string]string `json:"values"`
	SecretFieldsConfigured []string          `json:"secretFieldsConfigured"`
}

func publicPayment(revision int64, slots []domain.PaymentSlot) ([]byte, error) {
	views := make([]providerView, 0, len(slots))
	for _, slot := range slots {
		values, secrets := domain.PublicView(slot)
		views = append(views, providerView{
			Provider: slot.Provider, Enabled: slot.Enabled, Configured: slot.Enabled && domain.Configured(slot),
			Values: values, SecretFieldsConfigured: secrets,
		})
	}
	return data(struct {
		Revision  int64          `json:"revision"`
		Providers []providerView `json:"providers"`
	}{revision, views})
}

func (r *Repo) GetPayment(ctx context.Context, actor domain.Actor) ([]byte, error) {
	_ = actor
	revision, slots, _, _, err := r.loadPayment(ctx)
	if err != nil {
		return nil, err
	}
	return publicPayment(revision, slots)
}

func (r *Repo) PutPayment(ctx context.Context, actor domain.Actor, body domain.PaymentReplace) ([]byte, error) {
	revision, previous, doc, present, err := r.loadPayment(ctx)
	if err != nil {
		return nil, err
	}
	_ = revision
	next, fault := domain.NormalizePayment(body.Expected, body.Slots, previous)
	if fault != nil {
		return nil, fault
	}
	changed := !domain.SlotsEqual(previous, next)
	enabled := 0
	for _, slot := range next {
		if slot.Enabled {
			enabled++
		}
	}
	if !present {
		doc = domain.Snapshot{SchemaVersion: 1, AIAccounts: []domain.StoredAI{}, Buckets: []domain.StoredBucket{}}
	}
	if doc.AIAccounts == nil {
		doc.AIAccounts = []domain.StoredAI{}
	}
	if doc.Buckets == nil {
		doc.Buckets = []domain.StoredBucket{}
	}
	doc.SchemaVersion = 1
	doc.Payment = paymentOf(next)
	plain, err := json.Marshal(doc)
	if err != nil {
		return nil, domain.Internal("INTERNAL", msgUnavailable)
	}
	nonce, ciphertext, err := seal(aesKey(strings.TrimSpace(r.Key)), plain)
	if err != nil {
		return nil, domain.Internal("INTERNAL", msgUnavailable)
	}
	tx, err := r.beginTx(ctx)
	if err != nil {
		return nil, mapBill(err, "INTERNAL", true)
	}
	defer tx.Rollback(ctx)
	defer endLease(tx)
	held, err := admit(ctx, tx, "admin", r.now().UnixMilli(), domain.WritesDisabled("WRITES_DISABLED", "平台连接配置写入未启用"))
	if err != nil {
		return nil, mapBill(err, "INTERNAL", true)
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, paymentLockKey); err != nil {
		return nil, mapBill(err, "INTERNAL", true)
	}
	if changed {
		rows, err := tx.Query(ctx, `SELECT DISTINCT provider FROM payment_orders WHERE provider <> 'manual' AND status = 'pending'`)
		if err != nil {
			return nil, mapBill(err, "INTERNAL", true)
		}
		prevBy := map[string]domain.PaymentSlot{}
		nextBy := map[string]domain.PaymentSlot{}
		for _, slot := range previous {
			prevBy[slot.Provider] = slot
		}
		for _, slot := range next {
			nextBy[slot.Provider] = slot
		}
		for rows.Next() {
			var provider string
			if err := rows.Scan(&provider); err != nil {
				rows.Close()
				return nil, mapBill(err, "INTERNAL", true)
			}
			name := domain.PendingProvider(provider)
			if !domain.PendingChangeAllowed(provider, prevBy[name], nextBy[name]) {
				rows.Close()
				return nil, domain.Conflict("CONFLICT", "仍有待支付的支付宝订单，处理完订单后才能更改支付配置")
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, mapBill(err, "INTERNAL", true)
		}
		rows.Close()
	}
	var written int64
	err = tx.QueryRow(ctx, `
		INSERT INTO public.platform_integration_config
		       (singleton, revision, nonce, ciphertext, updated_at_ms, updated_by_account_uuid)
		SELECT true, $2, $3, $4, $5, $6
		 WHERE $1 = 0 OR EXISTS (SELECT 1 FROM public.platform_integration_config WHERE singleton = true)
		ON CONFLICT (singleton) DO UPDATE
		SET revision = EXCLUDED.revision, nonce = EXCLUDED.nonce, ciphertext = EXCLUDED.ciphertext,
		    updated_at_ms = EXCLUDED.updated_at_ms, updated_by_account_uuid = EXCLUDED.updated_by_account_uuid
		WHERE platform_integration_config.revision = $1
		RETURNING revision`,
		body.Expected, body.Expected+1, nonce, ciphertext, r.now().UnixMilli(), actor.PublicID).Scan(&written)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, domain.Conflict("CONFLICT", "连接配置已被其他管理员更新，请刷新后重试")
	}
	if err != nil {
		return nil, mapBill(err, "INTERNAL", true)
	}
	message, _ := json.Marshal(struct {
		Summary          string `json:"summary"`
		EnabledProviders int    `json:"enabledProviders"`
		MerchantChanged  bool   `json:"merchantChanged"`
		Revision         int64  `json:"revision"`
	}{"更新平台支付服务商配置", enabled, changed, written})
	if err := auditBill(ctx, tx, orgAtLeast0(actor.OrgID), actor.UserID, "admin", "platform_integration_config", "singleton", "PUT",
		"/api/admin/payment/config", "platform_payment_config_replaced", string(message), held); err != nil {
		return nil, mapBill(err, "INTERNAL", true)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapBill(err, "INTERNAL", true)
	}
	return publicPayment(written, next)
}
