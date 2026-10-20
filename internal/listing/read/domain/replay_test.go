package domain

import "testing"

func TestReadReplayRemoveAndInvalidate(t *testing.T) {
	raw := []byte(`[{"seq":2,"payload":{"rowId":"row-1","removed":true}},{"seq":3,"payload":{"reason":"template_changed","psdTemplateSha256":"abc"}}]`)
	page, err := ReadReplay(false, 3, 1, 1, raw)
	if err != nil || page.Reset {
		t.Fatalf("%+v %v", page, err)
	}
	if len(page.Events) != 2 || page.Events[0].RemoveID != "row-1" || !page.Events[1].CardLevel || page.Events[1].Template != "abc" {
		t.Fatalf("%+v", page.Events)
	}
	raw = []byte(`[{"seq":2,"payload":{"rowId":"row-1","removed":false,"row":{}}}]`)
	page, err = ReadReplay(false, 2, 1, 1, raw)
	if err != nil || !page.Events[0].Upsert {
		t.Fatal(page)
	}
	page, err = ReadReplay(false, 9, 1, 10, []byte(`[]`))
	if err != nil || !page.Reset || page.Overflow {
		t.Fatalf("ahead %+v", page)
	}
}
