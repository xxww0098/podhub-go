package seal

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestStoredPaymentOptionalAndStrict(t *testing.T) {
	plain := []byte(`{"schemaVersion":1,"aiAccounts":[],"aiDefaultModel":"","storageBuckets":[]}`)
	snap, err := ParseSnapshot(plain)
	if err != nil || snap.Payment != nil {
		t.Fatal(err, snap.Payment)
	}
	again, err := json.Marshal(snap)
	if err != nil || strings.Contains(string(again), `"payment"`) {
		t.Fatalf("nil payment must be omitted: %s %v", again, err)
	}
	nullPay := []byte(`{"schemaVersion":1,"aiAccounts":[],"aiDefaultModel":"","storageBuckets":[],"payment":null}`)
	snap, err = ParseSnapshot(nullPay)
	if err != nil || snap.Payment != nil {
		t.Fatal(err, snap.Payment)
	}
	if _, err := ParseSnapshot([]byte(`{"schemaVersion":1,"aiAccounts":[],"aiDefaultModel":"","storageBuckets":[],"payment":{}}`)); err == nil || err.Error() != "已加密的连接配置快照无法解析" {
		t.Fatal(err)
	}
	if _, err := ParseSnapshot([]byte(`{"schemaVersion":1,"aiAccounts":[],"aiDefaultModel":"","storageBuckets":[],"payment":{"providers":[],"extra":1}}`)); err == nil {
		t.Fatal("unknown payment field")
	}
	if _, err := ParseSnapshot([]byte(`{"schemaVersion":1,"aiAccounts":[],"aiDefaultModel":"","storageBuckets":[],"payment":{"providers":[{"provider":"easypay","enabled":true}]}}`)); err == nil {
		t.Fatal("missing values")
	}
	body := []byte(`{"schemaVersion":1,"aiAccounts":[],"aiDefaultModel":"","storageBuckets":[],"payment":{"providers":[{"provider":"easypay","enabled":true,"values":{"pid":"1","apiBase":"https://pay.example"}}]}}`)
	snap, err = ParseSnapshot(body)
	if err != nil || snap.Payment == nil || snap.Payment.Providers[0].Values["pid"] != "1" {
		t.Fatal(err)
	}
	out, err := json.Marshal(snap.Payment.Providers[0])
	if err != nil || string(out) != `{"provider":"easypay","enabled":true,"values":{"apiBase":"https://pay.example","pid":"1"}}` {
		t.Fatalf("%s %v", out, err)
	}
}
