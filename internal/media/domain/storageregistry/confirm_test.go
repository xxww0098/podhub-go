package storageregistry

import (
	"strings"
	"testing"
	"time"
)

func TestConfirmFullObjectProof(t *testing.T) {
	digest := strings.Repeat("a", 64)
	now := time.Now()
	for _, tc := range []struct {
		name, head, readback string
		want                 bool
	}{
		{"head SHA256", digest, "", true},
		{"complete GET SHA256", "", digest, true},
		{"both proofs", digest, digest, true},
		{"neither proof", "", "", false},
		{"contradictory HEAD", strings.Repeat("b", 64), digest, false},
		{"corrupt GET", digest, strings.Repeat("b", 64), false},
		{"CRC64 is not SHA256", "", "abcd1234", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := DecideConfirm(ConfirmInput{Claim: Claim{SHA256Hex: digest, ByteLength: 7, ContentType: "image/jpeg"}, Now: now, ExpiresAt: now.Add(time.Minute), HeadLength: 7, HeadType: "image/jpeg", HeadSHA256Hex: tc.head, ReadbackSHA256Hex: tc.readback}, nil)
			if (err == nil) != tc.want {
				t.Fatalf("confirmation allowed=%v, want %v: %v", err == nil, tc.want, err)
			}
		})
	}
}
