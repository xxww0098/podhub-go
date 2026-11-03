package app

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	billing "github.com/xxww0098/podhub-go/internal/billing/contract"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
	billingsvc "github.com/xxww0098/podhub-go/internal/billing/service"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

// NewPaymentRuntime reloads the encrypted snapshot per operation, so an admin
// save, disable or secret rotation never needs a process restart.
func NewPaymentRuntime(pool *pgxpool.Pool, cfg config.Config, client *http.Client) *billingsvc.PaymentRuntime {
	load := func(ctx context.Context) ([]billing.PaymentConfiguration, error) {
		if pool == nil {
			return nil, billingsvc.ErrPaymentClosed
		}
		key, err := seal.IntegrationKEK(cfg.IntegrationConfigKey)
		if err != nil {
			return nil, billingsvc.ErrPaymentClosed
		}
		var nonce, ciphertext []byte
		err = db.InTx(ctx, pool, db.AppRole(), func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT nonce,ciphertext FROM platform_integration_config WHERE singleton`).Scan(&nonce, &ciphertext)
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return []billing.PaymentConfiguration{}, nil
		}
		if err != nil {
			return nil, billingsvc.ErrPaymentClosed
		}
		plain, err := seal.OpenIntegration(key, nonce, ciphertext)
		if err != nil {
			return nil, billingsvc.ErrPaymentClosed
		}
		snapshot, err := seal.ParseSnapshot(plain)
		if err != nil {
			return nil, billingsvc.ErrPaymentClosed
		}
		out := []billing.PaymentConfiguration{}
		if snapshot.Payment != nil {
			for _, p := range snapshot.Payment.Providers {
				out = append(out, billing.PaymentConfiguration{Provider: p.Provider, Enabled: p.Enabled, Values: p.Values})
			}
		}
		return out, nil
	}
	return &billingsvc.PaymentRuntime{Store: billingrepo.PaymentOrders{Pool: pool}, Load: load, Gateway: billingrepo.PaymentGateway{Client: client}}
}
