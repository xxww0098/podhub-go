package r2

import (
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"net/url"
	"slices"
	"sync/atomic"
	"testing"
)

// exchangeIsolated is the pre-pool Exchange: a new Transport on every call.
// It is the oracle for status, headers, and body bytes.
func exchangeIsolated(ctx context.Context, req Request) (Response, error) {
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
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport: &http.Transport{
			DisableCompression: req.NoCompress,
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				host, _, splitErr := net.SplitHostPort(addr)
				if splitErr != nil {
					return nil, splitErr
				}
				if !originLoopback(host) {
					return nil, &Fault{Remote: true, Detail: "refusing non-loopback media host"}
				}
				return (&net.Dialer{}).DialContext(ctx, network, addr)
			},
		},
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

func TestExchangeMatchesIsolatedTransport(t *testing.T) {
	payload := []byte("hello-origin-body")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/gz":
			if !bytes.Contains([]byte(r.Header.Get("Accept-Encoding")), []byte("gzip")) {
				w.Header().Set("X-Mark", r.Header.Get("X-Trace"))
				w.Write(payload)
				return
			}
			var buf bytes.Buffer
			zw := gzip.NewWriter(&buf)
			_, _ = zw.Write(payload)
			_ = zw.Close()
			w.Header().Set("Content-Encoding", "gzip")
			w.Write(buf.Bytes())
		case "/big":
			w.Header().Set("X-Mark", "big")
			w.Write(bytes.Repeat([]byte("abc"), 50))
		case "/redir":
			http.Redirect(w, r, "/echo", http.StatusFound)
		default:
			buf, _ := io.ReadAll(r.Body)
			w.Header().Set("X-Mark", r.Header.Get("X-Trace"))
			w.Header().Set("X-AE", r.Header.Get("Accept-Encoding"))
			w.Header().Set("X-Body", string(buf))
			w.WriteHeader(http.StatusCreated)
			w.Write(payload)
		}
	}))
	defer srv.Close()

	cases := []Request{
		{Method: http.MethodGet, URL: srv.URL + "/echo", Headers: map[string]string{"X-Trace": "one"}, NoCompress: true},
		{Method: http.MethodGet, URL: srv.URL + "/echo", Headers: map[string]string{"X-Trace": "two"}, NoCompress: false},
		{Method: http.MethodPut, URL: srv.URL + "/echo", Headers: map[string]string{"X-Trace": "put"}, Body: []byte("abc"), NoCompress: true, StrictRead: true},
		{Method: http.MethodGet, URL: srv.URL + "/gz", NoCompress: true},
		{Method: http.MethodGet, URL: srv.URL + "/gz", NoCompress: false},
		{Method: http.MethodGet, URL: srv.URL + "/big", MaxBytes: 40, NoCompress: true},
		{Method: http.MethodGet, URL: srv.URL + "/big", MaxBytes: 150, NoCompress: true},
		{Method: http.MethodGet, URL: srv.URL + "/redir", NoCompress: true},
	}
	for i, req := range cases {
		got, gotErr := Exchange(context.Background(), req)
		want, wantErr := exchangeIsolated(context.Background(), req)
		if !sameFault(gotErr, wantErr) {
			t.Fatalf("case %d fault\n got %v\nwant %v", i, gotErr, wantErr)
		}
		if got.Status != want.Status || !bytes.Equal(got.Body, want.Body) || !sameHeader(got.Header, want.Header) {
			t.Fatalf("case %d\n got %d %q %v\nwant %d %q %v", i, got.Status, got.Body, got.Header, want.Status, want.Body, want.Header)
		}
		if i == 5 {
			if gotErr == nil || gotErr.Error() != "response exceeds limit" || int64(len(got.Body)) != req.MaxBytes {
				t.Fatalf("truncation %d %v %q", len(got.Body), gotErr, got.Body)
			}
		}
	}
}

func TestExchangeReusesLoopbackConn(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Mark", "ok")
		w.Write([]byte("ok"))
	}))
	defer srv.Close()
	shared, fresh := countReuse(srv.URL, 200)
	if fresh != 0 {
		t.Fatalf("isolated transport reused %d/200", fresh)
	}
	if shared < 190 {
		t.Fatalf("shared transport reused %d/200", shared)
	}
}

func BenchmarkExchangeGET(b *testing.B) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	}))
	defer srv.Close()
	var shared, fresh int
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		s, f := countReuse(srv.URL, 200)
		shared += s
		fresh += f
	}
	b.StopTimer()
	b.ReportMetric(float64(shared)/float64(b.N), "shared-reused/200")
	b.ReportMetric(float64(fresh)/float64(b.N), "fresh-reused/200")
}

func countReuse(rawURL string, n int) (shared, fresh int) {
	req := Request{Method: http.MethodGet, URL: rawURL, NoCompress: true}
	var reused atomic.Int32
	for i := 0; i < n; i++ {
		reused.Store(0)
		ctx := httptrace.WithClientTrace(context.Background(), &httptrace.ClientTrace{
			GotConn: func(info httptrace.GotConnInfo) {
				if info.Reused {
					reused.Store(1)
				}
			},
		})
		if _, err := Exchange(ctx, req); err != nil {
			return -1, -1
		}
		shared += int(reused.Load())
		reused.Store(0)
		ctx = httptrace.WithClientTrace(context.Background(), &httptrace.ClientTrace{
			GotConn: func(info httptrace.GotConnInfo) {
				if info.Reused {
					reused.Store(1)
				}
			},
		})
		if _, err := exchangeIsolated(ctx, req); err != nil {
			return -1, -1
		}
		fresh += int(reused.Load())
	}
	return shared, fresh
}

func sameFault(a, b error) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	var fa, fb *Fault
	if !asFault(a, &fa) || !asFault(b, &fb) {
		return false
	}
	return fa.Detail == fb.Detail && fa.Remote == fb.Remote
}

func asFault(err error, dst **Fault) bool {
	f, ok := err.(*Fault)
	if !ok {
		return false
	}
	*dst = f
	return true
}

func sameHeader(a, b http.Header) bool {
	aa, bb := a.Clone(), b.Clone()
	aa.Del("Date")
	bb.Del("Date")
	if len(aa) != len(bb) {
		return false
	}
	for k, vs := range aa {
		if !slices.Equal(vs, bb[k]) {
			return false
		}
	}
	return true
}
