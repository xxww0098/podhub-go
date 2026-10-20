// Package core loads the listing-core wasm (handwritten C ABI, not WASI).
// The browser op table is unchanged. snapshot_from_fields is a host-only
// export of the same Rust function Cloud uses to recompute a schema revision.
// wazero itself lives in internal/platform/wasm.
package core

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"

	"github.com/xxww0098/podhub-go/internal/listing/core/contract"
	_ "github.com/xxww0098/podhub-go/internal/listing/core/service/engine"
	"github.com/xxww0098/podhub-go/internal/platform/wasm"
	wasmembed "github.com/xxww0098/podhub-go/wasm"
)

// guestPoolSize is the process cap on live listing-core instances.
// Benchmarks construct pools of 2 and GOMAXPROCS through openSized.
const guestPoolSize = 4

// Bytes come from wasm/embed.go. go:embed cannot see files outside this package.
var embedded = wasmembed.ListingCore

// Op numbers stay available on this package for callers inside the unit.
const (
	OpSeedRow            = contract.OpSeedRow
	OpEditRow            = contract.OpEditRow
	OpSettleRecognition  = contract.OpSettleRecognition
	OpDecideCandidates   = contract.OpDecideCandidates
	OpRecordRender       = contract.OpRecordRender
	OpRecordUpload       = contract.OpRecordUpload
	OpRevalidate         = contract.OpRevalidate
	OpValuesEqual        = contract.OpValuesEqual
	OpSubmitDraft        = contract.OpSubmitDraft
	OpSchemaRevision     = contract.OpSchemaRevision
	OpFreezeListing      = contract.OpFreezeListing
	OpProjectSubmitDraft = contract.OpProjectSubmitDraft
	OpIssueManifest      = contract.OpIssueManifest
)

// Module is a compiled listing-core module plus a bounded guest pool.
// Each call borrows one instance, because an instance has one result slot.
// A trap drops only that instance. A full pool queues; the call is not dropped.
type Module struct {
	rt      *wasm.Compiled
	pool    *wasm.Pool
	seq     atomic.Uint64
	exports []string
}

var serverExports = []string{
	"alloc", "free", "schema_load", "schema_drop", "call",
	"result_ptr", "result_len", "drop_result", "last_error_ptr", "last_error_len",
	"snapshot_from_fields",
}

var browserExports = []string{
	"alloc", "free", "schema_load", "schema_drop", "call",
	"result_ptr", "result_len", "drop_result", "last_error_ptr", "last_error_len",
	"send_transition",
}

// OpenEmbedded loads the wasm committed beside this file.
func OpenEmbedded(ctx context.Context) (*Module, error) {
	return Open(ctx, embedded)
}

var (
	sharedOnce sync.Once
	sharedMod  *Module
	sharedErr  error
)

// Shared compiles the embedded module once. A trap drops the instance;
// the compiled module stays.
func Shared(context.Context) (*Module, error) {
	sharedOnce.Do(func() {
		sharedMod, sharedErr = OpenEmbedded(context.Background())
	})
	if sharedErr != nil {
		return nil, sharedErr
	}
	return sharedMod, nil
}

// Open compiles a wasm32-unknown-unknown listing-core-wasm artifact.
// It refuses a module that is missing a server export, including
// snapshot_from_fields, instead of waiting for the first call.
func Open(ctx context.Context, buf []byte) (*Module, error) {
	return openSized(ctx, buf, guestPoolSize)
}

// OpenBrowser compiles the browser listing state machine. It requires
// send_transition and does not require snapshot_from_fields.
func OpenBrowser(ctx context.Context, buf []byte) (*Module, error) {
	mod, err := openChecked(ctx, buf, guestPoolSize)
	if err != nil {
		return nil, err
	}
	mod.exports = browserExports
	if err := mod.probeExports(ctx); err != nil {
		_ = mod.Close(ctx)
		return nil, err
	}
	return mod, nil
}

// openSized compiles buf and keeps n guests. Tests and benchmarks pass n.
func openSized(ctx context.Context, buf []byte, n int) (*Module, error) {
	mod, err := openChecked(ctx, buf, n)
	if err != nil {
		return nil, err
	}
	mod.exports = serverExports
	if err := mod.probeExports(ctx); err != nil {
		_ = mod.Close(ctx)
		return nil, err
	}
	return mod, nil
}

func openChecked(ctx context.Context, buf []byte, n int) (*Module, error) {
	rt, err := wasm.Compile(ctx, buf)
	if err != nil {
		if rt != nil {
			_ = rt.Close(ctx)
		}
		return nil, fmt.Errorf("compile listing-core wasm: %w", err)
	}
	return &Module{rt: rt, pool: wasm.NewPool(n)}, nil
}

