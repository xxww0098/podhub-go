package slicepurge

import (
	"context"

	storage "github.com/xxww0098/podhub-go/internal/platform/r2"
)

// BucketOrigin lists and deletes one named bucket through the storage client.
// storage.Client already refuses every host except 127.0.0.1.
type BucketOrigin struct {
	Client *storage.Client
	Bucket string
}

// List returns the current keys. An empty bucket is a successful empty page.
func (o BucketOrigin) List(ctx context.Context) ([]string, error) {
	if o.Client == nil || !o.Client.LoopbackDelete() {
		return nil, &CallError{Code: "s3_config_invalid", Retryable: false}
	}
	keys, err := o.Client.ListKeys(ctx, o.Bucket)
	if err != nil {
		return nil, &CallError{Code: "s3_network", Retryable: true}
	}
	return keys, nil
}

// Delete removes the exact keys. A transport error is retryable; the runner
// does not treat it as success.
func (o BucketOrigin) Delete(ctx context.Context, keys []string) (DeleteResult, error) {
	if len(keys) == 0 {
		return DeleteResult{}, nil
	}
	if o.Client == nil || !o.Client.LoopbackDelete() {
		return DeleteResult{}, &CallError{Code: "s3_config_invalid", Retryable: false}
	}
	deleted, failed, err := o.Client.DeleteKeys(ctx, o.Bucket, keys)
	if err != nil {
		return DeleteResult{}, &CallError{Code: "s3_network", Retryable: true}
	}
	codes := make([]string, len(failed))
	for i := range codes {
		codes[i] = "s3_delete_rejected"
	}
	return DeleteResult{
		Deleted:     deleted,
		FailedKeys:  failed,
		FailedCodes: codes,
		Retryable:   len(failed) > 0,
	}, nil
}
