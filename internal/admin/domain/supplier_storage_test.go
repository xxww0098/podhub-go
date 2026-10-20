package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestProjectStorageHiddenPageKeepsCursor(t *testing.T) {
	const xml = `<ListBucketResult>` +
		`<Contents><Key>root/current/</Key><Size>0</Size></Contents>` +
		`<CommonPrefixes><Prefix>root/current/.direct-uploads-backup/</Prefix></CommonPrefixes>` +
		`<Contents><Key>root/current/report.verified.png</Key><Size>9</Size><LastModified>2026-09-13T10:00:00Z</LastModified></Contents>` +
		`<CommonPrefixes><Prefix>root/current/普通目录/</Prefix></CommonPrefixes>` +
		`<Contents><Key>root/current/.direct-uploads/secret</Key><Size>1</Size></Contents>` +
		`<IsTruncated>true</IsTruncated><NextContinuationToken>next&amp;page</NextContinuationToken>` +
		`</ListBucketResult>`
	page := ProjectStorage("root/", "current", "https://cdn.example.invalid", xml)
	raw := JSONText(page)
	const want = `{"prefix":"current","items":[{"path":"current/.direct-uploads-backup","kind":"directory","bytes":0},{"path":"current/report.verified.png","kind":"file","bytes":9,"lastModified":"2026-09-13T10:00:00Z","publicUrl":"https://cdn.example.invalid/root/current/report.verified.png"},{"path":"current/普通目录","kind":"directory","bytes":0}],"nextCursor":"next&page"}`
	if raw != want {
		t.Fatalf("got %s", raw)
	}
	hidden := ProjectStorage("root/", "current", "https://cdn.example.invalid",
		`<ListBucketResult><Contents><Key>root/current/.direct-uploads/a</Key><Size>1</Size></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>keep</NextContinuationToken></ListBucketResult>`)
	if hidden.NextCursor == nil || *hidden.NextCursor != "keep" || len(hidden.Items) != 0 {
		t.Fatalf("%+v", hidden)
	}
}

func TestSupplierPathAndCursor(t *testing.T) {
	if _, err := SupplierPath("", false); err == nil || err.Error() != "对象路径不能为空" {
		t.Fatal(err)
	}
	if _, err := SupplierPath("厂家 A/设计稿 01.psd", false); err != nil {
		t.Fatal(err)
	}
	if _, err := SupplierPath("../x", false); err == nil || !strings.Contains(err.Error(), "相对路径") {
		t.Fatal(err)
	}
	if _, err := SupplierPath(".direct-uploads/a", false); err == nil || err.Error() != "该路径为上传暂存或确认事实保留路径" {
		t.Fatal(err)
	}
	empty := ""
	if err := SupplierCursor(&empty); err == nil || err.Error() != "cursor 无效" {
		t.Fatal(err)
	}
	if err := SupplierCursor(nil); err != nil {
		t.Fatal(err)
	}
}

func TestStaffRowDenialShape(t *testing.T) {
	row := RowData{
		ProductID: "scp_x", SKU: "scs_x", SourceID: "src", Title: "纯棉短袖", PlatformCode: "DB-001",
		CostCents: i64(1500), ShippingCostCents: i64(200), SuggestedRetailCents: i64(9900), SuggestedOldPrice: i64(12900),
		LeadTime: "3-5 天", Size: "40×50cm", Material: "纯棉", Craft: "数码直喷", GrossWeightG: i64(350),
		Brand: "无品牌", PackWidthMM: i64(400), PackHeightMM: i64(300), PackDepthMM: i64(100), PackWeightG: i64(350),
		Contents: "短袖 T恤 ×1", PromptName: "T恤印花", PromptFileName: "tee.txt",
		Description: "卖家可见描述", InternalNote: "打样贵", Revision: 1, CreatedBy: "pub",
		CreatorName: str("平台货源管理员"),
	}
	row.EmptyRowSlices()
	row.FillReadiness(RowFacts{SourceListed: true})
	raw := JSONText(struct {
		Data struct {
			Row RowData `json:"row"`
		} `json:"data"`
	}{struct {
		Row RowData `json:"row"`
	}{row}})
	var got map[string]any
	if err := json.Unmarshal([]byte(raw), &got); err != nil {
		t.Fatal(err)
	}
	body := raw
	for _, needle := range []string{
		`"revision":1`, `"published":false`, `"archived":false`, `"platformPriceCents":null`,
		`"denial":"sku_not_published"`, `"ozonConfigDenial":"catalog_missing"`,
		`"category":false`, `"platformPrice":false`, `"creatorName":"平台货源管理员"`,
	} {
		if !strings.Contains(body, needle) {
			t.Fatalf("missing %s in %s", needle, body)
		}
	}
	if strings.Contains(body, "draftPromptRevision") || strings.Contains(body, "publishedPromptRevision") {
		t.Fatal(body)
	}
}

func i64(n int64) *int64   { return &n }
func str(s string) *string { return &s }
