package identity

import (
	"crypto/sha256"
	"net"
	"net/http"
	"strings"
)

const (
	pairFree     = 5
	ipFree       = 30
	maxDelaySecs = 15 * 60
	pruneBatch   = 32
)

func delaySecs(failures, free uint32) int32 {
	if failures <= free {
		return 0
	}
	shift := failures - free - 1
	if shift > 15 {
		shift = 15
	}
	value := int32(2) << shift
	if value < 0 || value > maxDelaySecs {
		return maxDelaySecs
	}
	return value
}

// ClientIP keeps the last X-Forwarded-For hop. Missing or unparseable is "direct".
func ClientIP(h http.Header) string {
	value := h.Get("X-Forwarded-For")
	if value == "" {
		return "direct"
	}
	parts := strings.Split(value, ",")
	var last string
	for i := len(parts) - 1; i >= 0; i-- {
		part := strings.TrimSpace(parts[i])
		if part != "" {
			last = part
			break
		}
	}
	if last == "" {
		return "direct"
	}
	if net.ParseIP(last) == nil {
		return "direct"
	}
	return last
}

func pairKey(email, ip string) ([32]byte, [32]byte) {
	return sha256.Sum256([]byte(email)), sha256.Sum256([]byte(ip))
}

func ipScope() [32]byte { return [32]byte{} }
