package domain

import "testing"

func TestSourceGrantUsesPublicAccount(t *testing.T) {
	got, err := DecodeSourceAccountGrant([]byte(`{"account_uuid":" account-7 "}`))
	if err != nil || got != "account-7" {
		t.Fatalf("got %q, %v", got, err)
	}
	for _, body := range []string{`{}`, `null`, `{"account_uuid":""}`, `{"account_uuid":7}`, `{"userId":7}`, `{"account_uuid":"u","extra":true}`} {
		if _, err := DecodeSourceAccountGrant([]byte(body)); err == nil {
			t.Fatalf("accepted %s", body)
		}
	}
}
