package identity

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/tests/parity"
)

func TestRoleAlgebraMatchesRust(t *testing.T) {
	for _, role := range []Role{RoleUser, RoleAdmin, RoleSuperAdmin} {
		parsed, err := ParseRole(role.String())
		if err != nil || parsed != role || RoleFromStored(role.String()) != role {
			t.Fatalf("%s", role)
		}
	}
	if role, err := ParseRole(" Super_Admin "); err != nil || role != RoleSuperAdmin {
		t.Fatal(role, err)
	}
	if role, err := ParseRole("ADMIN"); err != nil || role != RoleAdmin {
		t.Fatal(role, err)
	}
	for _, raw := range []string{"", "   ", "superadmin", "root", "administrator"} {
		if RoleFromStored(raw) != RoleUser || RoleFromStored(raw).IsStaff() {
			t.Fatalf("%q", raw)
		}
	}
	if RoleUser.IsStaff() || !RoleAdmin.IsStaff() || !RoleSuperAdmin.IsStaff() || RoleAdmin.IsSuperAdmin() {
		t.Fatal("staff cut")
	}
	for _, role := range []Role{RoleAdmin, RoleSuperAdmin} {
		if err := Authorize(RoleAdmin, Change{Kind: "create", Role: role}, RoleUser, false); err != DenyCannotAssign {
			t.Fatal(err)
		}
	}
	if err := Authorize(RoleAdmin, Change{Kind: "create", Role: RoleUser}, RoleUser, false); err != nil {
		t.Fatal(err)
	}
	for _, target := range []Role{RoleAdmin, RoleSuperAdmin} {
		if err := Authorize(RoleAdmin, Change{Kind: "edit"}, target, false); err != DenyCannotMutate {
			t.Fatal(err)
		}
	}
	if err := Authorize(RoleSuperAdmin, Change{Kind: "create", Role: RoleAdmin}, RoleUser, false); err != nil {
		t.Fatal(err)
	}
	if err := AuthorizeUpdate(RoleSuperAdmin, RoleUser, RoleAdmin, false, false); err != nil {
		t.Fatal(err)
	}
	for _, actor := range []Role{RoleUser, RoleAdmin, RoleSuperAdmin} {
		if err := Authorize(actor, Change{Kind: "create", Role: RoleSuperAdmin}, RoleUser, false); err != DenyCannotAssign {
			t.Fatal(actor, err)
		}
	}
	if CanAssign(RoleSuperAdmin, RoleSuperAdmin) || !CanAssign(RoleSuperAdmin, RoleAdmin) {
		t.Fatal("assign")
	}
	if err := AuthorizeUpdate(RoleSuperAdmin, RoleSuperAdmin, RoleAdmin, false, true); err != DenyLastSuperAdmin {
		t.Fatal(err)
	}
	if err := Authorize(RoleSuperAdmin, Change{Kind: "disable"}, RoleSuperAdmin, true); err != DenyLastSuperAdmin {
		t.Fatal(err)
	}
	if err := Authorize(RoleSuperAdmin, Change{Kind: "edit"}, RoleSuperAdmin, true); err != nil {
		t.Fatal(err)
	}
	if err := Authorize(RoleUser, Change{Kind: "create", Role: RoleUser}, RoleUser, false); err != DenyCannotAssign {
		t.Fatal(err)
	}
	if err := Authorize(RoleUser, Change{Kind: "edit"}, RoleUser, false); err != DenyCannotMutate {
		t.Fatal(err)
	}
}

