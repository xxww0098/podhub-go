package domain

import "testing"

func i64p(n int64) *int64 { return &n }

func TestOrderQuery(t *testing.T) {
	q, err := ParseOrderQuery(" ready ", " src ", i64p(4), "", i64p(0))
	if err != nil || q.State != "ready" || q.SourceID != "src" || q.OrgID != 4 || q.Limit != 1 || q.CursorMS != nil {
		t.Fatalf("%+v %v", q, err)
	}
	q, err = ParseOrderQuery("", "", nil, "", i64p(80))
	if err != nil || q.Limit != 50 || q.OrgID != 0 {
		t.Fatalf("%+v %v", q, err)
	}
	if _, err := ParseOrderQuery("bogus", "", nil, "", nil); err == nil || err.Error() != "state 过滤值无效" || err.Code != "validation" {
		t.Fatal(err)
	}
	if _, err := ParseOrderQuery("", "", nil, "not-a-cursor", nil); err == nil || err.Error() != "cursor 无效" {
		t.Fatal(err)
	}
	ms, id, ok := DecodeCursor("1789900000000:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")
	if !ok || ms != 1789900000000 || id != "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" {
		t.Fatalf("%d %s %v", ms, id, ok)
	}
}

func TestCanonicalUUID(t *testing.T) {
	id, ok := CanonicalUUID("  AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA ")
	if !ok || id != "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" {
		t.Fatalf("%s %v", id, ok)
	}
	if _, ok := CanonicalUUID("nope"); ok {
		t.Fatal("accepted")
	}
}
