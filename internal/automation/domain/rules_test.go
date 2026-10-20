package domain

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/automation/contract"
)

func TestCleanNameAndItems(t *testing.T) {
	if _, err := CleanName("  "); err == nil || err.Message != contract.MsgBadName {
		t.Fatal(err)
	}
	name, err := CleanName("  demo  ")
	if err != nil || name != "demo" {
		t.Fatalf("%q %v", name, err)
	}
	long := strings.Repeat("中", 120)
	if _, err := CleanName(long); err != nil {
		t.Fatal(err)
	}
	if _, err := CleanName(long + "x"); err == nil {
		t.Fatal("121")
	}
	items := make([]ItemInput, 501)
	if _, err := CleanItems(items); err == nil || err.Message != contract.MsgTooManyItems {
		t.Fatal(err)
	}
	sha := strings.Repeat("A", 64)
	got, err := CleanItems([]ItemInput{{FileName: " a.jpg ", SHA256: sha, SizeBytes: -3}})
	if err != nil || got[0].SHA256 != strings.Repeat("a", 64) || got[0].SizeBytes != 0 || got[0].FileName != "a.jpg" {
		t.Fatalf("%+v %v", got, err)
	}
	if got[0].Key != "local:"+got[0].SHA256+":a.jpg" {
		t.Fatal(got[0].Key)
	}
	if _, err := CleanItems([]ItemInput{{FileName: "a", SHA256: "zz"}}); err == nil || err.Message != contract.MsgBadItem {
		t.Fatal(err)
	}
	empty, err := CleanItems(nil)
	if err != nil || len(empty) != 0 {
		t.Fatal(err)
	}
}

func TestRendererExpiryLimit(t *testing.T) {
	if _, err := CleanRenderer("   "); err == nil || err.Message != contract.MsgBadRenderer {
		t.Fatal(err)
	}
	got, err := CleanRenderer("  browser-wasm-v2  ")
	if err != nil || got != "browser-wasm-v2" {
		t.Fatalf("%q %v", got, err)
	}
	if _, err := CleanRenderer(strings.Repeat("a", 65)); err == nil {
		t.Fatal("65")
	}
	if _, err := CleanRenderer(strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	if CleanExpiry(nil) != nil {
		t.Fatal("nil expiry")
	}
	one := int64(1)
	max := int64(3650)
	zero := int64(0)
	over := int64(3651)
	if CleanExpiry(&one) != nil || CleanExpiry(&max) != nil {
		t.Fatal("bounds")
	}
	if CleanExpiry(&zero) == nil || CleanExpiry(&over) == nil {
		t.Fatal("reject")
	}
	if ClampLimit(nil) != 4 {
		t.Fatal("default")
	}
	neg := int64(-5)
	big := int64(9)
	mid := int64(3)
	if ClampLimit(&neg) != 1 || ClampLimit(&big) != 8 || ClampLimit(&mid) != 3 || ClampLimit(new(int64)) != 1 {
		t.Fatal("clamp")
	}
}

func TestDelegateMatrix(t *testing.T) {
	all := []string{"read", "prepare", "submit", "catalog:read", "cards:write"}
	roles := []struct {
		role string
		ok   []bool
	}{
		{"owner", []bool{true, true, true, true, true}},
		{"manager", []bool{true, true, true, true, true}},
		{"admin", []bool{true, true, true, true, true}},
		{"member", []bool{true, true, true, true, true}},
		{"reviewer", []bool{true, true, false, true, true}},
		{"viewer", []bool{true, false, false, true, false}},
	}
	for _, role := range roles {
		for i, action := range all {
			_, err := Delegate(role.role, []string{action})
			if role.ok[i] && err != nil {
				t.Fatalf("%s %s %v", role.role, action, err)
			}
			if !role.ok[i] && (err == nil || err.Message != contract.MsgCannotDelegate+action) {
				t.Fatalf("%s %s %v", role.role, action, err)
			}
		}
		_, err := Delegate(role.role, []string{"supplier:read"})
		if err == nil || err.Message != contract.MsgCannotDelegate+"supplier:read" {
			t.Fatalf("%s supplier %v", role.role, err)
		}
	}
	got, err := Delegate("member", []string{" read ", "read", "prepare"})
	if err != nil || len(got) != 2 || got[0] != "read" || got[1] != "prepare" {
		t.Fatalf("%v %v", got, err)
	}
	if _, err := Delegate("owner", []string{"bogus"}); err == nil || err.Message != contract.MsgUnknownAction+"bogus" {
		t.Fatal(err)
	}
	if _, err := Delegate("owner", []string{"  x  "}); err == nil || !strings.HasSuffix(err.Message, "  x  ") {
		t.Fatal(err)
	}
	if _, err := Delegate("owner", nil); err == nil || err.Message != contract.MsgNoAction {
		t.Fatal(err)
	}
	if _, err := Delegate("root", []string{"read"}); err == nil {
		t.Fatal("bad role")
	}
	if !LiveAllows("member", "submit") || LiveAllows("viewer", "prepare") || LiveAllows("nope", "prepare") {
		t.Fatal("live")
	}
	if !LiveAllows("nope", "read") {
		t.Fatal("unknown role is viewer and may read")
	}
}

func TestStatusAndToken(t *testing.T) {
	if _, err := CleanStatus("cancelled"); err == nil || err.Message != contract.MsgBadStatus {
		t.Fatal(err)
	}
	for _, status := range []string{"completed", "failed", "canceled"} {
		if got, err := CleanStatus(status); err != nil || got != status {
			t.Fatal(status)
		}
	}
	if _, ok := ParseID("not-a-uuid"); ok {
		t.Fatal("uuid")
	}
	id, ok := ParseID("11111111-1111-4111-8111-111111111111")
	if !ok || id != "11111111-1111-4111-8111-111111111111" {
		t.Fatal(id)
	}
	token, prefix, hash, err := MintToken(bytes.NewReader(make([]byte, 32)))
	if err != nil {
		t.Fatal(err)
	}
	if token != "opa_"+strings.Repeat("A", 43) || prefix != "opa_AAAAAAAA" || len(token) != 47 || len(prefix) != 12 || len(hash) != 64 {
		t.Fatalf("%s %s %s", token, prefix, hash)
	}
	sum := sha256.Sum256([]byte(token))
	if hex.EncodeToString(sum[:]) != hash || !strings.HasPrefix(token, "opa_") {
		t.Fatal("hash")
	}
}
