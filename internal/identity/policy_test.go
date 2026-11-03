package identity

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/tests/parity"
)

func TestCSRFVectors(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	handler := CSRF(ok)
	cases := []struct {
		name   string
		method string
		header map[string]string
		status int
	}{
		{"same-origin cookie", http.MethodPost, map[string]string{"Cookie": "sid=" + token('a'), "Sec-Fetch-Site": "same-origin"}, 200},
		{"origin matches host", http.MethodPost, map[string]string{"Cookie": "sid=" + token('a'), "Origin": "http://app.example", "Host": "app.example"}, 200},
		{"cross-site", http.MethodPost, map[string]string{"Cookie": "sid=" + token('a'), "Sec-Fetch-Site": "cross-site"}, 403},
		{"same-site is not same-origin", http.MethodPost, map[string]string{"Cookie": "sid=" + token('a'), "Sec-Fetch-Site": "same-site"}, 403},
		{"evil origin", http.MethodPost, map[string]string{"Cookie": "sid=" + token('a'), "Origin": "https://evil.example", "Host": "app.example"}, 403},
		{"no cookie", http.MethodPost, map[string]string{"Origin": "https://evil.example", "Host": "app.example"}, 200},
		{"cookie without fetch headers", http.MethodPost, map[string]string{"Cookie": "sid=" + token('a')}, 200},
		{"get is untouched", http.MethodGet, map[string]string{"Cookie": "sid=" + token('a'), "Sec-Fetch-Site": "cross-site"}, 200},
		{"payment callback", http.MethodPost, map[string]string{"Sec-Fetch-Site": "cross-site"}, 200},
		// The retired stack cookie authenticates nothing, so it cannot be the
		// credential a cross-site write rides on either.
		{"retired sids alone", http.MethodPost, map[string]string{"Cookie": "sids=" + token('a'), "Sec-Fetch-Site": "cross-site"}, 200},
		{"empty cookie value", http.MethodPost, map[string]string{"Cookie": "sid=", "Origin": "https://evil.example"}, 200},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, "/api/auth/logout", nil)
			for key, value := range tc.header {
				req.Header.Set(key, value)
			}
			if host := tc.header["Host"]; host != "" {
				req.Host = host
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if tc.status == http.StatusForbidden {
				if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{
					Status: http.StatusForbidden,
					Body:   []byte(`{"code":"csrf_rejected","message":"跨站请求已被拒绝"}`),
				}); err != nil {
					t.Fatal(err)
				}
				if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
					t.Fatal("nosniff")
				}
				return
			}
			if rec.Code != tc.status {
				t.Fatalf("status %d", rec.Code)
			}
		})
	}
}

func TestClassifyPaths(t *testing.T) {
	cases := []struct {
		path, method string
		class        RouteClass
	}{
		{"/api/listing/submit", http.MethodPost, ClassRegularWrite},
		{"/api/media/objects/abc/png/probe", http.MethodPost, ClassMediaProbe},
		{"/api/media/objects/abc/png/presign", http.MethodPost, ClassControl},
		{"/api/media/objects/abc/png/presign-batch", http.MethodPost, ClassControl},
		{"/api/media/objects/abc/png/complete", http.MethodPut, ClassMediaUpload},
		{"/api/admin/supplier-dbs/9/uploads", http.MethodPost, ClassPsdUpload},
		{"/api/seller/delegate/assets", http.MethodPost, ClassMediaUpload},
		{"/api/avatars/me", http.MethodPut, ClassMediaUpload},
		{"/api/ai/ocr/completions", http.MethodPost, ClassOCR},
		{"/api/ai/chat/completions", http.MethodPost, ClassAI},
		{"/api/ai/v1/messages", http.MethodPost, ClassAI},
		{"/api/ai/responses", http.MethodPost, ClassAI},
		{"/api/listing/rows/1/heartbeat", http.MethodPost, ClassControl},
		{"/api/listing/rows/1/prepare/cancel", http.MethodPost, ClassControl},
		{"/api/listing/rows/1/cancel", http.MethodPost, ClassControl},
		{"/api/listing/rows/1/ai/settle", http.MethodPost, ClassControl},
		{"/api/listing/rows/1/ai/fail", http.MethodPost, ClassControl},
		{"/api/listing/rows/1/snapshot", http.MethodPost, ClassControl},
		{"/api/listing/rows/1/media/images", http.MethodPost, ClassControl},
		{"/api/listing/rows/1/media", http.MethodDelete, ClassControl},
		{"/api/ops/orders", http.MethodPost, ClassInteractiveRead},
		{"/api/ops/orders/mutate", http.MethodPost, ClassRegularWrite},
		{"/api/ops/chat/send", http.MethodPost, ClassRegularWrite},
		{"/api/workspaces/members", http.MethodGet, ClassInteractiveRead},
		{"/api/auth/login", http.MethodPost, ClassRegularWrite},
		{"/api/health", http.MethodGet, ClassInteractiveRead},
	}
	for _, tc := range cases {
		if got := Classify(tc.path, tc.method); got != tc.class {
			t.Fatalf("%s %s -> %s, want %s", tc.method, tc.path, got, tc.class)
		}
	}
}

