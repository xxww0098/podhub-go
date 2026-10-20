package domain

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestTriggersForChanges(t *testing.T) {
	manual := TriggersForChanges([]byte(`{"title":"x"}`), false)
	if !HasTrigger(manual, TriggerManual) || len(manual) != 1 {
		t.Fatalf("manual %#v", manual)
	}
	blank := TriggersForChanges([]byte(`{"brand":"ai"}`), true)
	if HasTrigger(blank, TriggerManual) || len(blank) != 0 {
		t.Fatalf("fill blank %#v", blank)
	}
	category := TriggersForChanges([]byte(`{"descriptionCategoryId":9}`), false)
	if !HasTrigger(category, TriggerCategory) || !HasTrigger(category, TriggerManual) {
		t.Fatalf("category %#v", category)
	}
	filled := TriggersForChanges([]byte(`{"descriptionCategoryId":9}`), true)
	if !HasTrigger(filled, TriggerCategory) || HasTrigger(filled, TriggerManual) || len(filled) != 1 {
		t.Fatalf("category fill %#v", filled)
	}
	if TriggersForChanges([]byte(`[]`), true) != nil {
		t.Fatal("array")
	}
	if TriggersForChanges([]byte(`{}`), false) != nil {
		t.Fatal("empty object still adds nothing")
	}
	psd := OverlayOf(TriggerPsd)
	if psd.Content != nil || psd.Submission != nil || psd.Media == nil || *psd.Media != "pending" {
		t.Fatalf("psd %+v", psd)
	}
	source := OverlayOf(TriggerSource)
	if source.Content == nil || *source.Content != "draft" || source.Media == nil || *source.Media != "pending" || source.Submission != nil {
		t.Fatalf("source %+v", source)
	}
}

func TestStripSchemaReference(t *testing.T) {
	got := StripSchemaReference([]byte(`{"title":"a","schemaSnapshot":{"x":1},"schemaRevision":"r"}`))
	var obj map[string]json.RawMessage
	if json.Unmarshal(got, &obj) != nil {
		t.Fatal(string(got))
	}
	if _, ok := obj["schemaSnapshot"]; ok {
		t.Fatal("snapshot kept")
	}
	if _, ok := obj["schemaRevision"]; ok {
		t.Fatal("revision kept")
	}
	if string(obj["title"]) != `"a"` {
		t.Fatal(string(got))
	}
	array := []byte(`[1]`)
	if !bytes.Equal(StripSchemaReference(array), array) {
		t.Fatal("non-object")
	}
}

func TestSourceChangedAndHadSource(t *testing.T) {
	if !SourceChanged([]byte(`{"source":{"sha256":"a"}}`), []byte(`{"source":{"sha256":"b"}}`)) {
		t.Fatal("different sha")
	}
	if SourceChanged([]byte(`{"source":{"sha256":"a"}}`), []byte(`{"source":{"sha256":"a"}}`)) {
		t.Fatal("same sha")
	}
	if !SourceChanged([]byte(`{}`), []byte(`{"source":{"sha256":null}}`)) {
		t.Fatal("missing is not json null")
	}
	if SourceChanged([]byte(`{"source":null}`), []byte(`{}`)) {
		t.Fatal("null source does not expose sha256")
	}
	if HadSource([]byte(`{"source":{"sha256":""}}`)) || HadSource([]byte(`{"source":{"sha256":null}}`)) || HadSource([]byte(`{}`)) {
		t.Fatal("empty sha is not a previous source")
	}
	if !HadSource([]byte(`{"source":{"sha256":"abc"}}`)) {
		t.Fatal("sha")
	}
}

