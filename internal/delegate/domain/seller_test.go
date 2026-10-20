package domain

import (
	"strings"
	"testing"
	"time"
)

func TestValidateFile(t *testing.T) {
	sha := strings.Repeat("ab", 32)
	ext, got, err := ValidateFile("  "+strings.ToUpper(sha)+" ", "image/png", "a.JPEG", 1)
	if err != nil || ext != "jpg" || got != sha {
		t.Fatalf("ext %s sha %s err %v", ext, got, err)
	}
	if _, _, err := ValidateFile("zz", "image/png", "a.png", 1); err == nil || err.Error() != "sha256 无效" {
		t.Fatal(err)
	}
	if _, _, err := ValidateFile(sha, "image/png", "a.png", 0); err == nil || !strings.Contains(err.Error(), "524288000") {
		t.Fatal(err)
	}
	if _, _, err := ValidateFile(sha, "image/png", "a.png", MaxAssetBytes+1); err == nil {
		t.Fatal("oversize")
	}
	if _, _, err := ValidateFile(sha, "image/png", "a.gif", 1); err == nil || err.Error() != "只支持 jpg/png/webp/psd 原图文件" {
		t.Fatal(err)
	}
	if _, _, err := ValidateFile(sha, "text/plain", "a.png", 1); err == nil || err.Error() != "文件类型与内容不符" {
		t.Fatal(err)
	}
	if _, _, err := ValidateFile(sha, "application/octet-stream", "a.psd", 1); err != nil {
		t.Fatal(err)
	}
	if MimeMatchesExtension("", "psd") || MimeMatchesExtension(strings.Repeat("a", 129), "psd") {
		t.Fatal("mime length")
	}
}

func TestAssetKey(t *testing.T) {
	prefix, err := NormalizePrefix(" /team/a/ ")
	if err != nil || prefix != "team/a/" {
		t.Fatal(prefix, err)
	}
	if _, err := NormalizePrefix(`a\b`); err == nil {
		t.Fatal("backslash")
	}
	if _, err := NormalizePrefix("a/../b"); err == nil {
		t.Fatal("dotdot")
	}
	key := AssetKey(prefix, 7, strings.Repeat("ab", 32), "png")
	if err := KeyMatchesReceipt(key, prefix, 7, strings.Repeat("ab", 32), "png"); err != nil {
		t.Fatal(err)
	}
	if err := ParseAssetKey(AssetKey("", 8, strings.Repeat("ab", 32), "png"), prefix, 7); err == nil {
		t.Fatal("other org")
	}
	if err := KeyMatchesReceipt(AssetKey(prefix, 7, strings.Repeat("cd", 32), "png"), prefix, 7, strings.Repeat("ab", 32), "png"); err == nil || err.Error() != "对象键与文件内容声明不一致" {
		t.Fatal(err)
	}
}

func TestReplayAndNotes(t *testing.T) {
	verified := int64(1)
	if err := ReplayAsset("b", "b", "s", "image/png", 10, &verified, "s", "image/png", 10); err != nil {
		t.Fatal(err)
	}
	if err := ReplayAsset("a", "b", "s", "image/png", 10, &verified, "s", "image/png", 10); err == nil {
		t.Fatal("binding")
	}
	if err := ReplayAsset("b", "b", "s", "image/png", 10, nil, "s", "image/png", 10); err == nil {
		t.Fatal("unverified")
	}
	if _, err := BindingNote(strings.Repeat("字", 2001)); err == nil {
		t.Fatal("note")
	}
	if _, err := SellerNote("  ok  "); err != nil {
		t.Fatal(err)
	}
	if _, err := IdempotencyKey("  ", true); err == nil {
		t.Fatal("empty key")
	}
	if _, err := IdempotencyKey(strings.Repeat("k", 65), true); err == nil {
		t.Fatal("long key")
	}
}

