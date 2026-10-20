package adminhttp

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/xxww0098/podhub-go/internal/admin/service"
	"github.com/xxww0098/podhub-go/internal/platform/httpx"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

// LoopbackBlob dials only loopback object storage.
type LoopbackBlob struct {
	Client *http.Client
}

func (b LoopbackBlob) Get(ctx context.Context, account service.MediaAccount, key string) ([]byte, string, int, error) {
	body, ctype, status, err := b.round(ctx, http.MethodGet, account, key, nil, "")
	return body, ctype, status, err
}

func (b LoopbackBlob) Put(ctx context.Context, account service.MediaAccount, key string, body []byte, contentType string) (int, error) {
	_, _, status, err := b.round(ctx, http.MethodPut, account, key, body, contentType)
	return status, err
}

func (b LoopbackBlob) round(ctx context.Context, method string, account service.MediaAccount, key string, body []byte, contentType string) ([]byte, string, int, error) {
	if !loopbackEndpoint(account.Endpoint) {
		return nil, "", 0, errNotLoopback
	}
	acc := sign.Account{
		Provider: sign.ProviderGeneric, Endpoint: account.Endpoint, Region: account.Region,
		Bucket: account.Bucket, ForcePathStyle: true, AccessKeyID: account.AccessKeyID,
		SecretAccessKey: account.SecretAccessKey,
	}
	raw, _, err := sign.PresignURL(acc, method, key, contentType, time.Now(), 5*time.Minute, nil, nil)
	if err != nil {
		return nil, "", 0, err
	}
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, raw, rdr)
	if err != nil {
		return nil, "", 0, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	client := b.Client
	if client == nil {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		client = &http.Client{Transport: httpx.Loopback(false)}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", 0, err
	}
	defer resp.Body.Close()
	buf, err := io.ReadAll(io.LimitReader(resp.Body, 512*1024+1))
	if err != nil {
		return nil, "", resp.StatusCode, err
	}
	return buf, resp.Header.Get("Content-Type"), resp.StatusCode, nil
}

type loopbackError struct{}

func (loopbackError) Error() string { return "object endpoint is not loopback" }

var errNotLoopback = loopbackError{}

func loopbackEndpoint(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	host := u.Hostname()
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
