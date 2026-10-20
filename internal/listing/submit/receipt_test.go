package submit

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestImageDigestsMatchTheSharedUploadKey(t *testing.T) {
	digest := strings.Repeat("a", 64)
	url := "https://cdn.example/uploads/2023-11-14/1700000000000-22222222-2222-4222-8222-222222222222/images/teams/11111111-1111-4111-8111-111111111111/sha256/" + digest + ".jpg"
	body := []byte(`{"items":[{"offer_id":"A","images":["` + url + `","` + url + `"],"primary_image":"` + url + `"}]}`)
	other := []byte(`{"items":[{"offer_id":"B","primary_image":"https://media.example.invalid/hero.jpg"}]}`)
	got := imageDigests(body, other, body)
	if len(got) != 1 || got[0] != digest {
		t.Fatalf("%v", got)
	}
	if imageDigests([]byte(`{"items":[{"offer_id":"C"}]}`)) != nil {
		t.Fatal("no image")
	}
}

func TestOneItemImportKeepsFrozenBytes(t *testing.T) {
	raw := []byte(`{"items":[{"offer_id":"A","name":"n"}]}`)
	got, err := mergeImport([][]byte{raw}, nil)
	if err != nil || string(got) != string(raw) {
		t.Fatalf("%s %v", got, err)
	}
	left := []byte(`{"items":[{"offer_id":"A"}]}`)
	right := []byte(`{"items":[{"offer_id":"B"}]}`)
	merged, err := mergeImport([][]byte{left, right}, []json.RawMessage{
		json.RawMessage(`{"offer_id":"A"}`), json.RawMessage(`{"offer_id":"B"}`),
	})
	if err != nil || string(merged) != `{"items":[{"offer_id":"A"},{"offer_id":"B"}]}` {
		t.Fatalf("%s %v", merged, err)
	}
}
