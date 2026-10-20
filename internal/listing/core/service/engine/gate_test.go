package engine

import (
	"context"
	"testing"
)

func TestThreeGatesShareOneWasmCall(t *testing.T) {
	engine, err := OpenEmbedded(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close(context.Background()) })
	rules := []Rule{{Term: "сигарета", MatchMode: "stem"}}
	version, err := RulesVersion(rules)
	if err != nil {
		t.Fatal(err)
	}
	verdict, err := Validate(context.Background(), engine, Input{
		RulesVersion:   version,
		CurrentVersion: version,
		Tags:           []string{"#роза", "#сигареты"},
		Text:           "роза электронная сигарета море",
		Rules:          rules,
	})
	if err != nil {
		t.Fatal(err)
	}
	save, err := ForbidSave(context.Background(), engine, []string{"#роза", "#сигареты"}, rules)
	if err != nil {
		t.Fatal(err)
	}
	if save.OK != verdict.Save.OK || save.Message != verdict.Save.Message {
		t.Fatalf("save gate %+v verdict %+v", save, verdict.Save)
	}
	ai, err := StripForAI(context.Background(), engine, []string{"#роза", "#сигареты"}, rules)
	if err != nil {
		t.Fatal(err)
	}
	if len(ai.Kept) != 1 || ai.Kept[0] != verdict.AI.Kept[0] || ai.Message != verdict.AI.Message {
		t.Fatalf("ai gate %+v verdict %+v", ai, verdict.AI)
	}
	send, err := StripBeforeSend(context.Background(), engine, "роза электронная сигарета море", rules)
	if err != nil {
		t.Fatal(err)
	}
	if send.Text != verdict.BeforeSend.Text || len(send.Rejected) != len(verdict.BeforeSend.Rejected) {
		t.Fatalf("send gate %+v verdict %+v", send, verdict.BeforeSend)
	}
	if _, err := ForbidSave(context.Background(), nil, nil, nil); err == nil {
		t.Fatal("nil engine must fail closed")
	}
	if _, err := CanonicalTerm(context.Background(), engine, "  Сигарета  "); err != nil {
		t.Fatal(err)
	}
	if _, err := CanonicalTerm(context.Background(), engine, ""); err != ErrTermLength {
		t.Fatal(err)
	}
}