func TestWorkspaceMatrixMatchesRust(t *testing.T) {
	if WorkspaceRoleFromStored("member") != WorkspaceOperator || WorkspaceRoleFromStored("admin") != WorkspaceManager {
		t.Fatal("stored")
	}
	if WorkspaceRoleFromStored("") != WorkspaceViewer || WorkspaceOperator.Stored() != "member" {
		t.Fatal("fallback")
	}
	for _, raw := range []string{"", "root", "super_admin", "operator", "invalid"} {
		if _, ok := ParseWorkspaceRole(raw); ok || StoreVisible(raw, ptr(int64(2)), 2) || CanManageStored(raw) {
			t.Fatalf("%q", raw)
		}
	}
	if role, ok := ParseWorkspaceRole("viewer"); !ok || role != WorkspaceViewer {
		t.Fatal("viewer")
	}
	if role, ok := ParseWorkspaceRole(" ADMIN "); !ok || role != WorkspaceManager {
		t.Fatal("admin alias")
	}
	for _, raw := range []string{"owner", "manager", "admin"} {
		if !CanManageStored(raw) {
			t.Fatal(raw)
		}
	}
	for _, raw := range []string{"member", "reviewer", "viewer"} {
		if CanManageStored(raw) {
			t.Fatal(raw)
		}
	}
	if !WorkspaceOwner.Allows(CapBillingManage) || WorkspaceManager.Allows(CapBillingManage) || WorkspaceOperator.Allows(CapBillingManage) {
		t.Fatal("billing")
	}
	if !WorkspaceOwner.Allows(CapStoreCredentialRotate) || WorkspaceManager.Allows(CapStoreCredentialRotate) {
		t.Fatal("rotate")
	}
	if !WorkspaceManager.Allows(CapWorkspaceManage) || !WorkspaceOperator.Allows(CapListingPublish) || !WorkspaceOperator.Allows(CapListingSubmit) {
		t.Fatal("publish")
	}
	if WorkspaceViewer.Allows(CapListingPublish) || WorkspaceReviewer.Allows(CapListingPublish) || !WorkspaceReviewer.Allows(CapListingReview) {
		t.Fatal("review")
	}
	if !WorkspaceViewer.Allows(CapGalleryRead) || WorkspaceViewer.Allows(CapGalleryWrite) || !WorkspaceOperator.Allows(CapGalleryWrite) {
		t.Fatal("gallery")
	}
	if WorkspaceOperator.Allows(CapGalleryDelete) || !WorkspaceManager.Allows(CapGalleryDelete) || !WorkspaceManager.Allows(CapAuditRead) {
		t.Fatal("delete")
	}
	if !WorkspaceOwner.MayInvite(WorkspaceManager) || !WorkspaceOwner.MayInvite(WorkspaceOperator) || !WorkspaceManager.MayInvite(WorkspaceOperator) || WorkspaceManager.MayInvite(WorkspaceManager) || WorkspaceOperator.MayInvite(WorkspaceOperator) {
		t.Fatal("invite")
	}
	if !WorkspaceOwner.MayRemoveMember(WorkspaceManager, false) || !WorkspaceOwner.MayRemoveMember(WorkspaceOperator, false) || WorkspaceOwner.MayRemoveMember(WorkspaceOwner, false) || WorkspaceOwner.MayRemoveMember(WorkspaceOperator, true) {
		t.Fatal("remove")
	}
	if !WorkspaceManager.MayRemoveMember(WorkspaceOperator, false) || WorkspaceManager.MayRemoveMember(WorkspaceManager, false) {
		t.Fatal("manager remove")
	}
	if WorkspaceOwner.Allows(CapWorkspaceLeave) || !WorkspaceManager.Allows(CapWorkspaceLeave) || !WorkspaceOperator.Allows(CapWorkspaceLeave) {
		t.Fatal("leave")
	}
	if !WorkspaceOwner.MayChangeRole(WorkspaceManager, false) || !WorkspaceOwner.MayChangeRole(WorkspaceOperator, false) || WorkspaceOwner.MayChangeRole(WorkspaceOwner, false) || WorkspaceOwner.MayChangeRole(WorkspaceOperator, true) {
		t.Fatal("change")
	}
	if WorkspaceManager.MayChangeRole(WorkspaceOperator, false) || WorkspaceOperator.MayChangeRole(WorkspaceManager, false) {
		t.Fatal("non-owner change")
	}
	if got := join(WorkspaceOwner.AssignableRoles(WorkspaceManager, false)); got != "member" {
		t.Fatal(got)
	}
	if got := join(WorkspaceOwner.AssignableRoles(WorkspaceOperator, false)); got != "manager" {
		t.Fatal(got)
	}
	if len(WorkspaceOwner.AssignableRoles(WorkspaceOwner, false)) != 0 || len(WorkspaceManager.AssignableRoles(WorkspaceOperator, false)) != 0 {
		t.Fatal("empty assignable")
	}
	if StoreVisible("member", nil, 2) || !StoreVisible("member", ptr(int64(2)), 2) || StoreVisible("member", ptr(int64(3)), 2) {
		t.Fatal("operator stores")
	}
	if !StoreVisible("manager", nil, 2) || !StoreVisible("owner", ptr(int64(3)), 2) {
		t.Fatal("manager stores")
	}
	if !(AssigneeKeyGrant{}).MayManageKey(true, false) || (AssigneeKeyGrant{}).MayManageKey(false, true) {
		t.Fatal("owner bypass")
	}
	if !(AssigneeKeyGrant{Manage: true}).MayManageKey(false, true) || (AssigneeKeyGrant{Manage: true}).MayManageKey(false, false) {
		t.Fatal("switch")
	}
	if WorkspaceID(0).Active() || !WorkspaceID(4).Active() {
		t.Fatal("workspace id")
	}
	if PendingInviteLimit(1) != 10 || PendingInviteLimit(5) != 10 || PendingInviteLimit(6) != 12 {
		t.Fatal("invite limit")
	}
	if MembershipDirectoryStatus("active", true, true) != "manual_disabled" || MembershipDirectoryStatus("active", false, true) != "quota_suspended" || MembershipDirectoryStatus("active", false, false) != "active" {
		t.Fatal("status")
	}
}