// Close releases the runtime.
func (m *Module) Close(ctx context.Context) error {
	if m == nil || m.rt == nil {
		return nil
	}
	return m.rt.Close(ctx)
}

// Call runs one op against a freshly loaded schema. schema may be nil for
// ops that ignore the handle (op 9, 12, 13). The returned bytes are the
// module's result buffer, copied out.
func (m *Module) Call(ctx context.Context, op uint32, schema, body []byte) ([]byte, error) {
	if m == nil || m.rt == nil {
		return nil, fmt.Errorf("listing-core wasm is not loaded")
	}
	slot, err := m.pool.Borrow(ctx)
	if err != nil {
		return nil, err
	}
	defer m.pool.Return(slot)
	guest, err := m.instance(ctx, slot)
	if err != nil {
		return nil, err
	}
	var handle uint32
	if len(schema) > 0 {
		handle, err = m.schemaLoad(ctx, slot, guest, schema)
		if err != nil {
			return nil, err
		}
		defer func() { _, _ = guest.Call(context.Background(), "schema_drop", uint64(handle)) }()
	}
	return m.call(ctx, slot, guest, op, handle, body)
}

// Snapshot recomputes a CategorySchemaSnapshot from cached catalog fields.
// The schema revision ignores field order. The fields array stays in the
// order the cache returned, which is the display order.
func (m *Module) Snapshot(ctx context.Context, raw []byte) ([]byte, error) {
	return m.orderIndependentSnapshot(ctx, raw)
}

// LegacyRevision is the order-sensitive hash the wasm still computes when
// fields are passed through in cache order. Rows saved by Rust carry it.
func (m *Module) LegacyRevision(ctx context.Context, raw []byte) (string, error) {
	out, err := m.snapshotWasm(ctx, raw)
	if err != nil {
		return "", err
	}
	rev, ok := schemaRevisionOf(out)
	if !ok || rev == "" {
		return "", fmt.Errorf("listing-core snapshot has no schema_revision")
	}
	return rev, nil
}

// snapshotWasm calls snapshot_from_fields on the bytes it is given.
func (m *Module) snapshotWasm(ctx context.Context, raw []byte) ([]byte, error) {
	if m == nil || m.rt == nil {
		return nil, fmt.Errorf("listing-core wasm is not loaded")
	}
	slot, err := m.pool.Borrow(ctx)
	if err != nil {
		return nil, err
	}
	defer m.pool.Return(slot)
	guest, err := m.instance(ctx, slot)
	if err != nil {
		return nil, err
	}
	ptr, err := m.alloc(ctx, guest, len(raw))
	if err != nil {
		slot.Close(ctx)
		return nil, err
	}
	if !guest.Write(ptr, raw) {
		slot.Close(ctx)
		return nil, fmt.Errorf("listing-core wasm memory write failed")
	}
	status, callErr := guest.Call(ctx, "snapshot_from_fields", uint64(ptr), uint64(len(raw)))
	_, _ = guest.Call(context.Background(), "free", uint64(ptr), uint64(len(raw)))
	if callErr != nil {
		slot.Close(ctx)
		return nil, fmt.Errorf("listing-core snapshot trapped: %w", callErr)
	}
	if len(status) != 1 || uint32(status[0]) != 0 {
		return nil, contract.SlotError("listing-core snapshot rejected the call", readSlot(guest, "last_error_ptr", "last_error_len"))
	}
	return append([]byte(nil), readSlot(guest, "result_ptr", "result_len")...), nil
}

