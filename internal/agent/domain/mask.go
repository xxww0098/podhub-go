package domain

// MaskEmail is billing/agents.rs mask_email.
// alice@example.com becomes a***@example.com. No '@' becomes ***.
// The head is the first Unicode scalar of the local part, which may be empty.
func MaskEmail(email string) string {
	local, domain, ok := stringsCut(email, '@')
	if !ok {
		return "***"
	}
	head := ""
	for _, r := range local {
		head = string(r)
		break
	}
	return head + "***@" + domain
}

func stringsCut(s string, sep byte) (before, after string, ok bool) {
	for i := 0; i < len(s); i++ {
		if s[i] == sep {
			return s[:i], s[i+1:], true
		}
	}
	return "", "", false
}
