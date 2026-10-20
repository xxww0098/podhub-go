package domain

import "io"

// WithdrawalAlphabet is generate_withdrawal_public_id's alphabet.
// Length 32, so a uniform byte modulo 32 is unbiased.
const WithdrawalAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

// WithdrawalPublicID is `wd_` plus 12 alphabet characters.
// rand supplies the raw bytes. A short read is an error.
func WithdrawalPublicID(rand io.Reader) (string, error) {
	buf := make([]byte, 12)
	if _, err := io.ReadFull(rand, buf); err != nil {
		return "", err
	}
	out := make([]byte, 12)
	for i, b := range buf {
		out[i] = WithdrawalAlphabet[int(b)%len(WithdrawalAlphabet)]
	}
	return "wd_" + string(out), nil
}
