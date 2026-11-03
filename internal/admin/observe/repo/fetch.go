package observerepo

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/xxww0098/podhub-go/internal/platform/httpx"
)

// Fetch loads a bounded thumbnail response, validating every destination if it
// follows redirects. Thumbnail checks the returned bytes before serving them.
type Fetch func(ctx context.Context, rawURL string) (status int, body []byte, err error)

// LoopbackFetch is the fail-closed fallback when no production fetcher is wired.
// It accepts only a loopback origin and does not follow redirects.
func LoopbackFetch(ctx context.Context, rawURL string) (int, []byte, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || !loopbackHost(parsed.Hostname()) {
		return 0, nil, errors.New("thumbnail host is not loopback")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("User-Agent", "podhub-thumbnail")
	client := &http.Client{CheckRedirect: httpx.UseLast}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024+1))
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, body, nil
}

func loopbackHost(host string) bool {
	host = strings.TrimSpace(host)
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
