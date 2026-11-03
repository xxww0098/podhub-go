package adminhttp

import (
	"context"
	"strings"

	"github.com/xxww0098/podhub-go/internal/admin/service"
	"github.com/xxww0098/podhub-go/internal/platform/r2"
)

// R2Origin performs a presigned call to the configured storage account.
type R2Origin struct{}

func (R2Origin) Do(ctx context.Context, req service.ObjectRequest) (service.ObjectResponse, error) {
	resp, err := r2.ExchangeAccount(ctx, req.Account, r2.Request{
		Method: req.Method, URL: req.URL, Headers: req.Headers, Body: req.Body, Timeout: req.Timeout,
		MaxBytes: req.MaxBytes, NoCompress: true, StrictRead: true,
	})
	if err != nil {
		return service.ObjectResponse{}, err
	}
	headers := map[string]string{}
	for key, values := range resp.Header {
		if len(values) == 0 {
			continue
		}
		headers[strings.ToLower(key)] = values[0]
	}
	return service.ObjectResponse{Status: resp.Status, Headers: headers, Body: resp.Body}, nil
}
