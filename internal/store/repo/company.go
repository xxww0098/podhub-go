// Package storerepo reads organization_stores inside a tenant transaction.
// The table has no row level security. Every statement still requires the
// tenant GUC and filters on the session org id.
package storerepo

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// BeginApp opens a podhub_app transaction for one org.
type BeginApp func(ctx context.Context, begin func(context.Context) (pgx.Tx, error), orgID int64) (pgx.Tx, error)

// Repo is the organization_stores directory.
type Repo struct {
	pool  *pgxpool.Pool
	begin BeginApp
	ring  seal.Ring
	ready bool
	// probe answers POST /v1/roles for the credential routes. Nil is an
	// unreachable Seller: a build without a relay refuses before dialing.
	probe SellerProbe
	// keyID is the key-ring id this process stamps on new rows.
	keyID string
	// egress posts the Seller reads the mirror spends. Nil refuses before a
	// dial, exactly as a non-loopback base does.
	egress SellerEgress
}

// SellerEgress is the Seller round trip the mirror spends. Every row is a
// read: the mirror never writes Ozon. The interface is declared here rather
// than importing the seller unit, because the repo layer may only reach
// another unit's contract — and the adapter belongs to the assembly layer.
type SellerEgress interface {
	SellerRead(ctx context.Context, path string, body []byte, clientID, apiKey string) (status int, response []byte, err error)
}

// ErrNoEgress means no Seller client is bound: the read refuses before a dial,
// the same answer a non-loopback base gets.
var ErrNoEgress = errors.New("seller egress is not bound")

// New keeps the pool and the tenant opener.
func New(pool *pgxpool.Pool, begin BeginApp) Repo {
	return Repo{pool: pool, begin: begin}
}

// WithCredentialKey binds the key ring and the Seller probe. The ring also
// serves the older refresh path, so both live on one repo.
func (r Repo) WithCredentialKey(ring seal.Ring, ready bool, keyID string, probe SellerProbe) Repo {
	r.ring = ring
	r.ready = ready
	r.keyID = keyID
	r.probe = probe
	return r
}

// WithSellerEgress binds the Seller client the mirror reads through.
func (r Repo) WithSellerEgress(egress SellerEgress) Repo {
	r.egress = egress
	return r
}

// WithSeal enables opening a sealed seller key for a refresh.
func (r Repo) WithSeal(ring seal.Ring, ready bool) Repo {
	r.ring = ring
	r.ready = ready
	return r
}

const rowCols = `
s.uuid::text, s.name, COALESCE(s.company_short_name, ''), COALESCE(s.company_legal_name, ''),
s.name_source, s.create_order, s.assignee_membership_id,
COALESCE(s.company_currency, ''), COALESCE(s.company_country, ''),
s.subscription_is_premium, COALESCE(s.subscription_type, ''),
s.seller_info_synced_at, s.seller_key_status, COALESCE(s.seller_key_reason, ''),
COALESCE((SELECT sync.currency FROM public.store_product_sync sync
           WHERE sync.org_id = s.org_id AND sync.store_id = s.uuid), '')`

const storeCols = `
SELECT ` + rowCols + `
  FROM public.organization_stores s`

func (r Repo) Load(ctx context.Context, orgID int64, storeUUID string) (domain.Store, error) {
	var row domain.Store
	err := r.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		var err error
		row, err = scanOne(tx.QueryRow(ctx, storeCols+`
			WHERE s.org_id = $1 AND s.uuid = $2::uuid AND s.deleted_at_ms IS NULL`, orgID, storeUUID))
		return err
	})
	return row, err
}

