package integration

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	storerepo "github.com/xxww0098/podhub-go/internal/store/repo"
	storesvc "github.com/xxww0098/podhub-go/internal/store/service"
)

func TestRelayProductionRoleHTTPUsesConfiguredProxy(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	var connects atomic.Int32
	go func() {
		for {
			c, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				_ = c.SetDeadline(time.Now().Add(time.Second))
				var hello [3]byte
				if _, err := io.ReadFull(c, hello[:]); err != nil {
					return
				}
				_, _ = c.Write([]byte{5, 0})
				var head [5]byte
				if _, err := io.ReadFull(c, head[:]); err != nil || head[3] != 3 {
					return
				}
				name := make([]byte, int(head[4])+2)
				if _, err := io.ReadFull(c, name); err != nil {
					return
				}
				if string(name[:len(name)-2]) != "api-seller.ozon.ru" || binary.BigEndian.Uint16(name[len(name)-2:]) != 443 {
					t.Error("normal-role HTTP request escaped fixed Seller target")
					return
				}
				connects.Add(1)
				_, _ = c.Write([]byte{5, 5, 0, 1, 0, 0, 0, 0, 0, 0})
			}()
		}
	}()
	const rawKey = "qa-relay-ordinary-role-key-material"
	route := "socks5h://" + listener.Addr().String()
	t.Setenv("CLOUD_SELLER_EGRESS_ROUTES", route)
	t.Setenv("CLOUD_SELLER_RELAY_DIR", t.TempDir())
	t.Setenv("CLOUD_SELLER_RELAY_SWITCH_DIR", "")
	t.Setenv("CLOUD_SELLER_BASE_URL", "")
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY", rawKey)
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	f := newAdminContentFixture(t)
	const storeID = "11111111-2222-4333-8444-555555555555"
	insertNamedStore(t, f.ctx, f.fixture, f.org, storeID, 0)
	seedMatchingLease(t, f.ctx, f.fixture, "entitlement", "relay normal role credential fixture")
	directory := storerepo.New(f.runtime, tenantx.BeginApp).WithCredentialKey(seal.Ring{Primary: seal.DeriveKEK(rawKey)}, true, seal.DefaultSellerKeyID,
		storeCredentialProbe(func(context.Context, string, string) (int, []byte, error) { return 200, []byte(`{}`), nil }))
	svc := storesvc.New(directory, nil).WithRoster(directory).WithCredentialDirectory(directory)
	if _, api := svc.RegisterCredential(f.ctx, f.org, 96311, storeID, "fixture-client", "fixture-key", 1, nil, true); api != nil {
		t.Fatal(api)
	}
	f.want(t, http.MethodGet, "/api/admin/seller-relay", "", f.user, 403)
	view := f.want(t, http.MethodGet, "/api/admin/seller-relay", "", f.admin, 200)
	if !strings.Contains(string(view), route) {
		t.Fatal("management page did not receive captured route")
	}
	link := "vless://550e8400-e29b-41d4-a716-446655440000@fixture.invalid:443?security=reality&sni=cover.invalid&pbk=" + strings.Repeat("A", 43)
	body, _ := json.Marshal(map[string]string{"links": link})
	imported := f.want(t, http.MethodPost, "/api/admin/seller-relay/nodes", string(body), f.admin, 200)
	var nodes struct {
		Data struct{ Nodes []struct{ ID string } } `json:"data"`
	}
	if json.Unmarshal(imported, &nodes) != nil || len(nodes.Data.Nodes) != 1 {
		t.Fatal("normal-role node import failed")
	}
	body, _ = json.Marshal(map[string]any{"nodeId": nodes.Data.Nodes[0].ID})
	f.want(t, http.MethodPut, "/api/admin/seller-relay/active", string(body), f.admin, 200)
	probe := f.want(t, http.MethodPost, "/api/admin/seller-relay/probe", `{}`, f.admin, 200)
	if !strings.Contains(string(probe), `"reachable":false`) || connects.Load() != 1 {
		t.Fatal("probe did not attempt the configured proxy")
	}
	shipping := `{"store_id":"` + storeID + `","window_days":1,"limit":1}`
	f.want(t, http.MethodPost, "/api/ops/shipping/list", shipping, f.admin, 502)
	if connects.Load() != 2 {
		t.Fatal("Seller business HTTP still bypassed the configured proxy")
	}
	f.want(t, http.MethodPost, "/api/ops/shipping/list", shipping, f.user, 404)
	f.want(t, http.MethodPut, "/api/admin/seller-relay/active", `{"nodeId":null}`, f.admin, 200)
	f.want(t, http.MethodPost, "/api/ops/shipping/list", shipping, f.admin, 502)
	if connects.Load() != 2 {
		t.Fatal("disabled or cross-tenant request reached the proxy")
	}
	f.assertClean(t)
}
