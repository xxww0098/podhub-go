// Package storage's origin client signs nothing. Callers pass a URL that
// sigv4 already signed. This file only performs the loopback HTTP call.
package r2

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/httpx"
)

// Fault is an origin call that did not yield a response body.
type Fault struct {
	Remote bool
	Detail string
}

func (f *Fault) Error() string { return f.Detail }

// Request is one presigned call. Timeout 0 uses the parent context only.
// NoCompress matches origin_client. StrictRead reports a body read error;
// a scan treats that read error as an empty body.
type Request struct {
	Method     string
	URL        string
	Headers    map[string]string
	Body       []byte
	Timeout    time.Duration
	NoCompress bool
	StrictRead bool
	MaxBytes   int64
}

// Response is the origin status line, headers, and body.
type Response struct {
	Status int
	Header map[string][]string
	Body   []byte
}

// Exchange dials a presigned URL. A host that is not loopback is refused
// before the dial. Redirects are not followed.
func Exchange(ctx context.Context, req Request) (Response, error) {
	parsed, err := url.Parse(req.URL)
	if err != nil {
		return Response{}, &Fault{Detail: err.Error()}
	}
	if !originLoopback(parsed.Hostname()) {
		return Response{}, &Fault{Remote: true, Detail: "refusing non-loopback media host"}
	}
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}
	var body io.Reader
	if req.Body != nil {
		body = bytes.NewReader(req.Body)
	} else if req.Method == http.MethodPut || req.Method == http.MethodPost {
		body = bytes.NewReader(nil)
	}
	httpReq, err := http.NewRequestWithContext(ctx, req.Method, req.URL, body)
	if err != nil {
		return Response{}, &Fault{Detail: err.Error()}
	}
	for key, value := range req.Headers {
		httpReq.Header.Set(key, value)
	}
	client := &http.Client{
		CheckRedirect: httpx.UseLast,
		Transport:     httpx.Loopback(req.NoCompress),
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		return Response{}, &Fault{Detail: err.Error()}
	}
	defer resp.Body.Close()
	limit := req.MaxBytes
	if limit <= 0 {
		limit = 32 << 20
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		if req.StrictRead {
			return Response{}, &Fault{Detail: err.Error()}
		}
		return Response{Status: resp.StatusCode, Header: resp.Header}, nil
	}
	if int64(len(raw)) > limit {
		raw = raw[:limit]
		return Response{Status: resp.StatusCode, Header: resp.Header, Body: raw}, &Fault{Detail: "response exceeds limit"}
	}
	return Response{Status: resp.StatusCode, Header: resp.Header, Body: raw}, nil
}

func originLoopback(host string) bool {
	host = strings.Trim(host, "[]")
	switch strings.ToLower(host) {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