func (r Repo) List(ctx context.Context, orgID, userID int64) ([]domain.Store, int64, bool, error) {
	var rows []domain.Store
	var membership int64
	var has bool
	err := r.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		list, err := tx.Query(ctx, storeCols+`
			WHERE s.org_id = $1 AND s.deleted_at_ms IS NULL
			ORDER BY s.create_order, s.uuid`, orgID)
		if err != nil {
			return err
		}
		defer list.Close()
		for list.Next() {
			row, err := scanOne(list)
			if err != nil {
				return err
			}
			rows = append(rows, row)
		}
		if err := list.Err(); err != nil {
			return err
		}
		err = tx.QueryRow(ctx, `
			SELECT id FROM public.organization_members
			 WHERE org_id = $1 AND user_id = $2 AND status = 'active'
			   AND NOT manual_disabled AND NOT quota_suspended
			 ORDER BY id
			 LIMIT 1`, orgID, userID).Scan(&membership)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		has = true
		return nil
	})
	if rows == nil {
		rows = []domain.Store{}
	}
	return rows, membership, has, err
}

func (r Repo) SaveCompany(ctx context.Context, orgID int64, storeUUID string, patch domain.Patch) (domain.Store, error) {
	var row domain.Store
	err := r.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		var short, legal, name *string
		writeShort, writeLegal, writeName := false, false, false
		if patch.Short != nil {
			writeShort = true
			short = patch.Short
		}
		if patch.Legal != nil {
			writeLegal = true
			legal = patch.Legal
		}
		if patch.Name != nil {
			writeName = true
			name = patch.Name
		}
		writeCurrency := patch.Currency != nil
		writeCountry := patch.Country != nil
		writePremium := patch.Premium != nil
		writeSub := patch.SubType != nil
		writeStatus := patch.KeyStatus != nil
		writeReason := patch.KeyReason != nil
		var err error
		row, err = scanOne(tx.QueryRow(ctx, `
			UPDATE public.organization_stores s
			   SET company_short_name = CASE WHEN $3 THEN $4 ELSE s.company_short_name END,
			       company_legal_name = CASE WHEN $5 THEN $6 ELSE s.company_legal_name END,
			       name = CASE WHEN $7 THEN $8 ELSE s.name END,
			       company_currency = CASE WHEN $9 THEN $10 ELSE s.company_currency END,
			       company_country = CASE WHEN $11 THEN $12 ELSE s.company_country END,
			       subscription_is_premium = CASE WHEN $13 THEN $14 ELSE s.subscription_is_premium END,
			       subscription_type = CASE WHEN $15 THEN $16 ELSE s.subscription_type END,
			       seller_info_synced_at = CASE WHEN $17 THEN clock_timestamp() ELSE s.seller_info_synced_at END,
			       seller_key_status = CASE WHEN $18 THEN $19 ELSE s.seller_key_status END,
			       seller_key_reason = CASE WHEN $20 THEN NULLIF($21, '') ELSE s.seller_key_reason END,
			       updated_at = clock_timestamp()
			 WHERE s.org_id = $1 AND s.uuid = $2::uuid AND s.deleted_at_ms IS NULL
			RETURNING `+rowCols,
			orgID, storeUUID,
			writeShort, short, writeLegal, legal, writeName, name,
			writeCurrency, patch.Currency, writeCountry, patch.Country,
			writePremium, patch.Premium, writeSub, patch.SubType,
			patch.TouchSynced, writeStatus, patch.KeyStatus, writeReason, patch.KeyReason))
		return err
	})
	return row, err
}

func (r Repo) Rename(ctx context.Context, orgID int64, storeUUID, name string) (domain.Store, error) {
	var row domain.Store
	err := r.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		scanned, err := scanOne(tx.QueryRow(ctx, `
			UPDATE public.organization_stores s
			   SET name = $3,
			       name_source = 'manual',
			       updated_at = clock_timestamp()
			 WHERE s.org_id = $1 AND s.uuid = $2::uuid AND s.deleted_at_ms IS NULL
			   AND s.name IS DISTINCT FROM $3
			RETURNING `+rowCols,
			orgID, storeUUID, name))
		if err == nil {
			row = scanned
			return nil
		}
		if !errors.Is(err, contract.ErrNotFound) {
			return err
		}
		row, err = scanOne(tx.QueryRow(ctx, storeCols+`
			WHERE s.org_id = $1 AND s.uuid = $2::uuid AND s.deleted_at_ms IS NULL`, orgID, storeUUID))
		return err
	})
	return row, err
}

