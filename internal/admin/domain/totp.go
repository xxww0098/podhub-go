package domain

import (
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base32"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"net/url"
	"strings"
	"time"
)

const (
	recoveryAlphabet = "abcdefghijkmnpqrstuvwxyz23456789"
	totpDigits       = 6
	totpStep         = 30
	totpSkew         = 1
	secretLen        = 20
	recoveryCount    = 8
	recoveryLen      = 10
)

// RecoveryCode turns 10 random bytes into one code. Each byte is reduced mod 32.
func RecoveryCode(raw []byte) string {
	var b strings.Builder
	for i := 0; i < recoveryLen && i < len(raw); i++ {
		b.WriteByte(recoveryAlphabet[int(raw[i])%32])
	}
	return b.String()
}

// HashRecovery is SHA-256 of the trimmed lowercased code, hex encoded.
func HashRecovery(code string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(code))))
	return hex.EncodeToString(sum[:])
}

// SecretBase32 is uppercase RFC 4648 without padding.
func SecretBase32(secret []byte) string {
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(secret)
}

// OTPAuthURL builds the enroll URL. totp-rs 5.6 query order is not in the
// spec; this order is secret, issuer, algorithm, digits, period.
func OTPAuthURL(email string, userID int64, secret []byte) string {
	account := fmt.Sprintf("%s#%d", strings.ReplaceAll(email, ":", "_"), userID)
	label := "PodHub:" + account
	return "otpauth://totp/" + url.PathEscape(label) + "?secret=" + SecretBase32(secret) +
		"&issuer=" + url.QueryEscape("PodHub") + "&algorithm=SHA1&digits=6&period=30"
}

// Hotp is RFC 4226, 6 digits, SHA1.
func Hotp(secret []byte, counter uint64) string {
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], counter)
	mac := hmac.New(sha1.New, secret)
	_, _ = mac.Write(buf[:])
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	bin := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	code := bin % 1_000_000
	return fmt.Sprintf("%06d", code)
}

// TotpMatches allows skew of one 30-second step.
func TotpMatches(secret []byte, code string, now time.Time) bool {
	code = strings.TrimSpace(code)
	if len(code) != totpDigits {
		return false
	}
	counter := uint64(now.Unix()) / totpStep
	for delta := -totpSkew; delta <= totpSkew; delta++ {
		step := int64(counter) + int64(delta)
		if step < 0 {
			continue
		}
		if Hotp(secret, uint64(step)) == code {
			return true
		}
	}
	return false
}

// TotpAccount is the otpauth account label.
func TotpAccount(email string, userID int64) string {
	return fmt.Sprintf("%s#%d", strings.ReplaceAll(email, ":", "_"), userID)
}

// SecretSize is the random secret length.
func SecretSize() int { return secretLen }

// RecoveryN is the number of recovery codes.
func RecoveryN() int { return recoveryCount }