// SendTransition runs the browser pure function (state, event) -> {state, allowPost}.
func (m *Module) SendTransition(ctx context.Context, state, event string) (string, bool, error) {
	if m == nil || m.rt == nil {
		return "", false, fmt.Errorf("listing-core wasm is not loaded")
	}
	raw := []byte(`{"state":"` + state + `","event":"` + event + `"}`)
	slot, err := m.pool.Borrow(ctx)
	if err != nil {
		return "", false, err
	}
	defer m.pool.Return(slot)
	guest, err := m.instance(ctx, slot)
	if err != nil {
		return "", false, err
	}
	ptr, err := m.alloc(ctx, guest, len(raw))
	if err != nil {
		slot.Close(ctx)
		return "", false, err
	}
	if !guest.Write(ptr, raw) {
		slot.Close(ctx)
		return "", false, fmt.Errorf("listing-core wasm memory write failed")
	}
	status, callErr := guest.Call(ctx, "send_transition", uint64(ptr), uint64(len(raw)))
	_, _ = guest.Call(context.Background(), "free", uint64(ptr), uint64(len(raw)))
	if callErr != nil {
		slot.Close(ctx)
		return "", false, fmt.Errorf("listing-core send_transition trapped: %w", callErr)
	}
	if len(status) != 1 || uint32(status[0]) != 0 {
		return "", false, contract.SlotError("listing-core send_transition rejected", readSlot(guest, "last_error_ptr", "last_error_len"))
	}
	out := readSlot(guest, "result_ptr", "result_len")
	var parsed struct {
		State     string `json:"state"`
		AllowPost bool   `json:"allowPost"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		return "", false, err
	}
	return parsed.State, parsed.AllowPost, nil
}

// HasExport reports whether the guest exports name.
func (m *Module) HasExport(ctx context.Context, name string) bool {
	if m == nil || m.rt == nil {
		return false
	}
	slot, err := m.pool.Borrow(ctx)
	if err != nil {
		return false
	}
	defer m.pool.Return(slot)
	guest, err := m.instance(ctx, slot)
	if err != nil {
		return false
	}
	return guest.Exported(name)
}

func (m *Module) schemaLoad(ctx context.Context, slot *wasm.Slot, guest *wasm.Guest, raw []byte) (uint32, error) {
	ptr, err := m.alloc(ctx, guest, len(raw))
	if err != nil {
		return 0, err
	}
	if !guest.Write(ptr, raw) {
		return 0, fmt.Errorf("listing-core wasm memory write failed")
	}
	out, err := guest.Call(ctx, "schema_load", uint64(ptr), uint64(len(raw)))
	_, _ = guest.Call(context.Background(), "free", uint64(ptr), uint64(len(raw)))
	if err != nil {
		slot.Close(ctx)
		return 0, fmt.Errorf("listing-core schema_load trapped: %w", err)
	}
	if len(out) != 1 || uint32(out[0]) == 0 {
		return 0, contract.SlotError("listing-core schema_load failed", readSlot(guest, "last_error_ptr", "last_error_len"))
	}
	return uint32(out[0]), nil
}

func (m *Module) call(ctx context.Context, slot *wasm.Slot, guest *wasm.Guest, op, handle uint32, body []byte) ([]byte, error) {
	ptr, err := m.alloc(ctx, guest, len(body))
	if err != nil {
		return nil, err
	}
	if len(body) > 0 && !guest.Write(ptr, body) {
		return nil, fmt.Errorf("listing-core wasm memory write failed")
	}
	status, err := guest.Call(ctx, "call", uint64(op), uint64(handle), uint64(ptr), uint64(len(body)))
	_, _ = guest.Call(context.Background(), "free", uint64(ptr), uint64(len(body)))
	if err != nil {
		slot.Close(ctx)
		return nil, fmt.Errorf("listing-core call trapped: %w", err)
	}
	if len(status) != 1 || uint32(status[0]) != 0 {
		return nil, contract.SlotError("listing-core call rejected", readSlot(guest, "last_error_ptr", "last_error_len"))
	}
	out := append([]byte(nil), readSlot(guest, "result_ptr", "result_len")...)
	_, _ = guest.Call(context.Background(), "drop_result")
	return out, nil
}

// probeExports instantiates one guest so a missing export fails at Open.
func (m *Module) probeExports(ctx context.Context) error {
	slot, err := m.pool.Borrow(ctx)
	if err != nil {
		return err
	}
	defer m.pool.Return(slot)
	_, err = m.instance(ctx, slot)
	return err
}

func (m *Module) instance(ctx context.Context, slot *wasm.Slot) (*wasm.Guest, error) {
	if slot.Guest != nil {
		return slot.Guest, nil
	}
	name := fmt.Sprintf("listing-core-%d", m.seq.Add(1))
	guest, err := m.rt.Instantiate(ctx, name)
	if err != nil {
		return nil, fmt.Errorf("instantiate listing-core wasm: %w", err)
	}
	exports := m.exports
	if len(exports) == 0 {
		exports = serverExports
	}
	for _, export := range exports {
		if !guest.Exported(export) {
			_ = guest.Close(ctx)
			return nil, fmt.Errorf("listing-core wasm missing export %s", export)
		}
	}
	slot.Guest = guest
	return guest, nil
}

func (m *Module) alloc(ctx context.Context, guest *wasm.Guest, n int) (uint32, error) {
	out, err := guest.Call(ctx, "alloc", uint64(n))
	if err != nil {
		return 0, fmt.Errorf("listing-core alloc: %w", err)
	}
	if len(out) != 1 || uint32(out[0]) == 0 {
		return 0, fmt.Errorf("listing-core alloc returned null")
	}
	return uint32(out[0]), nil
}

func readSlot(guest *wasm.Guest, ptrName, lenName string) []byte {
	ctx := context.Background()
	p, err := guest.Call(ctx, ptrName)
	if err != nil || len(p) != 1 {
		return nil
	}
	n, err := guest.Call(ctx, lenName)
	if err != nil || len(n) != 1 || n[0] == 0 {
		return nil
	}
	buf, ok := guest.Read(uint32(p[0]), uint32(n[0]))
	if !ok {
		return nil
	}
	return buf
}
