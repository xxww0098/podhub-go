package domain

import (
	"strings"
	"testing"
	"time"
)

func TestRecoveryAndTotp(t *testing.T) {
	code := RecoveryCode([]byte{0, 31, 32, 10, 11, 12, 13, 14, 15, 16})
	if len(code) != 10 || strings.ContainsAny(code, "lo01") {
		t.Fatal(code)
	}
	if code[0] != 'a' || code[1] != '9' || code[2] != 'a' {
		t.Fatal(code)
	}
	if HashRecovery(" AbC ") != HashRecovery("abc") || len(HashRecovery("abc")) != 64 {
		t.Fatal("hash")
	}
	secret := []byte("12345678901234567890")
	url := OTPAuthURL("a:b@pod.example", 7, secret)
	if !strings.HasPrefix(url, "otpauth://totp/") || !strings.Contains(url, "secret=") || !strings.Contains(url, "issuer=PodHub") {
		t.Fatal(url)
	}
	if !strings.Contains(url, "a_b") || !strings.Contains(url, "%237") && !strings.Contains(url, "#7") {
		t.Fatal(url)
	}
	now := time.Unix(1_700_000_000, 0).UTC()
	token := Hotp(secret, uint64(now.Unix())/30)
	if !TotpMatches(secret, token, now) || TotpMatches(secret, "000000", now.Add(5*time.Minute)) {
		t.Fatal("match")
	}
	if TotpAccount("a:b@x", 3) != "a_b@x#3" {
		t.Fatal(TotpAccount("a:b@x", 3))
	}
}
