package uuidx

import "testing"

func TestStrictUUID(t *testing.T) {
	got, ok := StrictUUID(" 11111111-1111-4111-8111-111111111111 ")
	if !ok || got != "11111111-1111-4111-8111-111111111111" {
		t.Fatal(got, ok)
	}
	upper, ok := StrictUUID("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE")
	if !ok || upper != "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" {
		t.Fatal(upper, ok)
	}
	for _, bad := range []string{
		"",
		"11111111111141118111111111111111",
		"gggggggg-1111-4111-8111-111111111111",
		"11111111-1111-4111-8111-11111111111",
		"111111111111411181111111111111111",
	} {
		if _, ok := StrictUUID(bad); ok {
			t.Fatal(bad)
		}
	}
}
