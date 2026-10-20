package domain

import "testing"

func TestStoreFreshness(t *testing.T) {
	now := int64(1_000_000_000_000)
	if StoreFreshness(nil, 0, now) != "never" {
		t.Fatal("never")
	}
	recent := now - int64(ReconcileIntervalMS)
	if StoreFreshness(&recent, 0, now) != "fresh" {
		t.Fatal("fresh")
	}
	stale := now - int64(ReconcileIntervalMS)*3
	if StoreFreshness(&stale, 0, now) != "stale" {
		t.Fatal("stale")
	}
	old := now - int64(ExpiredAfterMS)
	if StoreFreshness(&old, 0, now) != "expired" {
		t.Fatal("age")
	}
	if StoreFreshness(&recent, 3, now) != "expired" {
		t.Fatal("failures")
	}
	one := int64(1)
	if !CountsReadable("fresh", []*int64{&one, &one, &one, &one, &one, &one, &one, &one}) {
		t.Fatal("readable")
	}
	if CountsReadable("expired", []*int64{&one}) || CountsReadable("fresh", []*int64{nil}) {
		t.Fatal("not readable")
	}
}

func TestCursorAndNeedle(t *testing.T) {
	scope := func(id string) bool { return id == "11111111-1111-4111-8111-111111111111" }
	store, product, err := ParseCursor("11111111-1111-4111-8111-111111111111:42", scope)
	if err != nil || product != 42 || store == "" {
		t.Fatal(err, store, product)
	}
	if _, _, err := ParseCursor("11111111-1111-4111-8111-111111111111:0", scope); err == nil || err.Message != "cursor 无效" {
		t.Fatal(err)
	}
	if _, _, err := ParseCursor("22222222-2222-4222-8222-222222222222:1", scope); err == nil || err.Message != "cursor 不属于当前范围" {
		t.Fatal(err)
	}
	needle, err := LikeNeedle(` 100%_off\ `)
	if err != nil || needle != `100\%\_off\\` {
		t.Fatal(needle, err)
	}
	if _, err := LikeNeedle(string(make([]byte, 257))); err == nil {
		t.Fatal("len")
	}
	if limit, err := ProductLimit(nil); err != nil || limit != 100 {
		t.Fatal(limit, err)
	}
	too := int64(201)
	if _, err := ProductLimit(&too); err == nil {
		t.Fatal("limit")
	}
	if sql, ok := StatusPredicate("zero_stock"); !ok || sql != "d.state = 'on_sale' AND p.stock_present = 0" {
		t.Fatal(sql, ok)
	}
	if _, ok := StatusPredicate("nope"); ok {
		t.Fatal("status")
	}
}
