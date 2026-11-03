package cataloghttp

import "testing"

func TestDictionarySearchRefusesMalformedSuccessResponses(t *testing.T) {
	for _, raw := range []string{`{}`, `{"result":null}`, `{"result":{}}`, `{"result":[{"id":0,"value":"bad"}]}`, `{"result":[{"id":1,"value":""}]}`, `{"result":[{"id":1,"value":"a"},{"id":1,"value":"duplicate"}]}`} {
		if _, err := decodeDictionarySearch([]byte(raw), 100); err == nil {
			t.Fatalf("accepted malformed dictionary response: %s", raw)
		}
	}
	if values, err := decodeDictionarySearch([]byte(`{"result":[]}`), 100); err != nil || values == nil || len(values) != 0 {
		t.Fatalf("valid empty search: %+v %v", values, err)
	}
	values, err := decodeDictionarySearch([]byte(`{"result":[{"id":99999,"value":"confirmed","info":"detail","picture":"https://example.com/image.jpg"}]}`), 1)
	if err != nil || len(values) != 1 || values[0].ID != "99999" || values[0].Info != "detail" {
		t.Fatalf("valid search: %+v %v", values, err)
	}
	if _, err := decodeDictionarySearch([]byte(`{"result":[{"id":1,"value":"a"},{"id":2,"value":"b"}]}`), 1); err == nil {
		t.Fatal("accepted more values than requested")
	}
}
