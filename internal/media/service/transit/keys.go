// Package transit composes and reads the transit bucket's batch keys.
//
// The server composes keys and the send and cleanup paths validate them.
package transit

import (
	"github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/media/domain/objectkey"
)

// UploadKey composes {prefix}uploads/{UTC-date}/{batch}/{digest}.{extension}.
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
