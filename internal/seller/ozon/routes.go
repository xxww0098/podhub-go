package ozon

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/httpx"
)

type officialRoutes struct {
	routes         []string
	dir, switchDir string
	base           *http.Transport
	mu             sync.Mutex
	version        string
	current        *http.Transport
	retryAt        time.Time
}

// Clients share connection pools; every construction still uses captured config.
var routeClients sync.Map

type routeClientKey struct{ routes, dir, switchDir string }

func (e *Egress) initRoutes(cfg config.Config) {
	routes, err := cfg.SellerEgressRoutes()
	if err != nil {
		e.routeError = err
		return
	}
	if len(routes) == 1 && routes[0] == "direct" {
		return
	}
	dir, switchDir := strings.TrimSpace(cfg.SellerRelayDir()), strings.TrimSpace(cfg.SellerRelaySwitchDir())
	key := routeClientKey{routes: strings.Join(routes, "\n"), dir: dir, switchDir: switchDir}
	client := &http.Client{Timeout: 30 * time.Second, CheckRedirect: httpx.UseLast, Transport: &officialRoutes{
		routes: routes, dir: dir, switchDir: switchDir, base: officialHTTPTransport,
	}}
	shared, _ := routeClients.LoadOrStore(key, client)
	e.official = shared.(*http.Client)
}

func (e *Egress) officialClient() *http.Client {
	if e != nil && e.official != nil {
		return e.official
	}
	return officialClient()
}

func (r *officialRoutes) state() (string, bool, error) {
	version := "unmanaged"
	if r.dir != "" {
		raw, err := os.ReadFile(filepath.Join(r.dir, "config.json"))
		if errors.Is(err, os.ErrNotExist) {
			return "disabled", false, nil
		}
		if err != nil || !json.Valid(raw) {
			return "", false, errOfficialRequest
		}
		hash := sha256.Sum256(raw)
		version = hex.EncodeToString(hash[:])
	}
	if r.switchDir != "" {
		marker, err := os.Stat(filepath.Join(r.switchDir, "active"))
		if errors.Is(err, os.ErrNotExist) {
			return version + ":pending", false, nil
		}
		if err != nil || !marker.Mode().IsRegular() {
			return "", false, errOfficialRequest
		}
		version += ":" + marker.ModTime().UTC().Format(time.RFC3339Nano)
	}
	return version, true, nil
}

func (r *officialRoutes) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Scheme != "https" || req.URL.Host != "api-seller.ozon.ru" || req.URL.User != nil || (req.Host != "" && req.Host != "api-seller.ozon.ru") {
		if req.Body != nil {
			_ = req.Body.Close()
		}
		return nil, errOfficialRequest
	}
	version, enabled, err := r.state()
	if err != nil {
		if req.Body != nil {
			_ = req.Body.Close()
		}
		return nil, err
	}
	r.mu.Lock()
	if r.version != version || r.current == nil || !r.retryAt.IsZero() && !time.Now().Before(r.retryAt) {
		previous := r.current
		tr := r.base.Clone()
		tr.Proxy = nil
		tr.DialContext = func(ctx context.Context, network, target string) (net.Conn, error) {
			for i, route := range r.routes {
				if target != "api-seller.ozon.ru:443" {
					return nil, errOfficialRequest
				}
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				var conn net.Conn
				var err error
				if route == "direct" {
					conn, err = r.base.DialContext(ctx, network, target)
				} else if enabled {
					conn, err = httpx.SOCKS5H(ctx, route, network, target)
				} else {
					continue
				}
				if err == nil {
					if enabled && i > 0 {
						r.mu.Lock()
						if r.current == tr && r.retryAt.IsZero() {
							r.retryAt = time.Now().Add(5 * time.Second)
						}
						r.mu.Unlock()
					}
					return conn, nil
				}
			}
			return nil, errOfficialRequest
		}
		r.current, r.retryAt = tr, time.Time{}
		r.version = version
		if previous != nil {
			previous.CloseIdleConnections()
		}
	}
	transport := r.current
	r.mu.Unlock()
	// Routes are tried only by DialContext, before TLS or any HTTP bytes exist.
	return transport.RoundTrip(req)
}

func (r *officialRoutes) CloseIdleConnections() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.current != nil {
		r.current.CloseIdleConnections()
	}
}

// ProbeRelay checks the selected proxy against one fixed official read endpoint.
// It carries no shop credential and has no direct fallback.
func ProbeRelay(ctx context.Context, route, dir, switchDir string) error {
	if !strings.HasPrefix(route, "socks5h://") {
		return errOfficialRequest
	}
	router := &officialRoutes{routes: []string{route}, dir: dir, switchDir: switchDir, base: officialHTTPTransport}
	defer router.CloseIdleConnections()
	if _, enabled, err := router.state(); err != nil || !enabled {
		return errOfficialRequest
	}
	client := &http.Client{Transport: router, Timeout: 5 * time.Second, CheckRedirect: httpx.UseLast}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api-seller.ozon.ru/v1/roles", bytes.NewBufferString(`{}`))
	if err != nil {
		return errOfficialRequest
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return errOfficialRequest
	}
	defer response.Body.Close()
	if response.StatusCode >= 200 && response.StatusCode < 300 || response.StatusCode == 401 || response.StatusCode == 403 || response.StatusCode == 404 {
		return nil
	}
	return errOfficialRequest
}
