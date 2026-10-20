package seller

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	ozon "github.com/xxww0098/podhub-go/internal/platform/egressgate"
	"github.com/xxww0098/podhub-go/internal/platform/httpx"
	"github.com/xxww0098/podhub-go/internal/seller/domain"
	sellerrepo "github.com/xxww0098/podhub-go/internal/seller/repo"
)

// ErrRefusedOrigin means the base URL is not an accepted loopback origin.
// No dial is made. Rust would open api-seller.ozon.ru; this process must not.
var ErrRefusedOrigin = errors.New("seller base url is not loopback; no request was sent")

// ErrSaturated means every L2 slot for the lane was taken for SlotWait.
var ErrSaturated = errors.New("seller egress dispatch slots saturated")

// Reply is a loopback response. Status 0 means the round trip produced none.
type Reply struct {
	Status int
	Body   string
	Header http.Header
}

// Egress is one process's Seller pool. writesDisabled is the config value
// captured by the caller. base is captured at New.
type Egress struct {
	base           string
	writesDisabled bool
	namespace      string
	pool           *pgxpool.Pool
	client         *http.Client

	readSlots  chan struct{}
	writeSlots chan struct{}
	iread      chan struct{}
	iwrite     chan struct{}

	mu       sync.Mutex
	writes   int
	reads    int
	lastPath string
}

// New captures the kill switch and the base URL. It does not dial.
// The client does not follow redirects or an environment proxy, and its
// dialer accepts only loopback addresses. Timeout is the overall limit
// for one round trip. The transport is the process-wide Ozon client.
func New(cfg config.Config) *Egress {
	client := httpx.OzonClient()
	client.Timeout = 30 * time.Second
	return &Egress{
		base:           domain.ResolveBaseURL(cfg.SellerBaseURL()),
		writesDisabled: cfg.OzonWritesDisabled(),
		namespace:      domain.Namespace(),
		client:         client,
		readSlots:      filled(domain.ReadSlots),
		writeSlots:     filled(domain.WriteSlots),
		iread:          filled(domain.InteractiveReadSlots),
		iwrite:         filled(domain.InteractiveWriteSlots),
	}
}

// Base is the origin captured at New. A non-loopback setting is the
// official host and is not dialed.
func (e *Egress) Base() string {
	if e == nil {
		return ""
	}
	return e.base
}

// SetTimeout replaces the round-trip limit. Tests use a short value so a
// hung mock is a timeout rather than a 30s wait.
func (e *Egress) SetTimeout(d time.Duration) {
	if e != nil && e.client != nil {
		e.client.Timeout = d
	}
}

// WithPool attaches the database that serves lease_budget. Nil skips L1.
// Tests that only check the kill switch leave it nil.
func (e *Egress) WithPool(pool *pgxpool.Pool) *Egress {
	if e == nil {
		return e
	}
	e.pool = pool
	return e
}

func filled(n int) chan struct{} {
	ch := make(chan struct{}, n)
	for i := 0; i < n; i++ {
		ch <- struct{}{}
	}
	return ch
}

// Loopback reports whether this egress will dial.
func (e *Egress) Loopback() bool {
	return e != nil && domain.LoopbackOrigin(e.base+"/")
}

