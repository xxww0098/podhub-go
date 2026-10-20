// Package render accepts a browser render receipt.
//
// Pixel rendering stays in the existing Rust WASM (rust/crates/render-wasm,
// rust/crates/psd-x). This process does not decode a PSD and does not add a
// GOOS=js target. What Cloud records is the object key and whether that key
// is still inside the slice generation fence (slice_purge::key_is_current).
package render

import (
	"errors"
	"time"

	"github.com/xxww0098/podhub-go/internal/media/domain/objectkey"
	queue "github.com/xxww0098/podhub-go/internal/platform/jobsched"
)

const (
	// Kind is the jobs.kind the browser executor owns.
	Kind = "media.render"
	// Executor is jobs.executor for that kind.
	Executor = "browser"
)

// ErrStale means the object was issued before the slice generation fence.
var ErrStale = errors.New("图片已进入不可逆回收；请用「一键准备」重新上传图片后再发送（不会重新识图）")

// ErrProbe means the healthcheck PNG is not a rendered product image.
var ErrProbe = errors.New("connectivity probe is not a rendered image")

// Receipt is what the browser submits after it renders and uploads.
type Receipt struct {
	Prefix    string
	Workspace string
	Digest    string
	Ext       string
	// Batch is "{unixMillis}.{uuid}" for compose_batched_key.
	Batch string
	// NotBefore is the slice generation fence. The zero time skips the fence.
	NotBefore time.Time
}

// Result is the server's acceptance. ObjectKey is the only name that travels.
type Result struct {
	Kind      string `json:"kind"`
	Executor  string `json:"executor"`
	ObjectKey string `json:"object_key"`
	Digest    string `json:"digest"`
	Ext       string `json:"ext"`
	BatchMS   int64  `json:"batch_ms"`
	CostUnits int32  `json:"cost_units"`
	Current   bool   `json:"current"`
}

// Accept composes the key and applies the generation fence.
func Accept(in Receipt) (Result, error) {
	if objectkey.IsHealthcheckDigest(in.Digest) {
		return Result{}, ErrProbe
	}
	key, err := objectkey.ComposeBatchedKey(in.Prefix, in.Workspace, in.Digest, in.Ext, in.Batch)
	if err != nil {
		return Result{}, err
	}
	parsed, ok := objectkey.ParseUploadKey(key)
	if !ok {
		return Result{}, objectkey.ErrPrefix
	}
	current := true
	if !in.NotBefore.IsZero() {
		current = KeyCurrent(key, in.NotBefore)
		if !current {
			return Result{}, ErrStale
		}
	}
	return Result{
		Kind:      Kind,
		Executor:  Executor,
		ObjectKey: key,
		Digest:    parsed.Digest,
		Ext:       parsed.Ext,
		BatchMS:   parsed.BatchMS,
		CostUnits: queue.CostUnits(Kind),
		Current:   current,
	}, nil
}

// KeyCurrent matches slice_purge::key_is_current. A key that does not parse is not current.
func KeyCurrent(key string, notBefore time.Time) bool {
	parsed, ok := objectkey.ParseUploadKey(key)
	if !ok {
		return false
	}
	issued := time.UnixMilli(parsed.BatchMS).UTC()
	return !issued.Before(notBefore.UTC())
}
