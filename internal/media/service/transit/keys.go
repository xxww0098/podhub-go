// Package transit composes and reads the transit bucket's batch keys.
//
// The key shape is a three-way protocol: the browser wasm composes it, the
// SQL media recognition reads it, and the send path re-validates it. This
// package is the Go side of that same string, so it calls objectkey rather
// than re-implementing the rule.
package transit

import (
	"github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/media/domain/objectkey"
)

// UploadKey composes {prefix}uploads/{UTC-date}/{batch}/images/teams/...
// Batch is "{unixMillis}.{uuid}". Only jpg and png are rendered.
func UploadKey(prefix, workspace, digest, extension, batch string) (string, error) {
	ext, err := contract.NormalizeExtension(extension)
	if err != nil {
		return "", err
	}
	if ext != contract.ExtJPG && ext != contract.ExtPNG {
		return "", contract.ErrExtension
	}
	return objectkey.ComposeBatchedKey(prefix, workspace, digest, string(ext), batch)
}

// IsKey reports whether the string is a batch key this service could issue.
func IsKey(key string) bool {
	_, ok := objectkey.ParseUploadKey(key)
	return ok
}

// BatchIdentity is the "{batch-ms}-{batch-uuid}" generation directory, or "".
func BatchIdentity(key string) string { return objectkey.BatchIdentity(key) }
