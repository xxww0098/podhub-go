package contract

import (
	"strings"
	"testing"
)

func TestUserPSDDoesNotHaveACloudUploadPurpose(t *testing.T) {
	if _, err := ResolvePurpose("org_template", "", 1, ""); err != ErrPurpose {
		t.Fatalf("retired template purpose: %v", err)
	}
	for _, kind := range []PurposeKind{PurposeOrgFile, PurposeDelegateBinding} {
		purpose := Purpose{Kind: kind, Bucket: RolePrivate, ID: "1", OrgID: 1}
		if _, err := ObjectKey("", purpose, strings.Repeat("a", 64), ExtPSD); err != ErrExtension {
			t.Fatalf("private purpose %s accepted a PSD: %v", kind, err)
		}
	}
	purpose, err := ResolvePurpose("source", "platform-library", 1, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ObjectKey("", purpose, strings.Repeat("a", 64), ExtPSD); err != nil {
		t.Fatalf("platform library templates must remain available: %v", err)
	}
}
