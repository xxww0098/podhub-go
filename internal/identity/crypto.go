package identity

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"sync"

	"golang.org/x/crypto/bcrypt"

	"github.com/xxww0098/podhub-go/internal/platform/config"
)

const (
	maxPasswordBytes = 72
	bcryptCost       = 12
)

func randomToken() (string, error) {
	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf[:]), nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func newPublicID() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	value := hex.EncodeToString(buf[:])
	return value[0:8] + "-" + value[8:12] + "-" + value[12:16] + "-" + value[16:20] + "-" + value[20:32], nil
}

var sessionPepperOnce sync.Once
var sessionPepper [32]byte

func pepper() [32]byte {
	sessionPepperOnce.Do(func() {
		hash := sha256.New()
		hash.Write([]byte("podhub-session-pepper-v1\x00"))
		if secret, ok := config.SessionPepperSecret(); ok {
			hash.Write([]byte(secret))
		} else {
			var random [32]byte
			_, _ = rand.Read(random[:])
			hash.Write(random[:])
		}
		copy(sessionPepper[:], hash.Sum(nil))
	})
	return sessionPepper
}

// DeriveSessionToken is the labeled SHA-256 used when Idempotency-Key is present.
// seed is the stored password hash. key is the header value.
func DeriveSessionToken(seed, key string) string {
	return deriveWith(pepper(), seed, key)
}

func deriveWith(pepper [32]byte, seed, key string) string {
	hash := sha256.New()
	hash.Write([]byte("podhub-auth-v2\x00"))
	hash.Write([]byte("session"))
	hash.Write([]byte{0})
	hash.Write(pepper[:])
	hash.Write([]byte{0})
	hash.Write([]byte(seed))
	hash.Write([]byte{0})
	hash.Write([]byte(key))
	sum := hash.Sum(nil)
	return base64.RawURLEncoding.EncodeToString(sum)
}

func hashPassword(password string) (string, error) {
	raw, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func verifyPassword(password, hash string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

var dummyHashOnce sync.Once
var dummyHash string

func dummyPasswordHash() string {
	dummyHashOnce.Do(func() {
		raw, err := bcrypt.GenerateFromPassword([]byte("timing-attack-mitigation-placeholder"), bcryptCost)
		if err != nil {
			dummyHash = "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinval"
			return
		}
		dummyHash = string(raw)
	})
	return dummyHash
}

func performDummyVerify(password string) {
	_ = verifyPassword(password, dummyPasswordHash())
}
