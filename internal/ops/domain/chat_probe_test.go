package domain

import "testing"

func TestOldIdenticalChatCannotProveANewSend(t *testing.T) {
	kind, summary := Observe("chat_send", []byte(`{"chat_id":"buyer-1","text":"Здравствуйте"}`), func(_, _ string, _ []byte) Page {
		return Page{Status: 200, Body: `{"messages":[{"message_id":"old","created_at":"2020-01-01T00:00:00Z","user":{"type":"seller"},"data":["Здравствуйте"]}]}`}
	}, nil)
	if kind != "indeterminate" || Decide(kind, 1, nil, summary).State != "result_unknown" {
		t.Fatalf("historical message settled a new operation: %s %s", kind, summary)
	}
}

func TestMessageSendRequiresARealReceipt(t *testing.T) {
	for _, reply := range []string{`{}`, `null`, `{"result":null}`, `{"result":true}`, `{"result":""}`, `{`} {
		_, fail, unknown := SendMessage("buyer-1", "Здравствуйте", func(_, _ string, _ []byte) Page {
			return Page{Status: 200, Body: reply}
		})
		if !unknown || fail == nil || fail.Status != 409 {
			t.Fatalf("invalid response acknowledged send: %s", reply)
		}
	}
	result, fail, unknown := SendMessage("buyer-1", "Здравствуйте", func(_, _ string, _ []byte) Page {
		return Page{Status: 200, Body: `{"result":"ok"}`}
	})
	if fail != nil || unknown || result != "ok" {
		t.Fatalf("valid send rejected: %s %+v %v", result, fail, unknown)
	}
}
