package api

import (
	"context"
	"time"

	storage "github.com/xxww0098/podhub-go/internal/platform/r2"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

// originCaller restricts presigned requests to their configured storage account.
type originCaller struct{}

func (originCaller) Exchange(ctx context.Context, account sign.Account, method, rawURL string, headers map[string]string, body []byte, timeout time.Duration, noCompress, strict bool, max int64) (int, map[string][]string, []byte, error) {
	resp, err := storage.ExchangeAccount(ctx, account, storage.Request{
		Method: method, URL: rawURL, Headers: headers, Body: body,
		Timeout: timeout, NoCompress: noCompress, StrictRead: strict, MaxBytes: max,
	})
	if err != nil {
		return 0, nil, nil, err
	}
	return resp.Status, resp.Header, resp.Body, nil
}