func TestProtectAndMedia(t *testing.T) {
	stored := []byte(`{"ai":{"requestId":"r"},"draft":{"values":{}},"media":{"images":[1]}}`)
	if msg := ProtectContentSections(stored, []byte(`{"title":"a"}`), false, false); msg != "" {
		t.Fatal(msg)
	}
	if msg := ProtectContentSections(stored, []byte(`{"ai":{"requestId":"other"}}`), false, false); msg == "" {
		t.Fatal("ai change")
	}
	if msg := ProtectContentSections(stored, []byte(`{"title":"a"}`), true, false); msg == "" {
		t.Fatal("payload must repeat protected keys")
	}
	if msg := ProtectContentSections(stored, []byte(`{"draft":{"values":{"name":1}}}`), false, false); msg == "" {
		t.Fatal("draft key")
	}
	if msg := ProtectContentSections(stored, []byte(`{"draft":{"values":{}}}`), false, true); msg != "" {
		t.Fatal("draft field is the draft writer")
	}
	if _, msg := AuthoringMediaChanges(stored, []byte(`{"media":[]}`), false); msg == "" {
		t.Fatal("media array")
	}
	if _, msg := AuthoringMediaChanges(stored, []byte(`{"media":{"images":[2]}}`), false); msg == "" {
		t.Fatal("images")
	}
	if _, msg := AuthoringMediaChanges(stored, []byte(`{"renderEvidence":{"x":1}}`), false); msg == "" {
		t.Fatal("evidence")
	}
	merged, msg := AuthoringMediaChanges(stored, []byte(`{"media":{"images":[1],"videos":[]},"title":"a"}`), false)
	if msg != "" || !bytes.Contains(merged, []byte(`"title":"a"`)) || !bytes.Contains(merged, []byte(`"videos":[]`)) {
		t.Fatalf("%s %s", msg, merged)
	}
}

func TestInvalidateSourceClearsAIAndReviewsUnknown(t *testing.T) {
	payload := []byte(`{
		"categoryKey":"k","descriptionCategoryId":9,"typeId":8,"schemaRevision":"rev",
		"schemaSnapshot":{
			"category_key":"k","label":"L","description_category_id":9,"type_id":8,
			"schema_revision":"rev","recipe_id":1,"recipe_revision":1,"catalog_schema_version":1,
			"fields":[
				{"key":"name","label":"N","group":"g","editor":"text","required":false,"attribute_id":null},
				{"key":"brand","label":"B","group":"g","editor":"text","required":false,"attribute_id":null}
			]
		},
		"draft":{"values":{"name":{"kind":"text","value":"kept"},"brand":{"kind":"text","value":"ai"}},"complex_values":[]},
		"handEditedKeys":[],
		"fieldOrigins":[{"address":{"kind":"plain","field_key":"brand"},"kind":"ai_confirmed","source_ref":null,"updated_at_ms":1}],
		"ai":{"requestId":"r","candidates":[{"address":{"kind":"plain","field_key":"brand"},"value":{"kind":"text","value":"ai"},"current_value":null,"source":"ocr","state":"proposed","issue":null}],"promptSha256":"p","modelVersion":"m"}
	}`)
	overlay, err := InvalidateSourceContent(payload, []byte(`{"source":{"sha256":"old"}}`))
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		Draft struct {
			Values map[string]json.RawMessage `json:"values"`
		} `json:"draft"`
		AI struct {
			RequestID  string `json:"requestId"`
			PromptSHA  string `json:"promptSha256"`
			Model      string `json:"modelVersion"`
			Candidates []struct {
				Source string          `json:"source"`
				State  string          `json:"state"`
				Issue  string          `json:"issue"`
				Value  json.RawMessage `json:"value"`
			} `json:"candidates"`
		} `json:"ai"`
		Origins []json.RawMessage `json:"fieldOrigins"`
	}
	if json.Unmarshal(overlay, &body) != nil {
		t.Fatal(string(overlay))
	}
	if _, ok := body.Draft.Values["brand"]; ok {
		t.Fatal("ai value kept")
	}
	if string(body.Draft.Values["name"]) == "" {
		t.Fatal("manual-unknown value dropped")
	}
	if len(body.Origins) != 0 || body.AI.RequestID != "" || body.AI.PromptSHA != "" || body.AI.Model != "" {
		t.Fatalf("%s", overlay)
	}
	if len(body.AI.Candidates) != 1 || body.AI.Candidates[0].Source != "source_changed" || body.AI.Candidates[0].State != "unresolved" {
		t.Fatalf("%s", overlay)
	}
	if body.AI.Candidates[0].Issue != sourceReviewIssue {
		t.Fatal(body.AI.Candidates[0].Issue)
	}
	fresh, err := InvalidateSourceContent(payload, []byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(fresh, []byte(`"candidates":[{`)) {
		t.Fatal("had_source false must not append reviews")
	}
	if _, err := InvalidateSourceContent([]byte(`{"title":"a"}`), []byte(`{}`)); err == nil || !strings.HasPrefix(err.Error(), PayloadDecodePrefix) {
		t.Fatal(err)
	}
}
