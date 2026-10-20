package worker

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	queuejobs "github.com/xxww0098/podhub-go/internal/queue/jobs"
	"github.com/xxww0098/podhub-go/internal/ratings/contract"
	ratingjobs "github.com/xxww0098/podhub-go/internal/ratings/jobs"
	ratingrepo "github.com/xxww0098/podhub-go/internal/ratings/repo"
	ratingsvc "github.com/xxww0098/podhub-go/internal/ratings/service"
	"github.com/xxww0098/podhub-go/internal/seller"
)

func ratingAddon(pool *pgxpool.Pool, cfg config.Config) queuejobs.Addon {
	repo := ratingrepo.New(pool)
	svc := ratingsvc.New(repo)
	svc.Source = ratingSource{pool: pool, eg: seller.New(cfg).WithPool(pool), ring: ratingRing(cfg)}
	svc.Ranks = cfg.RatingStatusRank()
	svc.Interval = cfg.RatingSyncInterval()
	svc.Retention = cfg.RatingRetention()
	return queuejobs.Addon{Register: func(workers *river.Workers) []*river.PeriodicJob {
		ratingjobs.AddWorkers(workers, svc.SyncDue, svc.Prune)
		return nil
	}}
}

func ratingRing(cfg config.Config) seal.Ring {
	if cfg.SellerCredentialKey == "" {
		return seal.Ring{}
	}
	ring := seal.Ring{Primary: seal.DeriveKEK(cfg.SellerCredentialKey)}
	if cfg.SellerCredentialKeyPrevious != "" {
		ring.Previous = seal.DeriveKEK(cfg.SellerCredentialKeyPrevious)
	}
	return ring
}

// ratingSource posts contract.SellerInfoPath through seller.Egress.Call
// with write disabled, which is the rate-limited loopback client. There is
// no refresh-store-info function to call instead.
type ratingSource struct {
	pool *pgxpool.Pool
	eg   *seller.Egress
	ring seal.Ring
}

func (s ratingSource) Post(ctx context.Context, orgID int64, storeID string) ([]byte, error) {
	secret, err := s.open(ctx, orgID, storeID)
	if err != nil {
		return nil, err
	}
	return postSellerInfo(ctx, s.eg, secret.ClientID, secret.APIKey)
}

func (s ratingSource) open(ctx context.Context, orgID int64, storeID string) (seal.Secret, error) {
	if s.pool == nil {
		return seal.Secret{}, contract.ErrNoCredential
	}
	tx, err := tenantx.BeginApp(ctx, s.pool.Begin, orgID)
	if err != nil {
		return seal.Secret{}, err
	}
	defer tx.Rollback(ctx)
	var env seal.Store
	var clientID *string
	err = tx.QueryRow(ctx, `
		SELECT c.envelope_version, c.client_id, c.key_id, c.nonce, c.ciphertext,
		       c.wrapped_dek, c.dek_nonce, c.key_fingerprint
		  FROM store_seller_credentials c
		  JOIN organization_stores s ON s.id = c.store_id
		 WHERE c.org_id = $1 AND s.uuid = $2::uuid`, orgID, storeID).Scan(
		&env.Version, &clientID, &env.KeyID, &env.Nonce, &env.Ciphertext,
		&env.WrappedDEK, &env.DEKNonce, &env.Fingerprint)
	if errors.Is(err, pgx.ErrNoRows) {
		return seal.Secret{}, contract.ErrNoCredential
	}
	if err != nil {
		return seal.Secret{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return seal.Secret{}, err
	}
	if clientID != nil {
		env.ClientID = *clientID
	}
	secret, err := s.ring.OpenStore(env)
	if err != nil || secret.ClientID == "" || secret.APIKey == "" {
		return seal.Secret{}, contract.ErrNoCredential
	}
	return secret, nil
}

// postSellerInfo is one read of /v1/seller/info. A non-loopback base is
// not dialed. The error text does not include the credential.
func postSellerInfo(ctx context.Context, eg *seller.Egress, clientID, apiKey string) ([]byte, error) {
	if eg == nil || !eg.Loopback() {
		return nil, seller.ErrRefusedOrigin
	}
	reply, err := eg.Call(ctx, http.MethodPost, contract.SellerInfoPath, []byte(`{}`), false, false, clientID, apiKey)
	if err != nil {
		return nil, errors.New("seller info read failed")
	}
	if reply.Status < 200 || reply.Status >= 300 {
		return nil, fmt.Errorf("seller info status %d", reply.Status)
	}
	return []byte(reply.Body), nil
}
