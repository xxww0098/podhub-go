package ozon

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/xxww0098/podhub-go/internal/platform/httpx"
	sellercontract "github.com/xxww0098/podhub-go/internal/seller/contract"
	"github.com/xxww0098/podhub-go/internal/seller/ozon/domain"
)

// StoreScope identifies the persisted tenant, store and credential generation.
type StoreScope struct {
	OrgID, StorePK, CredentialRevision int64
	StoreUUID                          string
}

var errOfficialRequest = errors.New("official Seller request failed")

type officialPort struct {
	scope            StoreScope
	clientID, apiKey string
	client           *http.Client
	writesDisabled   bool
	e                *Egress
}

var officialHTTPTransport = &http.Transport{
	Proxy: nil, DialContext: dialOfficial, ForceAttemptHTTP2: true,
	MaxIdleConns: 16, MaxIdleConnsPerHost: 16, IdleConnTimeout: 90 * time.Second,
	TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 20 * time.Second,
}
var officialHTTPClient = &http.Client{Timeout: 30 * time.Second, CheckRedirect: httpx.UseLast, Transport: officialHTTPTransport}

var diagnosticEgress = &Egress{readSlots: filled(domain.ReadSlots), writeSlots: filled(domain.WriteSlots)}

// NewOfficialReader is for explicitly authorized, tenant-scoped diagnostics.
// It never reads configuration or persists credentials, and cannot send writes.
// Production workers obtain their binding from the stored-credential resolver.
func NewOfficialReader(scope StoreScope, clientID, apiKey string) (sellercontract.Transport, error) {
	return newOfficialPort(scope, clientID, apiKey, true)
}

func newOfficialPort(scope StoreScope, clientID, apiKey string, writesDisabled bool) (*officialPort, error) {
	if scope.OrgID <= 0 || scope.StorePK <= 0 || scope.CredentialRevision <= 0 {
		return nil, sellercontract.ErrNotSent
	}
	if id, err := uuid.Parse(scope.StoreUUID); err != nil || id == uuid.Nil {
		return nil, sellercontract.ErrNotSent
	}
	if !safeCredential(clientID) || !safeCredential(apiKey) {
		return nil, sellercontract.ErrNotSent
	}
	return &officialPort{scope: scope, clientID: clientID, apiKey: apiKey,
		writesDisabled: writesDisabled, client: officialClient(), e: diagnosticEgress}, nil
}

func safeCredential(value string) bool {
	return strings.TrimSpace(value) != "" && len(value) <= 4096 && !strings.ContainsAny(value, "\r\n")
}

func officialClient() *http.Client {
	return officialHTTPClient
}

func dialOfficial(ctx context.Context, network, address string) (net.Conn, error) {
	if address != "api-seller.ozon.ru:443" {
		return nil, sellercontract.ErrNotSent
	}
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, "api-seller.ozon.ru")
	if err != nil {
		return nil, errOfficialRequest
	}
	for _, address := range addresses {
		ip := address.IP
		if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ipBenchmarks(ip) {
			continue
		}
		conn, err := (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ip.String(), "443"))
		if err == nil {
			return conn, nil
		}
	}
	return nil, errOfficialRequest
}

func ipBenchmarks(ip net.IP) bool {
	v4 := ip.To4()
	return v4 != nil && v4[0] == 198 && (v4[1] == 18 || v4[1] == 19)
}

func (p *officialPort) WritesDisabled() bool       { return p == nil || p.writesDisabled }
func (p *officialPort) PhysicalAccountKey() string { return domain.PhysicalAccountKey(p.clientID) }

func (p *officialPort) Ready(context.Context) error {
	if p == nil || p.writesDisabled || p.client == nil || p.e == nil || p.e.routeError != nil {
		return sellercontract.ErrNotSent
	}
	return nil
}

func (p *officialPort) Write(ctx context.Context, path string, body []byte) (int, string, error) {
	if p.WritesDisabled() || path != "/v3/product/import" {
		return 0, "", sellercontract.ErrNotSent
	}
	return p.call(ctx, path, body)
}

func (p *officialPort) Read(ctx context.Context, path string, body []byte) (int, string, error) {
	if p == nil || (path != "/v3/product/info/list" && path != "/v1/product/import/info" && path != "/v2/product/pictures/info") {
		return 0, "", sellercontract.ErrNotSent
	}
	return p.call(ctx, path, body)
}

func (p *officialPort) call(ctx context.Context, path string, body []byte) (int, string, error) {
	return p.exchange(ctx, path, body, path == "/v3/product/import", path == "/v1/roles")
}

func (p *officialPort) exchange(ctx context.Context, path string, body []byte, write, interactive bool) (int, string, error) {
	return p.exchangeMethod(ctx, http.MethodPost, path, body, write, interactive)
}

func (p *officialPort) exchangeMethod(ctx context.Context, method, path string, body []byte, write, interactive bool) (int, string, error) {
	if p.e == nil || p.e.routeError != nil {
		return 0, "", errOfficialRequest
	}
	if method != http.MethodPost && method != http.MethodGet || method == http.MethodPost && len(body) == 0 || method == http.MethodGet && len(body) != 0 || len(body) > 8<<20 {
		return 0, "", sellercontract.ErrNotSent
	}
	release, err := p.e.admit(ctx, path, write, interactive)
	if err != nil {
		return 0, "", sellercontract.ErrNotSent
	}
	defer release()
	req, err := http.NewRequestWithContext(ctx, method, domain.ProductionBaseURL+path, bytes.NewReader(body))
	if err != nil {
		return 0, "", sellercontract.ErrNotSent
	}
	if len(body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Client-Id", p.clientID)
	req.Header.Set("Api-Key", p.apiKey)
	resp, err := p.client.Do(req)
	p.e.mu.Lock()
	p.e.lastPath = path
	if write {
		p.e.writes++
	} else {
		p.e.reads++
	}
	p.e.mu.Unlock()
	if err != nil {
		if ctx.Err() != nil {
			return 0, "", ctx.Err()
		}
		return 0, "", errOfficialRequest
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 {
		return resp.StatusCode, "", errOfficialRequest
	}
	return resp.StatusCode, string(raw), nil
}
