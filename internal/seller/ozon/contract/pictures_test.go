package contract

import (
	"reflect"
	"testing"
)

func TestImportImagesIncludeEverySourceOnce(t *testing.T) {
	got := ImportImageURLs([]byte(`{"items":[{"images":["a","b"],"primary_image":"a","color_image":"c","images360":["d"]}]}`))
	if !reflect.DeepEqual(got, []string{"a", "b", "d", "c"}) {
		t.Fatalf("image sources: %v", got)
	}
}

func TestPicturesRequireCompleteSourceEvidence(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		want       bool
	}{
		{"complete", `{"items":[{"product_id":7,"primary_photo":["a"],"photo":["a","b"],"color_photo":["c"],"photo_360":["d"],"errors":[]}]}`, true},
		{"partial", `{"items":[{"product_id":7,"photo":["a","b","c"],"errors":[]}]}`, false},
		{"wrong product", `{"items":[{"product_id":8,"photo":["a","b","c","d"],"errors":[]}]}`, false},
		{"missing errors", `{"items":[{"product_id":7,"photo":["a","b","c","d"]}]}`, false},
		{"null errors", `{"items":[{"product_id":7,"photo":["a","b","c","d"],"errors":null}]}`, false},
		{"fetch failed", `{"items":[{"product_id":7,"photo":["a","b","c","d"],"errors":[{"url":"b","message":"download failed"}]}]}`, false},
		{"rewritten URLs", `{"items":[{"product_id":7,"photo":["https://cdn.example/a"],"errors":[]}]}`, false},
		{"duplicate product", `{"items":[{"product_id":7,"photo":["a","b","c","d"],"errors":[]},{"product_id":7,"errors":[]}]}`, false},
		{"unreadable", `{`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := PicturesFetched([]byte(tc.body), 7, []string{"a", "b", "c", "d"}); got != tc.want {
				t.Fatalf("confirmed=%v, want %v", got, tc.want)
			}
		})
	}
}