func TestPlatformPermissionsAreClosed(t *testing.T) {
	for _, permission := range PlatformPermissions {
		if permission.Allows(RoleUser) || !permission.Allows(RoleSuperAdmin) {
			t.Fatal(permission)
		}
	}
	for _, permission := range []PlatformPermission{PermManageSupplierCatalog, PermManageDelegateOrders, PermManageSupplierAccounts, PermManageSupplierWithdrawals} {
		if !permission.Allows(RoleAdmin) || permission.Refusal() != "需要平台管理员权限" {
			t.Fatal(permission)
		}
	}
	if PermManagePlatform.Allows(RoleAdmin) || PermObserveTenantBusiness.Allows(RoleAdmin) {
		t.Fatal("admin is not super")
	}
	if PermManagePlatform.Refusal() != "需要超级管理员权限" {
		t.Fatal("refusal")
	}
	for _, stored := range []string{"", "root", "superadmin", "owner", "manager", "member"} {
		for _, permission := range PlatformPermissions {
			if permission.Allows(RoleFromStored(stored)) {
				t.Fatalf("%s %v", stored, permission)
			}
		}
	}
}

func TestCapabilityMatrixTable(t *testing.T) {
	// Columns are owner, manager, operator, reviewer, viewer.
	rows := []struct {
		capability Capability
		allow      string
	}{
		{CapWorkspaceRead, "11111"},
		{CapWorkspaceManage, "11000"},
		{CapWorkspaceProfileManage, "10000"},
		{CapWorkspaceDissolve, "10000"},
		{CapWorkspaceLeave, "01111"},
		{CapMemberInvite, "11000"},
		{CapMemberManage, "11000"},
		{CapBillingRead, "10000"},
		{CapBillingManage, "10000"},
		{CapUsageRead, "11111"},
		{CapBudgetManage, "10000"},
		{CapStoreRead, "11111"},
		{CapStoreManage, "11000"},
		{CapStoreCredentialRotate, "10000"},
		{CapPresetRead, "11111"},
		{CapPresetManage, "11000"},
		{CapListingPrepare, "11110"},
		{CapListingReview, "11110"},
		{CapListingPublish, "11100"},
		{CapListingSubmit, "11100"},
		{CapListingReconcile, "11110"},
		{CapGalleryRead, "11111"},
		{CapGalleryWrite, "11110"},
		{CapGalleryDelete, "11000"},
		{CapAiUse, "11111"},
		{CapOcrUse, "11111"},
		{CapAuditRead, "11000"},
		{CapAuditExport, "10000"},
		{CapWarehouseWrite, "11000"},
	}
	roles := []WorkspaceRole{WorkspaceOwner, WorkspaceManager, WorkspaceOperator, WorkspaceReviewer, WorkspaceViewer}
	if len(rows) != len(AllCapabilities) {
		t.Fatalf("matrix rows %d", len(rows))
	}
	seen := map[Capability]bool{}
	for _, row := range rows {
		seen[row.capability] = true
		if len(row.allow) != len(roles) {
			t.Fatal(row.capability)
		}
		for i, role := range roles {
			want := row.allow[i] == '1'
			got := role.Allows(row.capability)
			if got != want {
				t.Fatalf("role %d capability %d got %v want %v", role, row.capability, got, want)
			}
		}
	}
	for _, capability := range AllCapabilities {
		if !seen[capability] {
			t.Fatalf("missing %d", capability)
		}
	}
}

