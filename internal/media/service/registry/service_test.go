package registry

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/media/domain/storageregistry"
)

type testBuckets map[contract.Role]Account

func (b testBuckets) Bucket(_ context.Context, role contract.Role) (Account, error) {
	a, ok := b[role]
	if !ok {
		return Account{}, ErrUnavailable
	}
	return a, nil
}

type testStore struct {
	Store
	upload UploadRow
	object []storageregistry.Object
}

func (s *testStore) Lookup(context.Context, storageregistry.Claim) ([]storageregistry.Object, []storageregistry.Object, error) {
	return s.object, nil, nil
}

func (s *testStore) BeginUpload(_ context.Context, row UploadRow) (string, error) {
	row.ID = "upload"
	s.upload = row
	return row.ID, nil
}

func (s *testStore) Upload(context.Context, string, int64, int64) (UploadRow, error) {
	return s.upload, nil
}

func (s *testStore) Confirm(_ context.Context, _ string, d storageregistry.ConfirmDecision) (string, error) {
	c := d.Claim
	s.object = []storageregistry.Object{{ID: "object", Bucket: c.Bucket, BucketIdentity: c.BucketIdentity,
		ObjectKey: c.ObjectKey, DedupeScope: c.DedupeScope, SHA256Hex: c.SHA256Hex, ByteLength: c.ByteLength,
		ContentType: c.ContentType, Extension: c.Extension, State: storageregistry.StateLive}}
	return "object", nil
}

type testSigner struct{ getAccount Account }

func (*testSigner) PresignPut(_ Account, _, _ string, _ int64, _ string, now time.Time) (Grant, error) {
	return Grant{URL: "https://signed.example/put", ExpiresAt: now.Add(time.Hour)}, nil
}

func (s *testSigner) PresignGet(a Account, _ string, _ time.Time, _ time.Duration, _, _ string) (string, error) {
	s.getAccount = a
	return "https://signed.example/get", nil
}

func TestConfiguredBucketURLs(t *testing.T) {
	ctx := context.Background()
	const public = "https://pub-0123456789abcdef0123456789abcdef.r2.dev"
	for _, tc := range []struct {
		role    contract.Role
		purpose contract.PurposeKind
		public  string
	}{
		{contract.RoleAssets, contract.PurposeListingImage, public},
		{contract.RolePrivate, contract.PurposeOrgFile, ""},
	} {
		t.Run(string(tc.role), func(t *testing.T) {
			account := Account{Endpoint: "https://test.r2.cloudflarestorage.com", Bucket: "test-" + string(tc.role), PublicBaseURL: tc.public, KeyPrefix: "test/"}
			store, signer := &testStore{}, &testSigner{}
			service := Service{Store: store, Signer: signer, Buckets: testBuckets{tc.role: account}}
			request := PresignRequest{ActorID: 1, OrgID: 2, Purpose: tc.purpose, SHA256Hex: strings.Repeat("a", 64), ByteLength: 3, Extension: "jpg"}
			target, err := service.Presign(ctx, request)
			if err != nil {
				t.Fatal(err)
			}
			want := ""
			if tc.public != "" {
				want = tc.public + "/" + target.ObjectKey
			}
			if target.PublicURL != want || target.Reuse || target.Grant == nil {
				t.Fatalf("new upload: %+v", target)
			}
			confirmed, err := service.Confirm(ctx, ConfirmRequest{ActorID: 1, OrgID: 2, UploadID: target.UploadID}, func(context.Context, UploadRow) (Object, error) {
				return Object{Exists: true, ByteLength: 3, ContentType: "image/jpeg", ReadbackSHA256Hex: request.SHA256Hex}, nil
			})
			if err != nil || confirmed.PublicURL != want || confirmed.ObjectID != "object" {
				t.Fatalf("confirmation: %+v %v", confirmed, err)
			}
			reused, err := service.Presign(ctx, request)
			if err != nil || !reused.Reuse || reused.PublicURL != want || reused.Grant != nil {
				t.Fatalf("reuse: %+v %v", reused, err)
			}
			download, err := service.DownloadGrant(ctx, tc.role, target.ObjectKey, "image.jpg", "image/jpeg", time.Minute)
			if tc.role == contract.RolePrivate {
				want = "https://signed.example/get"
				if signer.getAccount != account {
					t.Fatal("private download did not use configured account")
				}
			}
			if err != nil || download != want {
				t.Fatalf("download: %q %v", download, err)
			}
		})
	}
}

func TestConfirmRejectsChangedBucketBeforeProof(t *testing.T) {
	account := Account{Endpoint: "https://test.r2.cloudflarestorage.com", Bucket: "test-assets", KeyPrefix: "test/"}
	identity, err := account.config(contract.RoleAssets).Identity()
	if err != nil {
		t.Fatal(err)
	}
	for _, change := range []string{"endpoint", "bucket", "prefix", "missing", "invalid role"} {
		t.Run(change, func(t *testing.T) {
			current := account
			role := contract.RoleAssets
			want := storageregistry.ErrConflict
			switch change {
			case "endpoint":
				current.Endpoint = "https://other.r2.cloudflarestorage.com"
			case "bucket":
				current.Bucket = "other-assets"
			case "prefix":
				current.KeyPrefix = "other/"
			case "missing":
				want = ErrUnavailable
			case "invalid role":
				role, want = contract.RoleTransit, ErrInput
			}
			buckets := testBuckets{contract.RoleAssets: current}
			if change == "missing" {
				delete(buckets, contract.RoleAssets)
			}
			store := &testStore{upload: UploadRow{ID: "upload", Bucket: string(role), BucketIdentity: identity, State: storageregistry.UploadPending, ExpiresAt: time.Now().Add(time.Hour)}}
			_, err := (Service{Store: store, Buckets: buckets}).Confirm(context.Background(), ConfirmRequest{UploadID: "upload"}, func(context.Context, UploadRow) (Object, error) {
				t.Fatal("changed bucket reached object proof")
				return Object{}, nil
			})
			if !errors.Is(err, want) || len(store.object) != 0 {
				t.Fatalf("changed bucket confirmed: %v", err)
			}
		})
	}
}
