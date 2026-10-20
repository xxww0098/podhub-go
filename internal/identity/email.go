package identity

import "unicode"

// EmailShaped keeps values that can never receive mail out of the account table.
func EmailShaped(email string) bool {
	local, domain, ok := cutAt(email)
	if !ok || local == "" {
		return false
	}
	for _, r := range email {
		if unicode.IsSpace(r) {
			return false
		}
	}
	if stringsCount(domain, "@") > 0 {
		return false
	}
	labels := splitDot(domain)
	if len(labels) < 2 {
		return false
	}
	for _, label := range labels {
		if label == "" {
			return false
		}
	}
	return true
}

func cutAt(email string) (string, string, bool) {
	for i, r := range email {
		if r == '@' {
			return email[:i], email[i+1:], true
		}
	}
	return "", "", false
}

func stringsCount(s, sub string) int {
	n := 0
	for {
		i := indexOf(s, sub)
		if i < 0 {
			return n
		}
		n++
		s = s[i+len(sub):]
	}
}

func splitDot(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '.' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	return append(out, s[start:])
}

const maxOwnedWorkspaces int64 = 3

func projectAccountMode(owned, membership int64) string {
	if owned > 0 {
		return "owner"
	}
	if membership > 0 {
		return "member"
	}
	return "unaffiliated"
}

func workspaceLimitMessage(owned, limit int64) string {
	return "自建工作空间已达上限（" + itoa(owned) + "/" + itoa(limit) + "）；解散一个不再使用的自建空间可腾出名额，或换一个邮箱注册"
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
