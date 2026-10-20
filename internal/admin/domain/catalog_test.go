package domain

import "testing"

func TestCatalogProductEdges(t *testing.T) {
	ok := `{"title":"棉袜","description":"卖家可见描述","media":[],"specs":{"材质":"棉"}}`
	got, err := ParseCreateProduct([]byte(ok), nil)
	if err != nil || got.Title != "棉袜" || got.Specs["材质"] != "棉" {
		t.Fatalf("%+v %v", got, err)
	}
	cases := []struct {
		name string
		raw  string
		msg  string
	}{
		{"missing title", `{"description":""}`, msgBadCatalogJSON},
		{"empty title", `{"title":"  "}`, "商品名称需为 1–255 个字符"},
		{"long title", `{"title":"` + repeat("名", 256) + `"}`, "商品名称需为 1–255 个字符"},
		{"long description", `{"title":"a","description":"` + repeat("描", 4001) + `"}`, "描述不能超过 4000 个字符"},
		{"external media", `{"title":"外链图商品","description":"","media":["https://cdn.example/p.jpg"],"specs":{}}`, msgMediaURL},
		{"too many specs", `{"title":"a","specs":` + specObject(31) + `}`, "规格最多 30 项"},
		{"unknown field", `{"title":"a","extra":1}`, msgBadCatalogJSON},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseCreateProduct([]byte(tc.raw), nil)
			ae, ok := err.(*APIError)
			if !ok || ae.Status != 400 || ae.Code != "VALIDATION" || ae.Message != tc.msg {
				t.Fatalf("%v", err)
			}
		})
	}
	allowed, err := ParseCreateProduct([]byte(`{"title":"a","media":["https://cdn.example/a.jpg"]}`), []string{"https://cdn.example"})
	if err != nil || allowed.Media[0] != "https://cdn.example/a.jpg" {
		t.Fatalf("%+v %v", allowed, err)
	}
}

func TestMediaURLBasesAreRawPrefixes(t *testing.T) {
	bases := []string{"https://media.example.invalid", "https://cdn.example/native", " ", ""}
	pass := []string{
		"https://media.example.invalid/a.jpg",
		"https://media.example.invalid.evil/a.jpg",
		"https://cdn.example/native/a.jpg",
		"https://cdn.example/native",
	}
	for _, url := range pass {
		got, err := ParseCreateProduct([]byte(`{"title":"a","media":["`+url+`"]}`), bases)
		if err != nil || len(got.Media) != 1 || got.Media[0] != url {
			t.Fatalf("%s %+v %v", url, got.Media, err)
		}
	}
	reject := []string{
		"HTTPS://media.example.invalid/a.jpg",
		"https://other.example/a.jpg",
	}
	for _, url := range reject {
		_, err := ParseCreateProduct([]byte(`{"title":"a","media":["`+url+`"]}`), bases)
		ae, ok := err.(*APIError)
		if !ok || ae.Status != 400 || ae.Code != "VALIDATION" || ae.Message != msgMediaURL {
			t.Fatalf("%s %v", url, err)
		}
	}
	slash := []string{"https://cdn.example/native/"}
	_, err := ParseCreateProduct([]byte(`{"title":"a","media":["https://cdn.example/native"]}`), slash)
	if err == nil || err.(*APIError).Message != msgMediaURL {
		t.Fatal(err)
	}
	empty, err := ParseCreateProduct([]byte(`{"title":"a","media":[]}`), nil)
	if err != nil || len(empty.Media) != 0 {
		t.Fatalf("%+v %v", empty, err)
	}
	_, err = ParseCreateProduct([]byte(`{"title":"a","media":["https://media.example/a.jpg"]}`), nil)
	if err == nil || err.(*APIError).Message != msgMediaURL {
		t.Fatal(err)
	}
	padded, err := ParseCreateProduct([]byte(`{"title":"a","media":["  https://media.example.invalid/a.jpg  "]}`), bases)
	if err != nil || padded.Media[0] != "https://media.example.invalid/a.jpg" {
		t.Fatalf("%+v %v", padded, err)
	}
	long := "https://media.example.invalid/" + repeat("a", 2048)
	_, err = ParseCreateProduct([]byte(`{"title":"a","media":["`+long+`"]}`), bases)
	if err == nil || err.(*APIError).Message != "每条媒体地址需为 1–2048 个字符" {
		t.Fatal(err)
	}
	many := "[" + repeat(`"https://media.example.invalid/a.jpg",`, 20) + `"https://media.example.invalid/a.jpg"]`
	_, err = ParseCreateProduct([]byte(`{"title":"a","media":`+many+`}`), bases)
	if err == nil || err.(*APIError).Message != "媒体最多 20 项" {
		t.Fatal(err)
	}
}

func TestCatalogRevisionAndPrice(t *testing.T) {
	if _, err := ParseCAS([]byte(`{"expectedRevision":0}`)); err == nil || err.(*APIError).Message != msgRevision {
		t.Fatal(err)
	}
	rev, err := ParseCAS([]byte(`{"expectedRevision":3}`))
	if err != nil || rev != 3 {
		t.Fatal(err, rev)
	}
	if _, _, err := ParsePrice([]byte(`{"expectedRevision":1,"priceCents":0}`)); err == nil || err.(*APIError).Message != msgPrice {
		t.Fatal(err)
	}
	rev, cents, err := ParsePrice([]byte(`{"expectedRevision":2,"priceCents":1250}`))
	if err != nil || rev != 2 || cents != 1250 {
		t.Fatal(err, rev, cents)
	}
}

func TestCatalogSKUCodeEdges(t *testing.T) {
	_, err := ParseCreateSKU([]byte(`{"productId":"  ","platformCode":"A","title":"n"}`), nil)
	if err == nil || err.(*APIError).Message != msgPickProduct {
		t.Fatal(err)
	}
	_, err = ParseCreateSKU([]byte(`{"productId":"p","platformCode":"`+repeat("C", 65)+`","title":"n"}`), nil)
	if err == nil || err.(*APIError).Message != "平台编码不能超过 64 个字符" {
		t.Fatal(err)
	}
	got, err := ParseCreateSKU([]byte(`{"productId":" p ","platformCode":" AB ","title":" 名称 ","leadTime":" 3 天 "}`), nil)
	if err != nil || got.ProductID != "p" || got.PlatformCode != "AB" || got.Title != "名称" || got.LeadTime != "3 天" {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestReplaceMediaKeepsForeignAndFoldsOwned(t *testing.T) {
	out, err := ReplaceMedia([]string{"https://other/a.jpg", "https://cdn/owned.jpg"}, []string{"https://cdn/owned.jpg"}, "https://cdn/new.jpg")
	if err != nil || len(out) != 2 || out[0] != "https://other/a.jpg" || out[1] != "https://cdn/new.jpg" {
		t.Fatalf("%v %v", out, err)
	}
	full := make([]string, 20)
	for i := range full {
		full[i] = "https://other/" + itoa(i)
	}
	if _, err := ReplaceMedia(full, nil, "https://cdn/new.jpg"); err == nil || err.(*APIError).Message != msgMediaFull {
		t.Fatal(err)
	}
}

func TestProductAuditFieldOrder(t *testing.T) {
	got := ProductAudit("棉袜", false, 1)
	want := `{"summary":"棉袜","published":false,"revision":1}`
	if got != want {
		t.Fatalf("%s", got)
	}
}

func repeat(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}

func specObject(n int) string {
	out := "{"
	for i := 0; i < n; i++ {
		if i > 0 {
			out += ","
		}
		out += `"` + itoa(i) + `":"v"`
	}
	return out + "}"
}
