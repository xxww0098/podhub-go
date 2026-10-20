package domain

import (
	"bytes"
	"strings"
	"testing"
)

func TestPrepareCardRefusesUnknownAndSystemMedia(t *testing.T) {
	_, err := PrepareCard([]byte(`{"categoryKey":"k","descriptionCategoryId":1,"typeId":2,"aiFieldPolicy":{"allowed_field_keys":[],"protected_field_keys":[]},"extra":1}`), nil)
	if err == nil || !strings.Contains(err.Error(), "unknown fields: extra") {
		t.Fatal(err)
	}
	_, err = PrepareCard([]byte(`{"categoryKey":"k","descriptionCategoryId":1,"typeId":2,"aiFieldPolicy":{"allowed_field_keys":[],"protected_field_keys":[]},"defaults":{"values":{"attribute_21841":{"kind":"url","value":"http://x"}},"complex_values":[]}}`), nil)
	if err == nil || !strings.Contains(err.Error(), "字段 attribute_21841") {
		t.Fatal(err)
	}
	raw, err := PrepareCard([]byte(`{"categoryKey":"k","descriptionCategoryId":1,"typeId":94897,"aiFieldPolicy":{"allowed_field_keys":[],"protected_field_keys":[]}}`), nil)
	if err != nil || !bytes.Contains(raw, []byte(`抽象化`)) {
		t.Fatalf("%s %v", raw, err)
	}
	_, err = PrepareCard([]byte(`{"categoryKey":"k","descriptionCategoryId":1,"typeId":2,"aiFieldPolicy":{"allowed_field_keys":[],"protected_field_keys":[]},"psdTemplateAssetId":"ab","psdTemplateSha256":"cd"}`), nil)
	doc, ok := err.(DocError)
	if !ok || doc.Kind != "conflict" || doc.Message != "PSD 模板引用与固定摘要不一致" {
		t.Fatal(err)
	}
}

func TestCreateFingerprintIsStable(t *testing.T) {
	got := CreateFingerprint("card", "store", "sha", "file", "", "", "client", "")
	if !strings.HasPrefix(got, "sha256:") || len(got) != len("sha256:")+64 {
		t.Fatal(got)
	}
	again := CreateFingerprint("card", "store", "sha", "file", "", "", "client", "")
	if got != again {
		t.Fatal(again)
	}
	id, msg := AssociationIdentity(7, "src", "red", strings.Repeat("ab", 32))
	if msg != "" || !strings.HasPrefix(id.Model, "PHM-") || len(id.ID) != 36 {
		t.Fatalf("%+v %s", id, msg)
	}
	if _, msg := AssociationIdentity(7, "", "red", "aa"); msg != "同款关联需要非空的货源库编号与款号" {
		t.Fatal(msg)
	}
}
