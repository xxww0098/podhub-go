package readhttp

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
)

type mediaLeaseTestTx struct {
	pgx.Tx
	args     []any
	url      string
	revision int64
	err      error
}

func (tx *mediaLeaseTestTx) QueryRow(_ context.Context, _ string, args ...any) pgx.Row {
	tx.args = args
	return mediaLeaseTestRow{tx.url, tx.revision, tx.err}
}

type mediaLeaseTestRow struct {
	url      string
	revision int64
	err      error
}

func (row mediaLeaseTestRow) Scan(dest ...any) error {
	if row.err != nil {
		return row.err
	}
	*dest[0].(*string) = row.url
	*dest[1].(*int64) = row.revision
	return nil
}

func TestSharedWorkspaceRetainsVerifiedUserSlice(t *testing.T) {
	other := uuid.NewString()
	prefix, _ := media.SlicePrefix(other)
	key := prefix + "uploads/old/image.png"
	public := "https://other-user.example/" + key
	tx := &mediaLeaseTestTx{url: public, revision: 7}
	request := httptest.NewRequest("POST", "/", nil)
	image := mediaImage{ContentHash: strings.Repeat("a", 64), Bytes: 64, Width: 8, Height: 6}
	transit := &TransitStorage{AccountID: "current", StorageRevision: 3, PublicURL: func(key string) string { return "https://current.example/" + key }}
	got, revision, err := (Host{}).verifyMediaLease(request, tx, 42, transit, image, key, other)
	if err != nil || got != public || revision != 7 || tx.args[0] != int64(42) || tx.args[3] != other || tx.args[4] != int64(-1) {
		t.Fatalf("shared receipt=%q revision=%d err=%v", got, revision, err)
	}
	if _, _, err := (Host{}).verifyMediaLease(request, tx, 42, transit, image, "elsewhere/"+key, other); err == nil {
		t.Fatal("foreign prefix was accepted")
	}
	tx.err = pgx.ErrNoRows
	if _, _, err := (Host{}).verifyMediaLease(request, tx, 42, transit, image, key, other); err == nil {
		t.Fatal("unverified shared slice was accepted")
	}
}