func TestLoginThrottleMath(t *testing.T) {
	if delaySecs(1, pairFree) != 0 || delaySecs(pairFree, pairFree) != 0 {
		t.Fatal("free")
	}
	if delaySecs(pairFree+1, pairFree) != 2 || delaySecs(pairFree+2, pairFree) != 4 || delaySecs(pairFree+3, pairFree) != 8 {
		t.Fatal("shift")
	}
	if delaySecs(ipFree+1, ipFree) != 2 || delaySecs(10000, pairFree) != maxDelaySecs {
		t.Fatal("cap")
	}
	h := http.Header{}
	h.Set("X-Forwarded-For", "198.51.100.4, 203.0.113.50")
	if ClientIP(h) != "203.0.113.50" {
		t.Fatal(ClientIP(h))
	}
	h.Set("X-Forwarded-For", "not-an-ip")
	if ClientIP(h) != "direct" {
		t.Fatal("junk")
	}
	h.Set("X-Forwarded-For", "203.0.113.7, not-an-ip")
	if ClientIP(h) != "direct" {
		t.Fatal("trailing junk")
	}
	if ClientIP(http.Header{}) != "direct" {
		t.Fatal("missing")
	}
	h.Set("X-Forwarded-For", "2001:db8::1")
	if ClientIP(h) != "2001:db8::1" {
		t.Fatal(ClientIP(h))
	}
	leftEmail, leftIP := pairKey("left@pod.invalid", "203.0.113.8")
	rightEmail, sameIP := pairKey("right@pod.invalid", "203.0.113.8")
	if leftEmail == rightEmail || leftIP != sameIP || ipScope() == leftEmail {
		t.Fatal("keys")
	}
	caseEmail, caseIP := pairKey("  LEFT@Pod.Invalid  ", "203.0.113.8")
	if caseEmail != leftEmail || caseIP != leftIP {
		t.Fatal("email case variants must share login limits")
	}
}

func TestSessionCookie(t *testing.T) {
	cred := SessionCredentials(headerCookie("other=1; sid=" + token('a') + "; sids=" + token('a') + "." + token('b')))
	if cred.SID != token('a') || cred.Presented() != token('a') {
		t.Fatalf("%+v", cred)
	}
	junk := SessionCredentials(headerCookie("sid=" + token('a') + ".x; sids=" + token('b')))
	if junk.Presented() != "" {
		t.Fatalf("%+v", junk)
	}
	headers := headerCookie("sid=" + token('a'))
	headers.Set("Authorization", "Bearer "+token('z'))
	bearer := SessionCredentials(headers)
	if bearer.Presented() != token('z') || bearer.SID != token('a') {
		t.Fatal(bearer)
	}
	if got := SessionCredentials(headerCookie("sids=" + token('a'))).Presented(); got != "" {
		t.Fatalf("stack cookie must not authenticate: %q", got)
	}
	set := SessionCookies(token('a'))
	if len(set) != 2 || !strings.HasPrefix(set[0], SessionCookie+"="+token('a')+";") || !strings.HasPrefix(set[1], "sids=;") {
		t.Fatal(set)
	}
	cleared := SessionCookies("")
	if len(cleared) != 2 || !strings.HasPrefix(cleared[0], SessionCookie+"=;") || !strings.Contains(cleared[0], "Max-Age=0") {
		t.Fatal(cleared)
	}
	if !IsSessionToken(token('a')) || IsSessionToken(token('a')[:42]) || IsSessionToken("!"+token('a')[1:]) {
		t.Fatal("token shape")
	}
}

