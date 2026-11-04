package service

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

func TestSystemStorageCredentialsAndSnapshot(t *testing.T) {
	initial := []StorageIn{{Role: "assets", Endpoint: "https://account.r2.cloudflarestorage.com", AccessKeyID: "access-id", SecretAccessKey: "private-secret"}}
	snapshot, view, fault := normalizeConfig(nil, ConfigIn{Storage: &initial}, false)
	if fault != nil {
		t.Fatal(fault)
	}
	if len(snapshot.SystemStorage) != 1 || snapshot.SystemStorage[0].ID != "s3_assets" || snapshot.SystemStorage[0].Bucket != "podhub-supplier" || snapshot.SystemStorage[0].PublicBaseURL != "https://podhub-supplier.ozon-pod.com" || snapshot.SystemStorage[0].SecretAccessKey != "private-secret" {
		t.Fatalf("storage was not retained: %+v", snapshot.SystemStorage)
	}
	public, _ := json.Marshal(view)
	for _, secret := range []string{"access-id", "private-secret"} {
		if strings.Contains(string(public), secret) {
			t.Fatalf("configuration response exposed %q", secret)
		}
	}
	for _, internal := range []string{"key_prefix", "session_token", `"id"`} {
		if strings.Contains(string(public), internal) {
			t.Fatalf("configuration response exposed internal field %q", internal)
		}
	}
	sealed, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := seal.ParseSnapshot(sealed); err != nil {
		t.Fatalf("payment reader rejected storage: %v", err)
	}
	stored, _, err := domain.ParseStored(sealed)
	if err != nil || stored.SystemStorage[0].SecretAccessKey != "private-secret" {
		t.Fatalf("snapshot round trip: %v", err)
	}
	encoded, err := stored.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	stored, _, err = domain.ParseStored(encoded)
	if err != nil || stored.SystemStorage[0].AccessKeyID != "access-id" {
		t.Fatalf("snapshot marshal lost storage: %v", err)
	}

	// Saving again never asks for the internal identity or prefix.
	stored.SystemStorage[0].KeyPrefix = "existing/"
	edit := initial[0]
	edit.AccessKeyID, edit.SecretAccessKey = "", ""
	rows, fault := mergeSystemStorage(&stored, []StorageIn{edit})
	if fault != nil || rows[0].ID != "s3_assets" || rows[0].KeyPrefix != "existing/" || rows[0].AccessKeyID != "access-id" || rows[0].SecretAccessKey != "private-secret" {
		t.Fatalf("internal identity or blank credentials were not retained: %+v %v", rows, fault)
	}

	// AI-only writes leave the storage intact.
	retained, _, fault := normalizeConfig(&stored, ConfigIn{}, false)
	if fault != nil || len(retained.SystemStorage) != 1 || retained.SystemStorage[0].SecretAccessKey != "private-secret" {
		t.Fatal("AI update dropped storage")
	}

	edit.Endpoint = "https://other.r2.cloudflarestorage.com"
	if _, fault = mergeSystemStorage(&stored, []StorageIn{edit}); fault == nil {
		t.Fatal("endpoint change reused credentials")
	}
	edit.Endpoint = initial[0].Endpoint
	edit.Bucket = "another-bucket"
	if _, fault = mergeSystemStorage(&stored, []StorageIn{edit}); fault == nil {
		t.Fatal("bucket change reused credentials")
	}
	edit.Bucket = ""
	edit.AccessKeyID = "new-id"
	if _, fault = mergeSystemStorage(&stored, []StorageIn{edit}); fault == nil {
		t.Fatal("new access key reused old secret")
	}
	edit.SecretAccessKey = "new-secret"
	rows, fault = mergeSystemStorage(&stored, []StorageIn{edit})
	if fault != nil || rows[0].AccessKeyID != "new-id" || rows[0].SecretAccessKey != "new-secret" {
		t.Fatalf("new credential was not stored: %+v %v", rows, fault)
	}
}
