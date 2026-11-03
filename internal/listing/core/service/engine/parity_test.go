package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"

	"github.com/xxww0098/podhub-go/internal/listing/core"
)

func TestWasmMatchesNativeOracle(t *testing.T) {
	assertOracle(t, openTags(t))
}

func TestSubmitGateDivergesFromRustFreeze(t *testing.T) {
	engine := openTags(t)
	rules := []Rule{{Term: "сигарета", MatchMode: "stem"}}
	version, err := RulesVersion(rules)
	if err != nil {
		t.Fatal(err)
	}
	verdict, err := Validate(context.Background(), engine, Input{
		OrgID:          7,
		RulesVersion:   version,
		CurrentVersion: version,
		Tags:           []string{"#роза", "#сигареты"},
		Text:           "роза электронная сигарета море",
		Rules:          rules,
	})
	if err != nil {
		t.Fatal(err)
	}
	if verdict.Save.OK || verdict.Save.Message != "标签含受限词，不能保存：#сигареты" {
		t.Fatalf("save %+v", verdict.Save)
	}
	if len(verdict.AI.Kept) != 1 || verdict.AI.Kept[0] != "#роза" || len(verdict.AI.Rejected) != 1 {
		t.Fatalf("ai %+v", verdict.AI)
	}
	// One stem strips the cigarette token and leaves the adjective. The
	// compound rule is what rejects both words together.
	if verdict.BeforeSend.Text != "роза электронная море" || len(verdict.BeforeSend.Rejected) != 1 || verdict.BeforeSend.Rejected[0] != "сигарета" {
		t.Fatalf("before send %+v", verdict.BeforeSend)
	}
	if !verdict.Submit.Rejected || verdict.Submit.RustFreezeChecksTags {
		t.Fatalf("submit must reject while recording that Rust freeze does not check: %+v", verdict.Submit)
	}
	if verdict.Submit.BehaviorChange != SubmitBannedTagBehaviorChange {
		t.Fatal(verdict.Submit.BehaviorChange)
	}
	if verdict.Submit.Message != verdict.Save.Message {
		t.Fatalf("submit message %q save %q", verdict.Submit.Message, verdict.Save.Message)
	}
}

func TestPhraseStripMatchesPreSendAndSubmitRejectsIt(t *testing.T) {
	engine := openTags(t)
	rules := []Rule{{Term: "электронная_сигарета", MatchMode: "stem"}}
	version, err := RulesVersion(rules)
	if err != nil {
		t.Fatal(err)
	}
	verdict, err := Validate(context.Background(), engine, Input{
		RulesVersion:   version,
		CurrentVersion: version,
		Text:           "роза электронная сигарета море",
		Rules:          rules,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !verdict.Save.OK {
		t.Fatal("empty tag list is not a PATCH rejection")
	}
	if verdict.BeforeSend.Text != "роза море" {
		t.Fatalf("%+v", verdict.BeforeSend)
	}
	joined := verdict.BeforeSend.Rejected
	if len(joined) != 2 || joined[0] != "электронная" || joined[1] != "сигарета" {
		t.Fatal(joined)
	}
	if !verdict.Submit.Rejected || verdict.Submit.RustFreezeChecksTags {
		t.Fatalf("%+v", verdict.Submit)
	}
	if verdict.Submit.Message != "标签含受限词，不能保存：электронная、сигарета" {
		t.Fatal(verdict.Submit.Message)
	}
}

func openTags(t *testing.T) *Engine {
	t.Helper()
	mod, err := core.OpenEmbedded(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = mod.Close(context.Background()) })
	return New(mod)
}

func assertOracle(t *testing.T, engine *Engine) {
	t.Helper()
	var rows []struct {
		Name     string          `json:"name"`
		Request  json.RawMessage `json:"request"`
		Response json.RawMessage `json:"response"`
	}
	raw, err := os.ReadFile(repoFile("rust/crates/listing-core-wasm/tests/fixtures/banned_tags/oracle.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) < 70 {
		t.Fatalf("oracle rows %d", len(rows))
	}
	for _, row := range rows {
		var req call
		if err := json.Unmarshal(row.Request, &req); err != nil {
			t.Fatal(row.Name, err)
		}
		got, err := engine.Call(context.Background(), req.Op, req.Tag, req.Text, req.Term, req.Tags, req.Rules)
		if err != nil {
			t.Fatal(row.Name, err)
		}
		encoded, err := marshalJSON(got)
		if err != nil {
			t.Fatal(err)
		}
		var want bytes.Buffer
		if err := json.Compact(&want, row.Response); err != nil {
			t.Fatal(row.Name, err)
		}
		if !bytes.Equal(encoded, want.Bytes()) {
			t.Fatalf("%s\n got %s\n want %s", row.Name, encoded, want.Bytes())
		}
	}
}

func repoFile(rel string) string {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return rel
	}
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "..", rel)
}

// Tag calls share the listing-core guest pool. Under contention every call
// must still see its own result, in input order.
func TestBannedOutcomeOrderUnderSharedPool(t *testing.T) {
	engine := openTags(t)
	rules := []Rule{{Term: "сигарета", MatchMode: "stem"}}
	tags := []string{"#роза", "#сигареты", "#море"}
	var wg sync.WaitGroup
	errs := make(chan error, 64)
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := engine.Call(context.Background(), "partition", "", "", "", tags, rules)
			if err != nil {
				errs <- err
				return
			}
			if len(got.Kept) != 2 || got.Kept[0] != "#роза" || got.Kept[1] != "#море" ||
				len(got.Rejected) != 1 || got.Rejected[0] != "#сигареты" {
				errs <- fmt.Errorf("order %+v", got)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}
