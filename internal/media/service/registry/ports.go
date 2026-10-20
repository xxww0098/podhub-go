package registry

import (
	"context"
	"time"

	"github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/media/domain/storageregistry"
)

// Store is the durable half of presign and confirm. Every method runs in a
// podhub_app transaction for the caller's org; the implementation takes the
// shared fence before it reads.
type Store interface {
	// Lookup returns the registry rows for the claim: by dedupe scope and by
	// exact key. Both slices may be empty.
	Lookup(ctx context.Context, claim storageregistry.Claim) (byScope, byKey []storageregistry.Object, err error)
	// BeginUpload inserts a pending upload row and returns its id.
	BeginUpload(ctx context.Context, row UploadRow) (string, error)
	// Confirm applies the confirm decision: reuse or insert the object row,
	// then mark the upload confirmed. It returns the object id.
	Confirm(ctx context.Context, uploadID string, decision storageregistry.ConfirmDecision) (string, error)
	// Upload returns one pending upload for this actor and org.
	Upload(ctx context.Context, uploadID string, actorID, orgID int64) (UploadRow, error)
	// ExpireUnconfirmed stops a pending claim whose object was already taken.
	ExpireUnconfirmed(ctx context.Context, uploadID string) error
}

// UploadRow is one storage_uploads row, defined with the registry state
// machine so the pgx repository can implement this port without importing it.
type UploadRow = storageregistry.Upload

// Object is a head proof from the bucket. The service never reads bytes.
type Object struct {
	Exists      bool
	ByteLength  int64
	ContentType string
	SHA256Hex   string
}

// Signer produces the browser PUT and the GET for private reads. It refuses a
// bucket whose provider does not sign x-amz-checksum-sha256.
type Signer interface {
	// PresignPut returns the URL and headers the browser must send. The
	// checksum is always covered; a store that cannot accept it is an error.
	PresignPut(account Account, key, contentType string, byteLength int64, digestHex string, now time.Time) (Grant, error)
	// PresignGet returns a short-lived GET for a private object.
	PresignGet(account Account, key string, now time.Time, ttl time.Duration, filename, contentType string) (string, error)
}

// Grant is one signed browser PUT.
type Grant struct {
	URL            string
	ContentType    string
	IfNoneMatch    string
	ChecksumSHA256 string
	ExpiresAt      time.Time
}

// Account is the bucket credential the signer needs. Secrets stay inside the
// signer implementation.
type Account struct {
	ID              string
	Provider        string
	Endpoint        string
	Region          string
	Bucket          string
	KeyPrefix       string
	PublicBaseURL   string
	ForcePathStyle  bool
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
}

// config turns the credential into the pure bucket model.
func (a Account) config(role contract.Role) contract.Config {
	return contract.Config{
		Role: role, Provider: a.Provider, Endpoint: a.Endpoint, Region: a.Region,
		Bucket: a.Bucket, KeyPrefix: a.KeyPrefix, PublicBaseURL: a.PublicBaseURL,
		ForcePathStyle: a.ForcePathStyle, AccessKeyID: a.AccessKeyID,
		SecretAccessKey: a.SecretAccessKey, SessionToken: a.SessionToken,
	}
}

// Resolver loads the configured bucket for a role. A nil resolver, or a role
// that is not configured, reports ErrUnavailable.
type Resolver interface {
	Bucket(ctx context.Context, role contract.Role) (Account, error)
}