// RefuseUnsetOrg fails when the transaction has no tenant GUC.
// It does not read or write a store row.
func (r Repo) RefuseUnsetOrg(ctx context.Context, tx pgx.Tx) error {
	if err := tenantx.RequireOrg(ctx, tx); err != nil {
		return contract.ErrNoTenant
	}
	return nil
}

func (r Repo) withOrg(ctx context.Context, orgID int64, fn func(pgx.Tx) error) error {
	if orgID <= 0 {
		return contract.ErrNoTenant
	}
	if r.pool == nil || r.begin == nil {
		return contract.ErrUnavailable
	}
	tx, err := r.begin(ctx, r.pool.Begin, orgID)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := tenantx.RequireOrg(ctx, tx); err != nil {
		return contract.ErrNoTenant
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type scanner interface {
	Scan(dest ...any) error
}

// Open returns the sealed client id and API key for one store in this org.
// A missing envelope is ErrNoCredential. The key is not logged.
func (r Repo) Open(ctx context.Context, orgID int64, storeUUID string) (string, string, error) {
	if !r.ready {
		return "", "", contract.ErrUnavailable
	}
	var clientID, apiKey string
	err := r.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		var (
			expires                   *int64
			version                   *int
			storedID, keyID           *string
			nonce, ciphertext         []byte
			wrapped, dekNonce, finger []byte
		)
		err := tx.QueryRow(ctx, `
			SELECT c.key_expires_at_ms, c.envelope_version, c.client_id, c.key_id,
			       c.nonce, c.ciphertext, c.wrapped_dek, c.dek_nonce, c.key_fingerprint
			  FROM public.organization_stores s
			  LEFT JOIN public.store_seller_credentials c
			    ON c.store_id = s.id AND c.org_id = s.org_id
			 WHERE s.org_id = $1 AND s.uuid = $2::uuid AND s.deleted_at_ms IS NULL`,
			orgID, storeUUID).Scan(&expires, &version, &storedID, &keyID, &nonce, &ciphertext, &wrapped, &dekNonce, &finger)
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.ErrNotFound
		}
		if err != nil {
			var pg *pgconn.PgError
			if errors.As(err, &pg) && pg.Code == "22P02" {
				return contract.ErrNotFound
			}
			return err
		}
		if expires != nil && *expires <= time.Now().UnixMilli() {
			return contract.ErrNoCredential
		}
		if keyID == nil || len(nonce) == 0 || len(ciphertext) == 0 {
			return contract.ErrNoCredential
		}
		env := seal.Store{
			KeyID: *keyID, Nonce: nonce, Ciphertext: ciphertext,
			WrappedDEK: wrapped, DEKNonce: dekNonce, Fingerprint: finger,
		}
		if version != nil {
			env.Version = *version
		}
		if storedID != nil {
			env.ClientID = *storedID
		}
		secret, err := r.ring.OpenStore(env)
		if err != nil {
			return contract.ErrUnavailable
		}
		clientID, apiKey = secret.ClientID, secret.APIKey
		return nil
	})
	return clientID, apiKey, err
}

func scanOne(row scanner) (domain.Store, error) {
	var out domain.Store
	var assignee *int64
	err := row.Scan(
		&out.UUID, &out.Name, &out.ShortName, &out.LegalName, &out.Source, &out.CreateOrder, &assignee,
		&out.Currency, &out.Country, &out.Premium, &out.SubType, &out.SyncedAt,
		&out.KeyStatus, &out.KeyReason, &out.PricingCurrency,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Store{}, contract.ErrNotFound
	}
	if err != nil {
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "22P02" {
			return domain.Store{}, contract.ErrNotFound
		}
		return domain.Store{}, err
	}
	out.Assignee = assignee
	return out, nil
}
