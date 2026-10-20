package domain

import (
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
)

func TestGrantAndWithdrawalInput(t *testing.T) {
	in, err := DecodeGrant([]byte(`{"name":" 夜班 ","actions":["supplier:read","supplier:read","read"],"sourceIds":["b","a","a"]}`))
	if err == nil || !strings.Contains(err.Error(), "动作与授权范围不匹配") {
		t.Fatalf("mismatch %v", err)
	}
	in, err = DecodeGrant([]byte(`{"name":"夜班","actions":["supplier:price","supplier:read"],"expiresInDays":null,"sourceIds":["b","a","a"]}`))
	if err != nil || in.Name != "夜班" || len(in.Actions) != 2 || in.Expires != nil || in.Sources == nil || (*in.Sources)[0] != "a" || (*in.Sources)[1] != "b" {
		t.Fatalf("%+v %v", in, err)
	}
	if _, err := NormalizeStatus(" paid "); err != nil {
		t.Fatal(err)
	}
	if _, err := NormalizeStatus("hold"); err == nil {
		t.Fatal("bad status")
	}
	ref, err := DecodePay([]byte(`{"reference":"  P-1  "}`))
	if err != nil || ref != "  P-1  " {
		t.Fatalf("pay %q %v", ref, err)
	}
	got, err := Bounded(ref, 64, "打款单号须为 1–64 个字符")
	if err != nil || got != "P-1" {
		t.Fatalf("bound %q %v", got, err)
	}
}

func TestEmailAndUUID(t *testing.T) {
	if EmailShaped("a@b") || EmailShaped("a@b@c") || EmailShaped("a@b.") || !EmailShaped("a@b.c") {
		t.Fatal("email shape")
	}
	id, ok := CanonicalUUID("  {550E8400-E29B-41D4-A716-446655440000} ")
	if !ok || id != "550e8400-e29b-41d4-a716-446655440000" {
		t.Fatalf("%q %v", id, ok)
	}
	if _, ok := CanonicalUUID("not-a-uuid"); ok {
		t.Fatal("bad uuid")
	}
}

func TestDecodeSupplierDb(t *testing.T) {
	okBody := `{
	  "name": "广州印花厂",
	  "country": "cn",
	  "contact": "ops@factory.invalid",
	  "internalNote": "旺季产能足",
	  "listed": true,
	  "icon": "🏭",
	  "template": null,
	  "viewPrefs": { "kanban": "status" }
	}`
	got, err := DecodeSupplierDb([]byte(okBody))
	if err != nil || got.Country != "CN" || got.Template != "" || string(got.ViewPrefs) != `{"kanban":"status"}` || got.Name != "广州印花厂" {
		t.Fatalf("%+v %v", got, err)
	}
	cases := []struct {
		body string
		msg  string
	}{
		{`{}`, "请求格式无效"},
		{`{"name":"","country":"","contact":"","internalNote":"","listed":false,"icon":"","template":null,"viewPrefs":{}}`, "名称需为 1–80 个字符"},
		{`{"name":"A","country":"CHN","contact":"","internalNote":"","listed":false,"icon":"","template":null,"viewPrefs":{}}`, "国家/地区需为空或两位字母代码"},
		{`{"name":"A","country":"","contact":"","internalNote":"","listed":false,"icon":"","template":"nope","viewPrefs":{}}`, "未知的建库模板"},
		{`{"name":"A","country":"","contact":"","internalNote":"","listed":false,"icon":"","template":null,"viewPrefs":{},"accountEmail":"not-an-email"}`, "厂家登录邮箱无效"},
		{`{"name":"A","country":"","contact":"","internalNote":"","listed":false,"icon":"","template":null,"viewPrefs":{},"extra":1}`, "请求格式无效"},
	}
	for _, tc := range cases {
		_, err := DecodeSupplierDb([]byte(tc.body))
		f, ok := contract.AsFail(err)
		if !ok || f.Message != tc.msg || f.Kind != contract.KindValidation {
			t.Fatalf("%s → %v", tc.msg, err)
		}
	}
	long := strings.Repeat("名", 81)
	body := `{"name":"` + long + `","country":"","contact":"","internalNote":"","listed":false,"icon":"","template":"factory","viewPrefs":null}`
	_, err = DecodeSupplierDb([]byte(body))
	f, _ := contract.AsFail(err)
	if f == nil || f.Message != "名称需为 1–80 个字符" {
		t.Fatal(err)
	}
}

