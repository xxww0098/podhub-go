package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func TestSemanticRevisionEmptyMatchesSerde(t *testing.T) {
	const material = `{"schema_format_version":2,"normalization_ruleset_version":1,"validation_ruleset_version":1,"serializer_ruleset_version":1,"description_category_id":9,"type_id":8,"recipe_id":0,"recipe_revision":0,"catalog_schema_version":0,"fields":[],"complex_groups":[]}`
	sum := sha256.Sum256([]byte(material))
	want := "sha256:" + hex.EncodeToString(sum[:])
	if got := SemanticRevision(9, 8, []ListingField{}); got != want {
		t.Fatalf("%s", got)
	}
	if !strings.HasPrefix(SemanticRevision(1, 2, LiveFixedFields()), "sha256:") {
		t.Fatal("fixed")
	}
}

func TestInferEditor(t *testing.T) {
	if InferEditor("Integer", false, false, false) != "integer" {
		t.Fatal("int")
	}
	if InferEditor("string", true, true, true) != "dictionary_search" {
		t.Fatal("search")
	}
	if InferEditor("url", true, false, false) != "url_list" {
		t.Fatal("urls")
	}
}