// WritePosts is how many write requests left this process.
func (e *Egress) WritePosts() int {
	if e == nil {
		return 0
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.writes
}

// ReadPosts is how many read requests left this process.
func (e *Egress) ReadPosts() int {
	if e == nil {
		return 0
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.reads
}

// Write sends a Seller write. The kill switch is checked before L1, L2, and
// the dial. The error is ozon.ErrWritesDisabled, the same sentinel the rest
// of the process already returns.
func (e *Egress) Write(ctx context.Context, path string, body []byte) (Reply, error) {
	if e == nil || e.writesDisabled {
		return Reply{}, ozon.ErrWritesDisabled
	}
	return e.round(ctx, true, false, path, body)
}

// Read sends a reconciliation probe. The kill switch does not apply.
func (e *Egress) Read(ctx context.Context, path string, body []byte) (Reply, error) {
	if e == nil {
		return Reply{}, ErrRefusedOrigin
	}
	return e.round(ctx, false, false, path, body)
}

func (e *Egress) round(ctx context.Context, write, interactive bool, path string, body []byte) (Reply, error) {
	return e.exchange(ctx, write, interactive, http.MethodPost, path, body, "", "")
}

// Call is one Seller round trip with the shop credential. Writes are refused
// before a slot is taken when the captured kill switch is closed. The base
// URL must already be loopback; this method does not dial the public host.
func (e *Egress) Call(ctx context.Context, method, path string, body []byte, write, interactive bool, clientID, apiKey string) (Reply, error) {
	if write && (e == nil || e.writesDisabled) {
		return Reply{}, ozon.ErrWritesDisabled
	}
	if e == nil {
		return Reply{}, ErrRefusedOrigin
	}
	if method == "" {
		method = http.MethodPost
	}
	return e.exchange(ctx, write, interactive, method, path, body, clientID, apiKey)
}

// Forward is the upstream proxy read. It does not consult the kill switch.
func (e *Egress) Forward(ctx context.Context, method, path, rawQuery, contentType string, body []byte, clientID, apiKey string) (Reply, error) {
	return e.ForwardUpstream(ctx, method, path, rawQuery, contentType, body, clientID, apiKey)
}

// ForwardUpstream sends one proxy read. The kill switch is not consulted.
// The response body is not truncated. Only the caller's Content-Type is set.
func (e *Egress) ForwardUpstream(ctx context.Context, method, path, rawQuery, contentType string, body []byte, clientID, apiKey string) (Reply, error) {
	if e == nil || !e.Loopback() {
		return Reply{}, ErrRefusedOrigin
	}
	if method == "" {
		method = http.MethodPost
	}
	class := domain.RateClassForPath(path)
	if e.pool != nil {
		interval, burst := e.schedule(class)
		wait, err := sellerrepo.Reserve(ctx, e.pool, e.namespace, "client:"+string(class), interval, burst, domain.MaxRateLimitWait)
		if err != nil {
			return Reply{}, err
		}
		if wait > 0 {
			timer := time.NewTimer(wait)
			select {
			case <-ctx.Done():
				timer.Stop()
				return Reply{}, ctx.Err()
			case <-timer.C:
			}
		}
	}
	release, err := e.take(ctx, false, true)
	if err != nil {
		return Reply{}, err
	}
	defer release()
	var rdr io.Reader
	if method != http.MethodGet && len(body) > 0 {
		rdr = bytes.NewReader(body)
	}
	url := e.base + path
	if rawQuery != "" {
		url += "?" + rawQuery
	}
	req, err := http.NewRequestWithContext(ctx, method, url, rdr)
	if err != nil {
		return Reply{}, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if clientID != "" {
		req.Header.Set("Client-Id", clientID)
	}
	if apiKey != "" {
		req.Header.Set("Api-Key", apiKey)
	}
	resp, err := e.client.Do(req)
	e.mu.Lock()
	e.lastPath = path
	e.reads++
	e.mu.Unlock()
	if err != nil {
		return Reply{}, err
	}
	raw, err := httpx.ReadLimit(resp.Body, 0)
	if err != nil {
		return Reply{Status: resp.StatusCode, Header: resp.Header}, err
	}
	return Reply{Status: resp.StatusCode, Body: string(raw), Header: resp.Header}, nil
}

func (e *Egress) exchange(ctx context.Context, write, interactive bool, method, path string, body []byte, clientID, apiKey string) (Reply, error) {
	if !e.Loopback() {
		return Reply{}, ErrRefusedOrigin
	}
	class := domain.RateClassForPath(path)
	if e.pool != nil {
		interval, burst := e.schedule(class)
		wait, err := sellerrepo.Reserve(ctx, e.pool, e.namespace, "client:"+string(class), interval, burst, domain.MaxRateLimitWait)
		if err != nil {
			return Reply{}, err
		}
		if wait > 0 {
			timer := time.NewTimer(wait)
			select {
			case <-ctx.Done():
				timer.Stop()
				return Reply{}, ctx.Err()
			case <-timer.C:
			}
		}
	}
	release, err := e.take(ctx, write, interactive)
	if err != nil {
		return Reply{}, err
	}
	defer release()
	var rdr io.Reader
	if method != http.MethodGet && body != nil {
		rdr = strings.NewReader(string(body))
	}
	req, err := http.NewRequestWithContext(ctx, method, e.base+path, rdr)
	if err != nil {
		return Reply{}, err
	}
	if rdr != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if clientID != "" {
		req.Header.Set("Client-Id", clientID)
	}
	if apiKey != "" {
		req.Header.Set("Api-Key", apiKey)
	}
	resp, err := e.client.Do(req)
	e.mu.Lock()
	e.lastPath = path
	if write {
		e.writes++
	} else {
		e.reads++
	}
	e.mu.Unlock()
	if err != nil {
		return Reply{}, err
	}
	raw, err := httpx.ReadLimit(resp.Body, 1<<20)
	if err != nil {
		return Reply{Status: resp.StatusCode, Header: resp.Header}, err
	}
	return Reply{Status: resp.StatusCode, Body: string(raw), Header: resp.Header}, nil
}

func (e *Egress) schedule(class domain.RateClass) (interval, burst time.Duration) {
	switch class {
	case domain.ClassAnalytics:
		return time.Second / domain.DefaultAnalyticsRate, time.Second / domain.DefaultAnalyticsRate * time.Duration(domain.DefaultAnalyticsBurst-1)
	case domain.ClassCatalog:
		return domain.DefaultCatalogInterval, domain.DefaultCatalogInterval * time.Duration(domain.DefaultCatalogBurst-1)
	default:
		return time.Second / domain.DefaultRatePerSecond, (time.Second / domain.DefaultRatePerSecond) * time.Duration(domain.DefaultBurst-1)
	}
}

func (e *Egress) take(ctx context.Context, write, interactive bool) (func(), error) {
	var reserved, shared chan struct{}
	if write {
		shared = e.writeSlots
		if interactive {
			reserved = e.iwrite
		}
	} else {
		shared = e.readSlots
		if interactive {
			reserved = e.iread
		}
	}
	if reserved != nil {
		select {
		case token := <-reserved:
			return func() { reserved <- token }, nil
		default:
		}
	}
	timer := time.NewTimer(domain.SlotWait)
	defer timer.Stop()
	select {
	case token := <-shared:
		return func() { shared <- token }, nil
	case <-timer.C:
		return nil, ErrSaturated
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
