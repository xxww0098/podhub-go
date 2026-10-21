package submit

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestParseBatchRevisionPins(t *testing.T) {
	const store = "11111111-1111-4111-8111-111111111111"
	const rowA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	const rowB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	const rowC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	pinA := `{"rowId":"` + rowA + `","revision":1}`
	pinB := `{"rowId":"` + rowB + `","revision":2}`
	pinC := `{"rowId":"` + rowC + `","revision":3}`
	cases := []struct {
		name     string
		rows     []string
		pins     string
		valid    bool
		wantPins map[string]int64
	}{
		{name: "matching pins may be in a different order", rows: []string{rowA, rowB}, pins: `[` + pinB + `,` + pinA + `]`, valid: true, wantPins: map[string]int64{rowA: 1, rowB: 2}},
		{name: "zero is a valid revision pin", rows: []string{rowA}, pins: `[{"rowId":"` + rowA + `","revision":0}]`, valid: true, wantPins: map[string]int64{rowA: 0}},
		{name: "missing pins", rows: []string{rowA}},
		{name: "null pins", rows: []string{rowA}, pins: `null`},
		{name: "empty pins", rows: []string{rowA}, pins: `[]`},
		{name: "omitted row", rows: []string{rowA, rowB}, pins: `[` + pinA + `]`},
		{name: "extra row", rows: []string{rowA, rowB}, pins: `[` + pinA + `,` + pinB + `,` + pinC + `]`},
		{name: "wrong row", rows: []string{rowA, rowB}, pins: `[` + pinA + `,` + pinC + `]`},
		{name: "duplicate pin", rows: []string{rowA, rowB}, pins: `[` + pinA + `,` + pinA + `]`},
		{name: "duplicate requested row", rows: []string{rowA, rowA}, pins: `[` + pinA + `,` + pinB + `]`},
		{name: "duplicate uuid spelling", rows: []string{rowA, "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"}, pins: `[` + pinA + `,{"rowId":"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA","revision":1}]`},
		{name: "negative revision", rows: []string{rowA}, pins: `[{"rowId":"` + rowA + `","revision":-1}]`},
		{name: "fractional revision", rows: []string{rowA}, pins: `[{"rowId":"` + rowA + `","revision":1.5}]`},
		{name: "quoted revision", rows: []string{rowA}, pins: `[{"rowId":"` + rowA + `","revision":"1"}]`},
		{name: "missing revision", rows: []string{rowA}, pins: `[{"rowId":"` + rowA + `"}]`},
		{name: "null revision", rows: []string{rowA}, pins: `[{"rowId":"` + rowA + `","revision":null}]`},
		{name: "boolean revision", rows: []string{rowA}, pins: `[{"rowId":"` + rowA + `","revision":true}]`},
		{name: "missing row id", rows: []string{rowA}, pins: `[{"revision":1}]`},
		{name: "null pin", rows: []string{rowA}, pins: `[null]`},
		{name: "pins not array", rows: []string{rowA}, pins: `{}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := map[string]any{"storeId": store, "row_ids": tc.rows}
			if tc.pins != "" {
				body["expectedRevisions"] = json.RawMessage(tc.pins)
			}
			raw, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			got, err := ParseBatch(raw)
			if tc.valid {
				if err != nil || got.StoreID != store || !reflect.DeepEqual(got.RowIDs, tc.rows) || !reflect.DeepEqual(got.ExpectedRevisions, tc.wantPins) {
					t.Fatalf("valid batch: %+v err=%v", got, err)
				}
			} else if !errors.Is(err, ErrBadRequest) {
				t.Fatalf("invalid revision pins accepted: %+v err=%v", got, err)
			}
		})
	}
}

func TestSendStoredValidatesDirectBatch(t *testing.T) {
	req := BatchBody{
		StoreID: "11111111-1111-4111-8111-111111111111",
		RowIDs:  []string{"22222222-2222-4222-8222-222222222222"},
	}
	_, err := SendStored(context.Background(), nil, 1, 1, req, time.Now())
	var status Status
	if !errors.As(err, &status) || status.Code != 400 || status.Kind != "bad_request" {
		t.Fatalf("direct call without pins must fail validation before opening a database: %v", err)
	}
}
