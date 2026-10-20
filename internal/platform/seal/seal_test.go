package seal

import (
	"bytes"
	"crypto/sha256"
	"testing"
)

func TestDeriveAndRoundTrip(t *testing.T) {
	hexKey := "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
	fromHex := DeriveKEK(hexKey)
	if len(fromHex) != 32 {
		t.Fatalf("hex kek %d", len(fromHex))
	}
	raw := bytes.Repeat([]byte{'k'}, 32)
	if !bytes.Equal(DeriveKEK(string(raw)), raw) {
		t.Fatal("raw 32-byte kek was hashed")
	}
	hashed := DeriveKEK("short-secret")
	sum := sha256.Sum256([]byte("short-secret"))
	if !bytes.Equal(hashed, sum[:]) {
		t.Fatal("short secret was not hashed")
	}

	ring := Ring{Primary: fromHex, Previous: hashed}
	v1, err := SealV1(fromHex, "k1", "client-a", "api-key-a")
	if err != nil {
		t.Fatal(err)
	}
	got, err := ring.OpenStore(v1)
	if err != nil || got.ClientID != "client-a" || got.APIKey != "api-key-a" {
		t.Fatalf("v1 %+v %v", got, err)
	}
	v2, err := SealV2(hashed, "k0", "client-b", "api-key-b")
	if err != nil {
		t.Fatal(err)
	}
	if len(v2.WrappedDEK) != 48 {
		t.Fatalf("wrapped dek %d", len(v2.WrappedDEK))
	}
	got, err = ring.OpenStore(v2)
	if err != nil || got.ClientID != "client-b" || got.APIKey != "api-key-b" {
		t.Fatalf("v2 %+v %v", got, err)
	}

	v1.Fingerprint[0] ^= 0xff
	if _, err := ring.OpenStore(v1); err == nil {
		t.Fatal("bad fingerprint opened")
	}
	blobNonce, blob, err := SealBlob(fromHex, "int", []byte("payload"))
	if err != nil {
		t.Fatal(err)
	}
	plain, err := OpenBlob(fromHex, "int", blobNonce, blob)
	if err != nil || string(plain) != "payload" {
		t.Fatalf("blob %q %v", plain, err)
	}
	if _, err := OpenBlob(hashed, "int", blobNonce, blob); err == nil {
		t.Fatal("wrong kek opened the blob")
	}
}
