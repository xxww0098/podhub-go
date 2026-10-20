package domain

import "testing"

func TestCrossOriginWrite(t *testing.T) {
	token := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	cases := []struct {
		name   string
		method string
		cookie string
		site   string
		origin string
		host   string
		reject bool
	}{
		{"same-origin", "POST", "sid=" + token, "same-origin", "", "", false},
		{"origin matches", "PUT", "sid=" + token, "", "http://app.example", "app.example", false},
		{"cross-site", "POST", "sid=" + token, "cross-site", "", "", true},
		{"same-site is not same-origin", "POST", "sid=" + token, "same-site", "", "", true},
		{"evil origin", "DELETE", "sid=" + token, "", "https://evil.example", "app.example", true},
		{"no fetch headers", "POST", "sid=" + token, "", "", "", false},
		{"get", "GET", "sid=" + token, "cross-site", "", "", false},
		{"sids", "POST", "sids=" + token, "cross-site", "", "", true},
		{"empty cookie", "POST", "sid=", "", "https://evil.example", "app.example", false},
		{"bearer has no cookie", "POST", "", "cross-site", "", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := CrossOriginWrite(tc.method, tc.cookie, tc.site, tc.origin, tc.host); got != tc.reject {
				t.Fatal(got)
			}
		})
	}
}
