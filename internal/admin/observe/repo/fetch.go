package observerepo

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// Fetch loads one thumbnail URL without following redirects.
type Fetch func(ctx context.Context, rawURL string) (status int, body []byte, err error)

// LoopbackFetch refuses every host that is not loopback. Production wiring uses
// this so a thumbnail never dials the public Ozon CDN.
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
	resp, err := http.DefaultClient.Do(req)
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
