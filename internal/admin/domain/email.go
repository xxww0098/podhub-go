package domain

import "unicode"

// EmailShaped is identity::is_email_shaped: a local part, a domain of at
// least two non-empty labels, and no extra '@' or spaces.
func EmailShaped(email string) bool {
	at := -1
	for i, r := range email {
		if unicode.IsSpace(r) {
			return false
		}
		if r == '@' {
			if at >= 0 {
				return false
			}
			at = i
		}
	}
	if at <= 0 || at == len(email)-1 {
		return false
	}
	domain := email[at+1:]
	labels := 0
	start := 0
	for i := 0; i <= len(domain); i++ {
		if i == len(domain) || domain[i] == '.' {
			if i == start {
				return false
			}
			labels++
			start = i + 1
		}
	}
	return labels >= 2
}
