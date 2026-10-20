package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

func TestWasmMatchesNativeOracle(t *testing.T) {
	engine := openTags(t, embeddedTagsWASM)
	t.Cleanup(func() { _ = engine.Close(context.Background()) })
	assertOracle(t, engine)
	logImports(t, embeddedTagsWASM)
}

func TestReadEnvFileResolvesRepoRelativePath(t *testing.T) {
	t.Setenv("LISTING_TAGS_WASM", "rust/crates/listing-tags/testdata/oracle.json")
	data, err := TagsWASMFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(data, []byte(`"name"`)) {
		t.Fatalf("oracle not read from module root, %d bytes", len(data))
	}
}

func TestRebuiltWasmMatchesNativeOracle(t *testing.T) {
	raw, err := TagsWASMFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if raw == nil {
		t.Skip("LISTING_TAGS_WASM is unset")
	}
	engine := openTags(t, raw)
	t.Cleanup(func() { _ = engine.Close(context.Background()) })
	assertOracle(t, engine)
}

func TestSubmitGateDivergesFromRustFreeze(t *testing.T) {
	engine := openTags(t, embeddedTagsWASM)
	t.Cleanup(func() { _ = engine.Close(context.Background()) })
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
	engine := openTags(t, embeddedTagsWASM)
	t.Cleanup(func() { _ = engine.Close(context.Background()) })
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

func TestWazeroHostSatisfiesFillRandom(t *testing.T) {
	// The host probe is a test-only module. It is committed under
	// wasm/dist/test/ and is not part of the embedded production set.
	committed, err := os.ReadFile(repoFile("wasm/dist/test/host-probe.wasm"))
	if err != nil {
		t.Fatal(err)
	}
	exerciseProbe(t, committed)
	raw, err := ProbeWASMFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if raw != nil {
		exerciseProbe(t, raw)
	}
}

func exerciseProbe(t *testing.T, wasm []byte) {
	t.Helper()
	ctx := context.Background()
	rt := wazero.NewRuntime(ctx)
	t.Cleanup(func() { _ = rt.Close(context.Background()) })
	_, err := rt.NewHostModuleBuilder("env").
		NewFunctionBuilder().
		WithFunc(func(_ context.Context, mod api.Module, ptr, n uint32) {
			buf := bytes.Repeat([]byte{7}, int(n))
			if !mod.Memory().Write(ptr, buf) {
				t.Errorf("fill_random write")
			}
		}).
		Export("fill_random").
		Instantiate(ctx)
	if err != nil {
		t.Fatal(err)
	}
	mod, err := rt.InstantiateWithConfig(ctx, wasm, wazero.NewModuleConfig().WithName("probe"))
	if err != nil {
		t.Fatal(err)
	}
	sum, err := mod.ExportedFunction("sum_random").Call(ctx, 4)
	if err != nil || len(sum) != 1 || sum[0] != 28 {
		t.Fatalf("sum %v %v", sum, err)
	}
	hits, err := mod.ExportedFunction("hits").Call(ctx)
	if err != nil || hits[0] != 1 {
		t.Fatalf("hits %v %v", hits, err)
	}
	if _, err := mod.ExportedFunction("boom").Call(ctx); err == nil {
		t.Fatal("panic must trap")
	}
}

func openTags(t *testing.T, wasm []byte) *Engine {
	t.Helper()
	engine, err := Open(context.Background(), wasm)
	if err != nil {
		t.Fatal(err)
	}
	return engine
}

func assertOracle(t *testing.T, engine *Engine) {
	t.Helper()
	var rows []struct {
		Name     string          `json:"name"`
		Request  json.RawMessage `json:"request"`
		Response json.RawMessage `json:"response"`
	}
	raw, err := os.ReadFile(repoFile("rust/crates/listing-tags/testdata/oracle.json"))
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

func logImports(t *testing.T, wasm []byte) {
	t.Helper()
	ctx := context.Background()
	rt := wazero.NewRuntime(ctx)
	defer rt.Close(ctx)
	compiled, err := rt.CompileModule(ctx, wasm)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, fn := range compiled.ImportedFunctions() {
		names = append(names, fn.ModuleName()+"."+fn.Name())
	}
	t.Logf("listing-tags imports: %v", names)
}

func repoFile(rel string) string {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return rel
	}
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "..", rel)
}
