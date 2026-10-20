// Package wasm is the only place that imports wazero. Callers pass a
// wasm32 module that imports env.fill_random and receive a guest whose
// exports can be called by name.
package wasm

import (
	"context"
	"crypto/rand"
	"fmt"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

// Compiled is one wasm module plus the env.fill_random host import.
type Compiled struct {
	rt       wazero.Runtime
	compiled wazero.CompiledModule
}

// Compile installs env.fill_random and compiles buf.
func Compile(ctx context.Context, buf []byte) (*Compiled, error) {
	rt := wazero.NewRuntime(ctx)
	if _, err := rt.NewHostModuleBuilder("env").
		NewFunctionBuilder().
		WithFunc(fillRandom).
		Export("fill_random").
		Instantiate(ctx); err != nil {
		_ = rt.Close(ctx)
		return nil, err
	}
	compiled, err := rt.CompileModule(ctx, buf)
	if err != nil {
		_ = rt.Close(ctx)
		return nil, err
	}
	return &Compiled{rt: rt, compiled: compiled}, nil
}

func fillRandom(_ context.Context, mod api.Module, ptr, n uint32) {
	if n == 0 {
		return
	}
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return
	}
	_ = mod.Memory().Write(ptr, buf)
}

// Close releases the runtime.
func (c *Compiled) Close(ctx context.Context) error {
	if c == nil || c.rt == nil {
		return nil
	}
	return c.rt.Close(ctx)
}

// Instantiate starts one instance. name is the module name wazero records.
func (c *Compiled) Instantiate(ctx context.Context, name string) (*Guest, error) {
	if c == nil || c.compiled == nil {
		return nil, fmt.Errorf("wasm module is not compiled")
	}
	mod, err := c.rt.InstantiateModule(ctx, c.compiled, wazero.NewModuleConfig().WithName(name))
	if err != nil {
		return nil, err
	}
	return &Guest{mod: mod}, nil
}

// Guest is one instantiated module.
type Guest struct {
	mod api.Module
}

// Close drops the instance. The compiled module stays usable.
func (g *Guest) Close(ctx context.Context) error {
	if g == nil || g.mod == nil {
		return nil
	}
	return g.mod.Close(ctx)
}

// Exported reports whether name is a function export.
func (g *Guest) Exported(name string) bool {
	return g != nil && g.mod != nil && g.mod.ExportedFunction(name) != nil
}

// Call invokes a function export.
func (g *Guest) Call(ctx context.Context, name string, args ...uint64) ([]uint64, error) {
	fn := g.mod.ExportedFunction(name)
	if fn == nil {
		return nil, fmt.Errorf("missing export %s", name)
	}
	return fn.Call(ctx, args...)
}

// Write copies b into guest memory at ptr.
func (g *Guest) Write(ptr uint32, b []byte) bool {
	if g == nil || g.mod == nil || g.mod.Memory() == nil {
		return false
	}
	return g.mod.Memory().Write(ptr, b)
}

// Read returns the guest memory at ptr. The slice aliases that memory.
func (g *Guest) Read(ptr, n uint32) ([]byte, bool) {
	if g == nil || g.mod == nil || g.mod.Memory() == nil {
		return nil, false
	}
	return g.mod.Memory().Read(ptr, n)
}
