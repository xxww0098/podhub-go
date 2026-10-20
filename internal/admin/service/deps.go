package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
	core "github.com/xxww0098/podhub-go/internal/listing/core/contract"
)

// Actor is the super admin the handler already admitted.
type Actor struct {
	UserID int64
	OrgID  int64
}

// Deps is the admin B process seam. Holder defaults to axum. Instance is
// CLOUD_INSTANCE_ID (blank becomes axum-{pid}) unless a test sets it.
type Deps struct {
	Pool     *pgxpool.Pool
	Now      func() time.Time
	Holder   string
	Instance string
	Key      string
	Engine   core.Engine
	Origin   Caller
	Tickets  Tickets
}

// Caller performs one presigned origin request.
type Caller interface {
	Exchange(ctx context.Context, method, rawURL string, headers map[string]string, body []byte, timeout time.Duration, noCompress, strict bool, max int64) (status int, header map[string][]string, resp []byte, err error)
}

// Issued is a browser PUT grant plus the stage ticket.
type Issued struct {
	URL         string
	ContentType string
	IfNoneMatch string
	Checksum    string
	ExpiresAtMS int64
	Ticket      string
}

// Verified is a ticket the confirm handler accepted.
type Verified struct {
	Key              string
	ContentType      string
	SHA256           string
	ByteLength       uint64
	StorageIdentity  string
	ChecksumEnforced bool
}

// Tickets issues and checks admin upload receipts. The implementation lives
// in the app layer because it uses the media receipt package.
type Tickets interface {
	Issue(account domain.CloudAccount, actorID int64, purpose, stage, contentType, sha string, n uint64, checksum bool, now time.Time) (Issued, error)
	Verify(account domain.CloudAccount, actorID int64, purpose, token string, now time.Time) (Verified, error)
	Identity(account domain.CloudAccount) string
	Marker(account domain.CloudAccount, identity, receiptKey, destination, sha, contentType string, n uint64) (string, error)
}

func (d Deps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

func (d Deps) nowMS() int64 { return d.now().UTC().UnixMilli() }

// NewPublicID is UUID v4 with hyphens.
func NewPublicID() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	value := hex.EncodeToString(buf[:])
	return value[0:8] + "-" + value[8:12] + "-" + value[12:16] + "-" + value[16:20] + "-" + value[20:32], nil
}

func orgAtLeastZero(org int64) int64 {
	if org < 0 {
		return 0
	}
	return org
}
