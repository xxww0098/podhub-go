package supplierrepo

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

func (r Portal) SupplierAccount(ctx context.Context) (sign.Account, bool, error) {
	if r.Pool == nil || strings.TrimSpace(r.Key) == "" {
		return sign.Account{}, false, nil
	}
	var nonce, ciphertext []byte
	err := r.Pool.QueryRow(ctx, `SELECT nonce, ciphertext FROM public.platform_integration_config WHERE singleton = true`).Scan(&nonce, &ciphertext)
	if errors.Is(err, pgx.ErrNoRows) {
		return sign.Account{}, false, nil
	}
	if err != nil {
		return sign.Account{}, false, err
	}
	plain, err := corerepo.Open(corerepo.AESKey(strings.TrimSpace(r.Key)), nonce, ciphertext)
	if err != nil {
		return sign.Account{}, false, err
	}
	snap, _, err := corecontract.ParseStored(plain)
	if err != nil {
		return sign.Account{}, false, nil
	}
	for _, row := range snap.Buckets {
		if row.Role != "assets" || !row.Active {
			continue
		}
		return sign.Account{
			ID: row.ID, Provider: sign.Provider(row.Provider), Endpoint: row.Endpoint, Region: row.Region,
			Bucket: row.Bucket, KeyPrefix: row.KeyPrefix, PublicBaseURL: row.PublicBase, ForcePathStyle: row.ForcePath,
			AccessKeyID: row.AccessKey, SecretAccessKey: row.SecretKey, SessionToken: row.SessionToken,
		}, true, nil
	}
	return sign.Account{}, false, nil
}
