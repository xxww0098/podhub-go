package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"

	"github.com/xxww0098/podhub-go/internal/listing/core/contract"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	wasmhost "github.com/xxww0098/podhub-go/internal/platform/wasm"
	wasmembed "github.com/xxww0098/podhub-go/wasm"
)

// guestPoolSize is the process cap on live listing-tags instances.
// Benchmarks construct pools of 2 and GOMAXPROCS through openSized.
const guestPoolSize = 4

type (
	Rule    = contract.Rule
	Outcome = contract.Outcome
)

// Bytes come from wasm/embed.go. go:embed cannot see files outside this package.
var embeddedTagsWASM = wasmembed.ListingTags

// Engine runs the narrow banned-tag wasm. Each call borrows one instance,
// because the module keeps one result buffer. A trap closes only that
// instance. A full pool queues; the call is not dropped. An engine error
// is a failure, not a pass.
type Engine struct {
	rt   *wasmhost.Compiled
	pool *wasmhost.Pool
	seq  atomic.Uint64
}

// OpenEmbedded loads the wasm shipped in this module.
func OpenEmbedded(ctx context.Context) (*Engine, error) {
	return Open(ctx, embeddedTagsWASM)
}

// Open compiles wasm produced from rust/crates/listing-tags.
func Open(ctx context.Context, wasm []byte) (*Engine, error) {
	return openSized(ctx, wasm, guestPoolSize)
}

// openSized compiles wasm and keeps n guests. Tests and benchmarks pass n.
func openSized(ctx context.Context, wasm []byte, n int) (*Engine, error) {
	rt, err := wasmhost.Compile(ctx, wasm)
	if err != nil {
		return nil, fmt.Errorf("compile listing tags wasm: %w", err)
	}
	return &Engine{rt: rt, pool: wasmhost.NewPool(n)}, nil
}

// Close releases the runtime.
func (e *Engine) Close(ctx context.Context) error {
	if e == nil || e.rt == nil {
		return nil
	}
	return e.rt.Close(ctx)
}

// Call runs one op. rules are stored terms; this function does not rewrite them.
func (e *Engine) Call(ctx context.Context, op, tag, text, term string, tags []string, rules []Rule) (Outcome, error) {
	if e == nil || e.rt == nil {
		return Outcome{}, fmt.Errorf("listing tags wasm is not loaded")
	}
	if tags == nil {
		tags = []string{}
	}
	if rules == nil {
		rules = []Rule{}
	}
	raw, err := marshalJSON(call{
		Op:    op,
		Tag:   tag,
		Tags:  tags,
		Text:  text,
		Term:  term,
		Rules: rules,
	})
	if err != nil {
		return Outcome{}, err
	}
	slot, err := e.pool.Borrow(ctx)
	if err != nil {
		return Outcome{}, err
	}
	defer e.pool.Return(slot)
	body, err := e.eval(ctx, slot, raw)
	if err != nil {
		return Outcome{}, err
	}
	var out Outcome
	if err := json.Unmarshal(body, &out); err != nil {
		return Outcome{}, fmt.Errorf("decode listing tags result: %w", err)
	}
	if out.Kept == nil {
		out.Kept = []string{}
	}
	if out.Rejected == nil {
		out.Rejected = []string{}
	}
	return out, nil
}

func (e *Engine) eval(ctx context.Context, slot *wasmhost.Slot, raw []byte) ([]byte, error) {
	mod, err := e.instance(ctx, slot)
	if err != nil {
		return nil, err
	}
	ptr, err := e.alloc(ctx, mod, len(raw))
	if err != nil {
		slot.Close(ctx)
		return nil, err
	}
	if !mod.Write(ptr, raw) {
		slot.Close(ctx)
		return nil, fmt.Errorf("listing tags wasm memory write failed")
	}
	status, callErr := mod.Call(ctx, "eval", uint64(ptr), uint64(len(raw)))
	_, _ = mod.Call(context.Background(), "dealloc", uint64(ptr), uint64(len(raw)))
	if callErr != nil {
		slot.Close(ctx)
		return nil, fmt.Errorf("listing tags wasm trapped: %w", callErr)
	}
	if len(status) != 1 || status[0] != 0 {
		message := e.readSlot(mod, "last_error_ptr", "last_error_len")
		return nil, fmt.Errorf("listing tags wasm rejected the call: %s", message)
	}
	return append([]byte(nil), e.readSlot(mod, "result_ptr", "result_len")...), nil
}

func (e *Engine) instance(ctx context.Context, slot *wasmhost.Slot) (*wasmhost.Guest, error) {
	if slot.Guest != nil {
		return slot.Guest, nil
	}
	name := fmt.Sprintf("listing-tags-%d", e.seq.Add(1))
	mod, err := e.rt.Instantiate(ctx, name)
	if err != nil {
		return nil, fmt.Errorf("instantiate listing tags wasm: %w", err)
	}
	for _, export := range []string{"alloc", "dealloc", "eval", "result_ptr", "result_len", "last_error_ptr", "last_error_len"} {
		if !mod.Exported(export) {
			_ = mod.Close(ctx)
			return nil, fmt.Errorf("listing tags wasm missing export %s", export)
		}
	}
	slot.Guest = mod
	return mod, nil
}

func (e *Engine) alloc(ctx context.Context, mod *wasmhost.Guest, n int) (uint32, error) {
	out, err := mod.Call(ctx, "alloc", uint64(n))
	if err != nil {
		return 0, fmt.Errorf("listing tags alloc: %w", err)
	}
	if len(out) != 1 || uint32(out[0]) == 0 {
		return 0, fmt.Errorf("listing tags alloc returned null")
	}
	return uint32(out[0]), nil
}

func (e *Engine) readSlot(mod *wasmhost.Guest, ptrName, lenName string) []byte {
	ctx := context.Background()
	p, err := mod.Call(ctx, ptrName)
	if err != nil || len(p) != 1 {
		return nil
	}
	n, err := mod.Call(ctx, lenName)
	if err != nil || len(n) != 1 || n[0] == 0 {
		return nil
	}
	buf, ok := mod.Read(uint32(p[0]), uint32(n[0]))
	if !ok {
		return nil
	}
	return buf
}

func marshalJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

type call struct {
	Op    string   `json:"op"`
	Tag   string   `json:"tag"`
	Tags  []string `json:"tags"`
	Text  string   `json:"text"`
	Term  string   `json:"term"`
	Rules []Rule   `json:"rules"`
}

// TagsWASMFromEnv returns a freshly built module when LISTING_TAGS_WASM is set.
func TagsWASMFromEnv() ([]byte, error) {
	return readEnvFile(config.ListingTagsWASMPath())
}

// ProbeWASMFromEnv returns a freshly built probe when WASM_HOST_PROBE is set.
func ProbeWASMFromEnv() ([]byte, error) {
	return readEnvFile(config.WASMHostProbePath())
}

// readEnvFile opens a path taken from the environment. go test uses the
// package directory as its working directory, so a repo-relative path is also
// tried from the module root.
func readEnvFile(path string) ([]byte, error) {
	if path == "" {
		return nil, nil
	}
	data, err := os.ReadFile(path)
	if err == nil || filepath.IsAbs(path) {
		return data, err
	}
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return nil, err
	}
	// engine.go sits five directories under the module root.
	rooted := filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "..", path)
	data, rootedErr := os.ReadFile(rooted)
	if rootedErr != nil {
		return nil, err
	}
	return data, nil
}
