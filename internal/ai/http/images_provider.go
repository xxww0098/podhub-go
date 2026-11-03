package aihttp

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"time"
)

type ImageProviderError struct {
	Class   string
	Unknown bool
}

func (e *ImageProviderError) Error() string { return e.Class }

type bailianImages struct {
	endpoint, model, key string
	client               *http.Client
}

func ImageEndpoint(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.RawQuery != "" || u.Fragment != "" || !strings.HasSuffix(u.Hostname(), ".cn-beijing.maas.aliyuncs.com") {
		return "", errors.New("image endpoint refused")
	}
	u.Path = "/compatible-mode/v1/images/generations"
	u.RawPath = ""
	return u.String(), nil
}

func (b bailianImages) Generate(ctx context.Context, source []byte, prompt string) ([]byte, error) {
	body, _ := json.Marshal(map[string]any{"model": b.model, "image": "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(source), "prompt": prompt, "n": 1, "size": "1024x1024", "prompt_extend": false, "watermark": false})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, &ImageProviderError{Class: "image_request", Unknown: false}
	}
	req.Header.Set("Authorization", "Bearer "+b.key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := b.client.Do(req)
	if err != nil {
		return nil, &ImageProviderError{Class: "image_transport_unknown", Unknown: true}
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		known := resp.StatusCode == 400 || resp.StatusCode == 401 || resp.StatusCode == 403 || resp.StatusCode == 404 || resp.StatusCode == 422
		class := "image_upstream_error"
		if resp.StatusCode == 401 || resp.StatusCode == 403 {
			class = "image_upstream_credentials"
		}
		return nil, &ImageProviderError{Class: class, Unknown: !known}
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20+1))
	if err != nil || len(raw) > 2<<20 {
		return nil, &ImageProviderError{Class: "image_response_invalid", Unknown: true}
	}
	var result struct {
		Model string `json:"model"`
		Data  []struct {
			URL string `json:"url"`
		} `json:"data"`
		Usage struct {
			Count int `json:"image_count"`
		} `json:"usage"`
	}
	if json.Unmarshal(raw, &result) != nil || len(result.Data) != 1 || result.Usage.Count != 1 || (result.Model != "" && result.Model != b.model) {
		return nil, &ImageProviderError{Class: "image_response_invalid", Unknown: true}
	}
	u, err := url.Parse(result.Data[0].URL)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || !strings.HasSuffix(u.Hostname(), ".aliyuncs.com") {
		return nil, &ImageProviderError{Class: "image_output_url_refused", Unknown: true}
	}
	// Deliberately create a fresh request: provider authorization never reaches the image host.
	download, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, &ImageProviderError{Class: "image_output_url_refused", Unknown: true}
	}
	got, err := b.client.Do(download)
	if err != nil {
		return nil, &ImageProviderError{Class: "image_download_unknown", Unknown: true}
	}
	defer got.Body.Close()
	pixels, err := io.ReadAll(io.LimitReader(got.Body, maxImageBytes+1))
	if err != nil || got.StatusCode != 200 || len(pixels) > maxImageBytes {
		return nil, &ImageProviderError{Class: "image_download_invalid", Unknown: true}
	}
	return pixels, nil
}

// This client has a separate, narrow egress policy. Existing loopback clients
// remain unchanged. Each DNS answer is checked and the actual dial is pinned.
var imageClientOnce sync.Once
var sharedImageClient *http.Client

func ImageNetworkClient() *http.Client {
	imageClientOnce.Do(func() { sharedImageClient = NewImageClient("") })
	return sharedImageClient
}
func NewImageClient(publicHost string) *http.Client {
	return &http.Client{Timeout: 90 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, Transport: &http.Transport{Proxy: nil, MaxIdleConns: 32, MaxIdleConnsPerHost: 8, IdleConnTimeout: 30 * time.Second, DisableCompression: true, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 75 * time.Second, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		allowed := host == publicHost
		if publicHost == "" {
			allowed = strings.HasSuffix(host, ".aliyuncs.com") || strings.HasSuffix(host, ".r2.cloudflarestorage.com")
		}
		if err != nil || port != "443" || !allowed {
			return nil, errors.New("image host refused")
		}
		found, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if err != nil || len(found) == 0 {
			return nil, errors.New("image DNS unavailable")
		}
		for _, ip := range found {
			if !imagePublicIP(ip) {
				return nil, errors.New("image DNS refused")
			}
		}
		dial := net.Dialer{Timeout: 10 * time.Second}
		for _, ip := range found {
			conn, e := dial.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if e == nil {
				return conn, nil
			}
			err = e
		}
		return nil, err
	}}}
}
func imagePublicIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, raw := range []string{"100.64.0.0/10", "198.18.0.0/15", "192.0.0.0/24", "192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001:db8::/32"} {
		if netip.MustParsePrefix(raw).Contains(ip) {
			return false
		}
	}
	return true
}

// NewBailianImageGenerator is wired only after encrypted account validation.
func NewBailianImageGenerator(endpoint, model, key string, client *http.Client) ImageGenerator {
	return bailianImages{endpoint: endpoint, model: model, key: key, client: client}
}