func TestEmailNameAndAccountMode(t *testing.T) {
	if !EmailShaped("ops@pod.com") || !EmailShaped("a.b+tag@sub.example.co.uk") {
		t.Fatal("valid")
	}
	for _, email := range []string{"not-an-email", "@pod.com", "ops@pod", "ops@pod..com", "ops@pod.com.", "ops @pod.com", "ops@a@pod.com", ""} {
		if EmailShaped(email) {
			t.Fatal(email)
		}
	}
	if _, err := validateName("王"); err != nil {
		t.Fatal(err)
	}
	if _, err := validateName(repeat("名", nameMaxChars)); err != nil {
		t.Fatal(err)
	}
	if _, err := validateName(repeat("名", nameMaxChars+1)); err == nil || err.Error() != "名字须为 1-24 个字符" {
		t.Fatal(err)
	}
	for _, name := range []string{"赌博大佬", "赌 博", "CASINO王", "在线Porn站", "卖冰毒", "枪手屠杀"} {
		if _, err := validateName(name); err == nil {
			t.Fatal(name)
		}
	}
	for _, name := range []string{"王小明", "店铺管理员", "Albert", "方法库", "阿赌的店"} {
		if _, err := validateName(name); err != nil {
			t.Fatal(name, err)
		}
	}
	if _, err := validateName("换\n行"); err == nil {
		t.Fatal("newline")
	}
	if !contains(cooldownMessage(20*3_600_000), "20 小时") || !contains(cooldownMessage(90_000), "2 分钟") {
		t.Fatal("cooldown")
	}
	if projectAccountMode(0, 0) != "unaffiliated" || projectAccountMode(1, 9) != "owner" || projectAccountMode(0, 1) != "member" {
		t.Fatal("mode")
	}
	msg := workspaceLimitMessage(3, 3)
	if !contains(msg, "已达上限（3/3）") || !contains(msg, "换一个邮箱") || !contains(msg, "解散") {
		t.Fatal(msg)
	}
	if maxOwnedWorkspaces != 3 {
		t.Fatal(maxOwnedWorkspaces)
	}
}

func TestDeterministicSessionToken(t *testing.T) {
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY", "parity-test-key")
	first := DeriveSessionToken("hash-a", "idem-1")
	second := DeriveSessionToken("hash-a", "idem-1")
	other := DeriveSessionToken("hash-b", "idem-1")
	if first != second || first == other || !IsSessionToken(first) {
		t.Fatal(first, other)
	}
	var pepper [32]byte
	copy(pepper[:], []byte("0123456789abcdef0123456789abcdef"))
	if deriveWith(pepper, "seed", "key") == deriveWith(pepper, "seed", "other") {
		t.Fatal("key changes the token")
	}
}

func TestAdmissionRefusalBodies(t *testing.T) {
	limits := DefaultLimits()
	limits.RegularWritePerUser = 1
	limits.Global = 8
	limits.UserWait = 20 * time.Millisecond
	limits.GlobalWait = 20 * time.Millisecond
	admission := NewAdmission(limits)
	release, status, _, _ := admission.Admit(7, ClassRegularWrite)
	if status != 0 || release == nil {
		t.Fatal(status)
	}
	_, status, message, retry := admission.Admit(7, ClassRegularWrite)
	if status != http.StatusTooManyRequests || message != "当前用户的并发预算已用尽，请稍后重试" || retry < 1 || retry > 30 {
		t.Fatalf("%d %s %d", status, message, retry)
	}
	release()
	// OCR shares the AI budget and does not take the process ceiling.
	ocrRelease, status, _, _ := admission.Admit(9, ClassOCR)
	if status != 0 {
		t.Fatal(status)
	}
	defer ocrRelease()
	held := 0
	for i := 0; i < limits.Global; i++ {
		rel, st, _, _ := admission.Admit(int64(100+i), ClassRegularWrite)
		if st != 0 {
			break
		}
		held++
		defer rel()
	}
	if held == 0 {
		t.Fatal("global slots")
	}
}

func token(marker byte) string {
	out := make([]byte, 43)
	out[0] = marker
	for i := 1; i < len(out); i++ {
		out[i] = 'a'
	}
	return string(out)
}

func headerCookie(value string) http.Header {
	h := http.Header{}
	h.Set("Cookie", value)
	return h
}

func repeat(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}

func contains(s, sub string) bool { return indexOf(s, sub) >= 0 }
