package api

import (
	"context"
	"time"

	storage "github.com/xxww0098/podhub-go/internal/platform/r2"
)

// originCaller dials presigned URLs. Non-loopback hosts are refused inside Exchange.
type originCaller struct{}

func (originCaller) Exchange(ctx context.Context, method, rawURL string, headers map[string]string, body []byte, timeout time.Duration, noCompress, strict bool, max int64) (int, map[string][]string, []byte, error) {
	resp, err := storage.Exchange(ctx, storage.Request{
		Method: method, URL: rawURL, Headers: headers, Body: body,
		Timeout: timeout, NoCompress: noCompress, StrictRead: strict, MaxBytes: max,
	})
	if err != nil {
		return 0, nil, nil, err
	}
	return resp.Status, resp.Header, resp.Body, nil
}