func TestCursorMergeAndSelect(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	raw := EncodeCursor(9, id)
	ms, got, ok := DecodeCursor(raw)
	if !ok || ms != 9 || got != id {
		t.Fatalf("%d %s %v", ms, got, ok)
	}
	if _, _, ok := DecodeCursor("nope"); ok {
		t.Fatal("bad cursor")
	}
	lines := AssembleLines([]PostingProduct{
		{OfferID: "  ", Quantity: 2},
		{OfferID: " B ", Quantity: 0},
		{OfferID: "A", Quantity: 3},
		{OfferID: "A", Quantity: 9},
	})
	if len(lines) != 2 || lines[0].OfferID != "B" || lines[0].Quantity != 1 || lines[1].Quantity != 3 {
		t.Fatalf("%+v", lines)
	}
	picked, err := SelectLines(lines, []string{"Z", "A"}, true)
	if err == nil || !strings.Contains(err.Error(), "Z") {
		t.Fatal(err)
	}
	picked, err = SelectLines(lines, nil, false)
	if err != nil || len(picked) != 2 {
		t.Fatal(err, picked)
	}
	if _, err := SelectLines(lines, []string{"  "}, true); err == nil {
		t.Fatal("blank selection")
	}
	ready := map[string]struct{}{"A": {}, "B": {}}
	state, covered, orderID, _ := MergeState(lines, nil, ready)
	if state != "ready" || covered != 0 || orderID != "" {
		t.Fatal(state)
	}
	state, covered, _, _ = MergeState(lines[:1], &OpenOrder{OrderID: "o", State: "ready", Offers: map[string]struct{}{"A": {}}}, ready)
	if state != "partial" || covered != 0 {
		t.Fatalf("%s %d", state, covered)
	}
	state, covered, _, _ = MergeState(nil, nil, ready)
	if state != "needs_setup" {
		t.Fatal(state)
	}
	if Badge(true) != "delegated" || Badge(false) != "none" {
		t.Fatal("badge")
	}
	offers := CoverOffers([]string{" b ", "a", "a", " "})
	if strings.Join(offers, ",") != "a,b" {
		t.Fatal(offers)
	}
	nums := SplitPostingNumbers(" a, ,b ," + strings.Repeat("x,", 300))
	if len(nums) != MaxPostingNumbers || nums[0] != "a" {
		t.Fatal(len(nums), nums[0])
	}
}

func TestWindowAndRole(t *testing.T) {
	now := time.Date(2026, 8, 16, 8, 11, 4, 0, time.UTC)
	from, to := ListWindow(now, 30)
	if from != "2026-07-17T08:11:04Z" || to != "2026-09-15T08:11:04Z" {
		t.Fatal(from, to)
	}
	body, err := UnfulfilledBody("", from, to, 100)
	if err != nil || strings.Contains(string(body), "cursor") || !strings.Contains(string(body), `"sort_dir":"ASC"`) {
		t.Fatal(string(body), err)
	}
	if _, err := CanManage(""); err == nil {
		t.Fatal("empty role")
	}
	manage, err := CanManage(" admin ")
	if err != nil || !manage {
		t.Fatal(manage, err)
	}
	manage, err = CanManage("member")
	if err != nil || manage {
		t.Fatal(manage, err)
	}
	if _, err := CanManage("intern"); err == nil || err.Error() != "工作空间角色无效" {
		t.Fatal(err)
	}
	if ClampLimit(0, 50) != 1 || ClampLimit(99, 50) != 50 || PageLimit(nil) != 20 {
		t.Fatal("clamp")
	}
	if SellerReadMessage("读取 FBS 待发货单", "/v4/posting/fbs/unfulfilled/list", 0, "timeout") != "Ozon 读取 FBS 待发货单超时（/v4/posting/fbs/unfulfilled/list）" {
		t.Fatal("timeout copy")
	}
}

func TestLogisticsWhitelist(t *testing.T) {
	raw := []byte(`{
		"posting_number":"33920145-0032-1",
		"status":"awaiting_packaging",
		"customer":{"name":"买家 PII"},
		"analytics_data":{"warehouse":"Коледино","city":"Москва","region":"Москва","delivery_type":"PVZ","tpl_provider":"CDEK"},
		"delivery_method":{"name":"Курьер","warehouse":"","tpl_provider":""},
		"shipment_date":"2026-08-17T10:00:00Z"
	}`)
	got, err := LogisticsFromV3(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got.Warehouse != "Коледино" || got.DeliveryMethod != "Курьер" || got.City != "Москва" || got.ShipmentDate != "2026-08-17T10:00:00Z" {
		t.Fatalf("%+v", got)
	}
	snap := ProjectSnapshot([]byte(`{"status":"awaiting_packaging","customer":"x","shipment_date":"d"}`))
	if strings.Contains(string(snap), "customer") || !strings.Contains(string(snap), "awaiting_packaging") {
		t.Fatal(string(snap))
	}
}
