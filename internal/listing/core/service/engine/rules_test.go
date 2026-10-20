package engine

import (
	"context"
	"testing"
)

func TestValidateFailsClosedWithoutEngine(t *testing.T) {
	_, err := Validate(context.Background(), nil, Input{
		OrgID:          1,
		RulesVersion:   "abc",
		CurrentVersion: "abc",
		Tags:           []string{"роза"},
		Rules:          []Rule{{Term: "роза", MatchMode: "exact"}},
	})
	if err == nil {
		t.Fatal("nil engine passed")
	}
}

func TestStaleRulesAreNotAPass(t *testing.T) {
	_, err := Validate(context.Background(), nil, Input{
		RulesVersion:   "old",
		CurrentVersion: "new",
	})
	if err != ErrRulesStale {
		t.Fatalf("got %v", err)
	}
}

func TestRulesVersionIsStable(t *testing.T) {
	rules := []Rule{
		{Term: "сигарета", MatchMode: "stem"},
		{Term: "роза", MatchMode: "exact"},
	}
	first, err := RulesVersion(rules)
	if err != nil {
		t.Fatal(err)
	}
	second, err := RulesVersion(append([]Rule(nil), rules...))
	if err != nil || first != second || len(first) != 64 {
		t.Fatalf("%s %s %v", first, second, err)
	}
	other, err := RulesVersion([]Rule{{Term: "роза", MatchMode: "exact"}})
	if err != nil || other == first {
		t.Fatal(other)
	}
}
