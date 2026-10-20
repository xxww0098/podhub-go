package domain

import (
	"testing"
	"time"

	media "github.com/xxww0098/podhub-go/internal/media/domain/receipt"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

func TestTicketMatchesMediaReceipt(t *testing.T) {
	account := sign.Account{
		ID: "acc", Provider: sign.ProviderGeneric, Endpoint: "http://127.0.0.1:9",
		Region: "auto", Bucket: "supplier-db-bucket", KeyPrefix: "pod/supplier/",
		PublicBaseURL: "http://127.0.0.1:9/cdn", ForcePathStyle: true,
		AccessKeyID: "AKID", SecretAccessKey: "secret",
	}
	now := time.Unix(1_700_000_000, 0).UTC()
	got, err := IssueUpload(account, "admin-supplier-upload:abc", 7, "pod/supplier/.direct-uploads/id", "image/png", strings64(), 12, now, false)
	if err != nil {
		t.Fatal(err)
	}
	want, err := media.Issue(account, media.Subject{Purpose: "admin-supplier-upload:abc", ActorID: 7}, media.Object{
		Key: "pod/supplier/.direct-uploads/id", ContentType: "image/png", ByteLength: 12, SHA256: strings64(),
	}, now, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got.Ticket != want.Ticket {
		t.Fatalf("ticket\n got %s\nwant %s", got.Ticket, want.Ticket)
	}
	if got.Grant == nil || got.Grant.URL != want.Grant.URL || got.Grant.ExpiresAt != want.Grant.ExpiresAt {
		t.Fatalf("grant %+v %+v", got.Grant, want.Grant)
	}
}

func strings64() string { return "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }
