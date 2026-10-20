package db

import "testing"

func TestSQLVerb(t *testing.T) {
	cases := map[string]string{
		"":                         "",
		"  select 1":               "SELECT",
		"\n\t  UPDATE t SET a = 1": "UPDATE",
		"-- name: GetThing :one\nSELECT * FROM t": "SELECT",
		"-- only a comment\n":                     "",
	}
	for sql, want := range cases {
		if got := sqlVerb(sql); got != want {
			t.Fatalf("%q: %q want %q", sql, got, want)
		}
	}
}