func TestCapabilityMatrixIsTotal(t *testing.T) {
	roles := []WorkspaceRole{WorkspaceOwner, WorkspaceManager, WorkspaceOperator, WorkspaceReviewer, WorkspaceViewer}
	if len(AllCapabilities) != 29 {
		t.Fatalf("capabilities %d", len(AllCapabilities))
	}
	for _, role := range roles {
		for _, capability := range AllCapabilities {
			_ = role.Allows(capability)
		}
	}
	// Everyone reads. Only the owner bills. Viewer does not prepare.
	for _, role := range roles {
		if !role.Allows(CapWorkspaceRead) || !role.Allows(CapAiUse) || !role.Allows(CapOcrUse) {
			t.Fatal(role)
		}
	}
	if WorkspaceViewer.Allows(CapListingPrepare) || !WorkspaceReviewer.Allows(CapListingPrepare) {
		t.Fatal("prepare")
	}
}

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
		{"sids alone", http.MethodPost, map[string]string{"Cookie": "sids=" + token('a'), "Sec-Fetch-Site": "cross-site"}, 403},
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
		{"/api/listing/templates", http.MethodPost, ClassPsdUpload},
		{"/api/listing/templates/1/confirm", http.MethodPost, ClassPsdUpload},
		{"/api/listing/templates/1/multipart/part", http.MethodPost, ClassPsdUpload},
		{"/api/admin/supplier-dbs/9/uploads", http.MethodPost, ClassPsdUpload},
		{"/api/seller/delegate/assets", http.MethodPost, ClassMediaUpload},
		{"/api/avatars/me", http.MethodPut, ClassMediaUpload},
		{"/api/ai/ocr/completions", http.MethodPost, ClassOCR},
		{"/api/ai/chat/completions", http.MethodPost, ClassAI},
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
}

func TestSessionStack(t *testing.T) {
	cred := SessionCredentials(headerCookie("other=1; sid=" + token('a') + "; sids=" + token('a') + "." + token('b') + "." + token('c')))
	if cred.SID != token('a') || len(cred.Stack) != 3 || cred.Stack[2] != token('c') {
		t.Fatalf("%+v", cred)
	}
	junk := SessionCredentials(headerCookie("sids=" + token('a') + ".junk." + token('a') + ".x; sid=" + token('a')))
	if len(junk.Stack) != 1 {
		t.Fatal(junk.Stack)
	}
	headers := headerCookie("sid=" + token('a'))
	headers.Set("Authorization", "Bearer "+token('z'))
	bearer := SessionCredentials(headers)
	if bearer.Presented() != token('z') || bearer.SID != token('a') {
		t.Fatal(bearer)
	}
	order := SessionCredentials(headerCookie("sid=" + token('b') + "; sids=" + token('a') + "." + token('b')))
	cands := order.Candidates()
	if len(cands) != 2 || cands[0] != token('b') || cands[1] != token('a') {
		t.Fatal(cands)
	}
	merged := MergedStack([]StackEntry{{token('a'), 1}, {token('b'), 2}, {token('c'), 1}}, 1, token('d'))
	if len(merged) != 2 || merged[0] != token('b') || merged[1] != token('d') {
		t.Fatal(merged)
	}
	var full []StackEntry
	for i := 0; i < maxStackedSessions; i++ {
		full = append(full, StackEntry{token(byte('a' + i)), int64(i + 1)})
	}
	overflow := MergedStack(full, 99, token('z'))
	if len(overflow) != maxStackedSessions || overflow[0] != token('b') || overflow[len(overflow)-1] != token('z') {
		t.Fatal(overflow)
	}
	revokeCred := SessionCredentials(headerCookie("sid=" + token('b') + "; sids=" + token('a') + "." + token('b') + "." + token('c')))
	sid, stack := AfterRevoke(revokeCred, []string{token('b')})
	if sid != token('c') || len(stack) != 2 || stack[0] != token('a') {
		t.Fatal(sid, stack)
	}
	keep := SessionCredentials(headerCookie("sid=" + token('a') + "; sids=" + token('a') + "." + token('b')))
	sid, stack = AfterRevoke(keep, []string{token('b')})
	if sid != token('a') || len(stack) != 1 {
		t.Fatal(sid, stack)
	}
	last := SessionCredentials(headerCookie("sid=" + token('a') + "; sids=" + token('a')))
	sid, stack = AfterRevoke(last, []string{token('a')})
	if sid != "" || len(stack) != 0 {
		t.Fatal(sid, stack)
	}
	only := SessionCredentials(headerCookie("sid=" + token('a')))
	if got := only.StackCandidates(); len(got) != 1 || got[0] != token('a') {
		t.Fatal(got)
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

func ptr(n int64) *int64 { return &n }

func join(parts []string) string {
	if len(parts) == 0 {
		return ""
	}
	return parts[0]
}

func repeat(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}

func contains(s, sub string) bool { return indexOf(s, sub) >= 0 }
