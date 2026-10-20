package domain

import (
	"testing"
	"time"
)

func TestParseSellerInfo(t *testing.T) {
	body := []byte(`{
		"ratings": [
			{"rating":"rating_delivery_complaints_fbo","name":"Жалобы по FBO","current_value":null,"past_value":null,"value_type":"RATIO","status":"UNKNOWN","extra":1},
			{"rating":"rating_review","name":"Оценка товаров","current_value":4.8,"past_value":"4.5","value_type":"REVIEW_SCORE","status":"UNKNOWN"},
			{"rating":"rating_custom","name":"custom","current_value":"nope","value_type":"WEIRD","status":"MYSTERY"},
			{"name":"missing key"},
			{"rating":"rating_custom","name":"custom-2","current_value":2,"value_type":"WEIRD","status":"MYSTERY"},
			{"rating":"leaked","name":"fixture-api-key-rt1","status":"OK","value_type":"RATIO","current_value":1}
		]
	}`)
	got, dropped, err := Parse(body)
	if err != nil {
		t.Fatal(err)
	}
	if dropped != 2 {
		t.Fatalf("dropped %d", dropped)
	}
	if len(got) != 3 {
		t.Fatalf("len %d", len(got))
	}
	if got[0].Key != "rating_delivery_complaints_fbo" || got[0].Status != "UNKNOWN" || got[0].Current != nil || got[0].Past != nil || got[0].ValueType != "RATIO" {
		t.Fatalf("unknown %+v", got[0])
	}
	if got[1].Current == nil || *got[1].Current != "4.8" || got[1].Past == nil || *got[1].Past != "4.5" || got[1].ValueType != "REVIEW_SCORE" {
		t.Fatalf("score %+v", got[1])
	}
	if got[2].Status != "MYSTERY" || got[2].ValueType != "WEIRD" || got[2].Current == nil || *got[2].Current != "2" || got[2].Name != "custom-2" {
		t.Fatalf("unknown type %+v", got[2])
	}
	for _, row := range got {
		if SecretLike(row.Name) || SecretLike(row.Key) {
			t.Fatalf("secret stored in %+v", row)
		}
	}
	empty, n, err := Parse([]byte(`{"ratings":null}`))
	if err != nil || len(empty) != 0 || n != 0 {
		t.Fatalf("null list %v %d %v", empty, n, err)
	}
	if _, _, err := Parse([]byte(`{"ratings":{}}`)); err == nil {
		t.Fatal("object ratings")
	}
	if _, _, err := Parse([]byte(`{`)); err == nil {
		t.Fatal("broken json")
	}
	arr, _, err := Parse([]byte(`[{"rating":"rating_only"}]`))
	if err != nil || len(arr) != 1 || arr[0].Status != "" || arr[0].Current != nil {
		t.Fatalf("array %+v %v", arr, err)
	}
}

func TestChangeAndNotifyEdges(t *testing.T) {
	one := "1"
	oneAgain := "1.0"
	two := "2"
	ranks := map[string]int{"OK": 1, "BAD": 2}
	cases := []struct {
		name                       string
		existed                    bool
		from, to                   string
		old, next                  *string
		changed, worse, worsePlain bool
	}{
		{"first", false, "", "UNKNOWN", nil, nil, true, false, false},
		{"same null", true, "UNKNOWN", "UNKNOWN", nil, nil, false, false, false},
		{"same number", true, "OK", "OK", &one, &oneAgain, false, false, false},
		{"number changed", true, "OK", "OK", &one, &two, true, false, false},
		{"status changed", true, "OK", "BAD", &one, &one, true, true, false},
		{"worse value and status", true, "OK", "BAD", &one, &two, true, true, false},
		{"better status", true, "BAD", "OK", &two, &one, true, false, false},
		{"unmapped new", true, "OK", "MYSTERY", &one, &one, true, false, false},
		{"unmapped old", true, "MYSTERY", "BAD", &one, &one, true, false, false},
		{"default unknown", true, "UNKNOWN", "BAD", nil, &one, true, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Changed(tc.existed, tc.from, tc.to, tc.old, tc.next); got != tc.changed {
				t.Fatalf("changed %v", got)
			}
			if got := Worsened(ranks, tc.existed, tc.from, tc.to); got != tc.worse {
				t.Fatalf("worse %v", got)
			}
			if got := Worsened(DefaultRanks(), tc.existed, tc.from, tc.to); got != tc.worsePlain {
				t.Fatalf("default worse %v", got)
			}
		})
	}
	if Worsened(nil, true, "OK", "BAD") {
		t.Fatal("nil map")
	}
}

func TestPresentDoesNotInventZero(t *testing.T) {
	zero := "0"
	prev := "1"
	noData, cur, past, dir := Present("UNKNOWN", &zero, &prev, &prev)
	if !noData || cur != "" || past != "" || dir != DirNoData {
		t.Fatalf("unknown %+v %s %s %s", noData, cur, past, dir)
	}
	noData, cur, past, dir = Present("OK", nil, &zero, &prev)
	if !noData || cur != "" || dir != DirNoData {
		t.Fatalf("null current %v %s %s", noData, cur, dir)
	}
	noData, cur, past, dir = Present("OK", &zero, nil, nil)
	if noData || cur != "0" || past != "" || dir != DirFlat {
		t.Fatalf("real zero %v %s %s %s", noData, cur, past, dir)
	}
	noData, cur, _, dir = Present("OK", &zero, nil, &prev)
	if noData || cur != "0" || dir != DirDown {
		t.Fatalf("down %v %s %s", noData, cur, dir)
	}
	two := "2"
	_, _, _, dir = Present("OK", &two, nil, &prev)
	if dir != DirUp {
		t.Fatal(dir)
	}
}

func TestStaggerBuckets(t *testing.T) {
	if Tick(0) != DefaultTick || Tick(time.Minute) != time.Minute {
		t.Fatal("tick")
	}
	if Slots(DefaultSyncInterval, DefaultTick) != 24 {
		t.Fatal(Slots(DefaultSyncInterval, DefaultTick))
	}
	if Slots(time.Minute, time.Minute) != 1 || StoreBucket(5, 1) != 0 || TimeBucket(time.Unix(0, 0), time.Minute, 1) != 0 {
		t.Fatal("single slot")
	}
	now := time.Unix(1_700_000_000, 0).UTC()
	tick := DefaultTick
	slots := 4
	bucket := TimeBucket(now, tick, slots)
	if bucket < 0 || bucket >= slots {
		t.Fatal(bucket)
	}
	if StoreBucket(int64(bucket), slots) != bucket {
		t.Fatal("id modulo")
	}
	if StoreBucket(int64(bucket+slots), slots) != bucket {
		t.Fatal("wrap")
	}
	if StoreBucket(int64(bucket+1), slots) == bucket {
		t.Fatal("distinct")
	}
	if DefaultRetention != 90*24*time.Hour || DefaultSyncInterval != 6*time.Hour {
		t.Fatal("constants")
	}
	if !SecretLike("fixture-client-rt1") {
		t.Fatal("client fixture")
	}
}