func TestDecodePropRequiresPosition(t *testing.T) {
	_, err := DecodeProp([]byte(`{"name":"面料","type":"select","sellerVisible":true,"options":[{"value":"cotton","label":"纯棉"}]}`))
	f, ok := contract.AsFail(err)
	if !ok || f.Message != "请求格式无效" {
		t.Fatalf("omitted position %v", err)
	}
	got, err := DecodeProp([]byte(`{"name":"面料","type":"select","sellerVisible":true,"position":null,"options":[{"value":" cotton ","label":"纯棉"}]}`))
	if err != nil || got.Position != nil || got.Options[0].Value != "cotton" {
		t.Fatalf("%+v %v", got, err)
	}
	_, err = DecodeProp([]byte(`{"name":"面料","type":"select","sellerVisible":true,"position":-1,"options":[{"value":"a","label":"b"}]}`))
	f, _ = contract.AsFail(err)
	if f == nil || f.Message != "position 不能为负" {
		t.Fatal(err)
	}
	_, err = DecodeProp([]byte(`{"name":"面料","type":"select","sellerVisible":true,"position":0,"options":[]}`))
	f, _ = contract.AsFail(err)
	if f == nil || f.Message != "选择型属性至少需要一个选项" {
		t.Fatal(err)
	}
	many := `{"name":"面料","type":"text","sellerVisible":true,"position":0,"options":[`
	for i := 0; i < 61; i++ {
		if i > 0 {
			many += ","
		}
		many += `{"value":"v","label":"l"}`
	}
	many += `]}`
	_, err = DecodeProp([]byte(many))
	f, _ = contract.AsFail(err)
	if f == nil || f.Message != "选项最多 60 项" {
		t.Fatal(err)
	}
}

func TestAccountBodies(t *testing.T) {
	if !PatchEmpty([]byte(`{}`)) || !PatchEmpty([]byte(`{"status":null,"password":null}`)) {
		t.Fatal("empty patch")
	}
	if PatchEmpty([]byte(`{"status":"disabled"}`)) || PatchEmpty([]byte(`not json`)) {
		t.Fatal("non-empty")
	}
	got, err := DecodeAccount([]byte(`{"sourceId":" src ","email":" Fresh@Example.Invalid "}`))
	if err != nil || got.SourceID != "src" || got.Email != "fresh@example.invalid" || got.Password != nil {
		t.Fatalf("%+v %v", got, err)
	}
	_, err = DecodeAccount([]byte(`{"sourceId":"","email":"a@b.c"}`))
	f, _ := contract.AsFail(err)
	if f == nil || f.Message != "请选择厂家" {
		t.Fatal(err)
	}
	_, err = DecodeAccount([]byte(`{"sourceId":"s","email":"a@b"}`))
	f, _ = contract.AsFail(err)
	if f == nil || f.Message != "邮箱无效" {
		t.Fatal(err)
	}
	patch, empty, err := DecodeAccountPatch([]byte(`{"password":""}`))
	if empty || err == nil || patch.Password != nil {
		t.Fatal(err)
	}
	f, _ = contract.AsFail(err)
	if f.Message != "密码不能为空" {
		t.Fatal(f)
	}
	patch, empty, err = DecodeAccountPatch([]byte(`{"status":"disabled"}`))
	if err != nil || empty || patch.Status == nil || *patch.Status != "disabled" {
		t.Fatal(err)
	}
}

func TestGroupAccountsAndFactory(t *testing.T) {
	rows := []Member{
		{MemberID: "1", Source: SourceRef{SourceID: "a", Name: "A"}, Email: "a@b.c", Status: "active"},
		{MemberID: "2", Source: SourceRef{SourceID: "a", Name: "A"}, Email: "b@b.c", Status: "active"},
		{MemberID: "3", Source: SourceRef{SourceID: "b", Name: "B"}, Email: "c@b.c", Status: "disabled"},
	}
	groups := GroupAccounts(rows)
	if len(groups) != 2 || len(groups[0].Members) != 2 || groups[1].Source.SourceID != "b" {
		t.Fatalf("%+v", groups)
	}
	if len(GroupAccounts(nil)) != 0 {
		t.Fatal("nil")
	}
	props, err := FactoryProps([]string{"p0", "p1", "p2", "p3", "p4"})
	if err != nil || len(props) != 5 || props[3].SellerVisible || props[3].Name != "合作模式" || props[0].Position != 0 {
		t.Fatal(err, props)
	}
}

func TestLimitConstants(t *testing.T) {
	if MaxNameChars != 80 || MaxOptions != 60 || BusinessInFlight != 84 || InteractiveReadCap != 16 ||
		RegularWriteCap != 10 || PsdUploadCap != 6 || BodyLimitBytes != 2*1024*1024 || ConfirmBodyLimit != 64*1024 ||
		MaxPasswordBytes != 72 || MaxViewPrefsBytes != 65536 {
		t.Fatal("constants drifted from the supplier-dbs spec")
	}
}
