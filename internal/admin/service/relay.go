package service

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

// Relay is the seller-relay file store. It does not start sing-box.
type Relay struct {
	port RelayPort
	opt  RelayOptions
	mu   sync.Mutex
}

// NewRelay keeps the directory and the optional audit port.
func NewRelay(p RelayPort, opt RelayOptions) *Relay {
	return &Relay{port: p, opt: opt}
}

const (
	msgNoSidecar = "本环境没有中转容器（本地开发），节点无处保存"
	msgRelayIO   = "中转节点文件读写失败；检查 runtime/seller-relay 目录"
)

func (s *Relay) dir() string {
	if s == nil {
		return ""
	}
	return strings.TrimSpace(s.opt.Dir)
}

// Get returns the public view. A missing directory is an empty list, not an error.
func (s *Relay) Get() (domain.RelayResponse, error) {
	nodes, err := s.load()
	if err != nil {
		return domain.RelayResponse{}, err
	}
	return domain.RelayResponse{Data: domain.RelayView(nodes, s.dir() != "", s.opt.Route)}, nil
}

// Import parses every line, then saves. One bad line saves nothing.
func (s *Relay) Import(ctx context.Context, actor domain.Actor, raw []byte) (domain.RelayResponse, error) {
	links, aerr := domain.DecodeImport(raw)
	if aerr != nil {
		return domain.RelayResponse{}, aerr
	}
	parsed, perr := domain.ParseLinks(links)
	if perr != nil {
		return domain.RelayResponse{}, domain.Fail(400, "VALIDATION", perr.Error())
	}
	var added int
	nodes, err := s.mutate(func(cur domain.Nodes) (domain.Nodes, error) {
		next, n, err := domain.AddNodes(cur, parsed, shortID)
		added = n
		return next, err
	})
	if err != nil {
		return domain.RelayResponse{}, asValidation(err)
	}
	s.audit(ctx, actor, "POST", "/api/admin/seller-relay/nodes", "platform_seller_relay_nodes_imported", summary("导入 "+itoa(int64(added))+" 个 Seller 出口中转节点"))
	return domain.RelayResponse{Data: domain.RelayView(nodes, true, s.opt.Route)}, nil
}

// Switch selects a node or turns the relay off.
func (s *Relay) Switch(ctx context.Context, actor domain.Actor, raw []byte) (domain.RelayResponse, error) {
	id, aerr := domain.DecodeSwitch(raw)
	if aerr != nil {
		return domain.RelayResponse{}, aerr
	}
	var address string
	nodes, err := s.mutate(func(cur domain.Nodes) (domain.Nodes, error) {
		next, err := domain.Activate(cur, id)
		if err != nil {
			return cur, err
		}
		if id != nil {
			if node, ok := domain.ActiveNode(next); ok {
				address = domain.Address(node)
			}
		}
		return next, nil
	})
	if err != nil {
		return domain.RelayResponse{}, asValidation(err)
	}
	msg := "停用 Seller 出口中转"
	if id != nil {
		msg = "Seller 出口中转切换到 " + address
	}
	s.audit(ctx, actor, "PUT", "/api/admin/seller-relay/active", "platform_seller_relay_switched", msg)
	return domain.RelayResponse{Data: domain.RelayView(nodes, true, s.opt.Route)}, nil
}

// Delete removes a node. A missing id is still 200 and is not audited.
func (s *Relay) Delete(ctx context.Context, actor domain.Actor, id string) (domain.RelayResponse, error) {
	var existed bool
	var address string
	nodes, err := s.mutate(func(cur domain.Nodes) (domain.Nodes, error) {
		for _, stored := range cur.Nodes {
			if stored.ID == id {
				address = domain.Address(stored.Node)
			}
		}
		next, ok := domain.DeleteNode(cur, id)
		existed = ok
		return next, nil
	})
	if err != nil {
		return domain.RelayResponse{}, err
	}
	if existed {
		s.audit(ctx, actor, "DELETE", "/api/admin/seller-relay/nodes/{node_id}", "platform_seller_relay_node_deleted", "删除 Seller 出口中转节点 "+address)
	}
	return domain.RelayResponse{Data: domain.RelayView(nodes, true, s.opt.Route)}, nil
}

// Probe does not dial. No socks5h route is the spec's unreachable body.
// A present route is not ported: this process must not open a real proxy.
func (s *Relay) Probe() (domain.ProbeResponse, error) {
	if !strings.HasPrefix(s.opt.Route, "socks5h://") {
		return domain.ProbeResponse{Data: domain.ProbeData{Reachable: false}}, nil
	}
	// unconfirmed: reqwest Proxy::all on socks5h is not proven in this binary, and a real proxy must not be dialed.
	return domain.ProbeResponse{}, domain.NotPorted()
}

func (s *Relay) load() (domain.Nodes, error) {
	if s.dir() == "" {
		return domain.EmptyNodes(), nil
	}
	raw, err := os.ReadFile(filepath.Join(s.dir(), "nodes.json"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return domain.EmptyNodes(), nil
		}
		return domain.Nodes{}, domain.Fail(503, "UNAVAILABLE", msgRelayIO)
	}
	var nodes domain.Nodes
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&nodes); err != nil {
		return domain.Nodes{}, domain.Fail(503, "UNAVAILABLE", msgRelayIO)
	}
	if nodes.Nodes == nil {
		nodes.Nodes = []domain.StoredNode{}
	}
	return nodes, nil
}

func (s *Relay) mutate(change func(domain.Nodes) (domain.Nodes, error)) (domain.Nodes, error) {
	if s.dir() == "" {
		return domain.Nodes{}, domain.Fail(503, "UNAVAILABLE", msgNoSidecar)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, err := s.load()
	if err != nil {
		return domain.Nodes{}, err
	}
	next, err := change(cur)
	if err != nil {
		return domain.Nodes{}, err
	}
	if err := s.save(next); err != nil {
		return domain.Nodes{}, domain.Fail(503, "UNAVAILABLE", msgRelayIO)
	}
	return next, nil
}

func (s *Relay) save(nodes domain.Nodes) error {
	if nodes.Nodes == nil {
		nodes.Nodes = []domain.StoredNode{}
	}
	raw, err := marshalPretty(nodes)
	if err != nil {
		return err
	}
	dir := s.dir()
	if err := writeAtomic(filepath.Join(dir, "nodes.json"), raw); err != nil {
		return err
	}
	node, ok := domain.ActiveNode(nodes)
	cfgPath := filepath.Join(dir, "config.json")
	if !ok {
		if err := removeSwitch(s.opt.SwitchDir); err != nil {
			return err
		}
		return removeIfExists(cfgPath)
	}
	cfg := domain.SingBoxConfig(node)
	existing, err := os.ReadFile(cfgPath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil && bytes.Equal(existing, cfg) {
		return nil
	}
	if err := removeSwitch(s.opt.SwitchDir); err != nil {
		return err
	}
	return writeAtomic(cfgPath, cfg)
}

func removeSwitch(dir string) error {
	if strings.TrimSpace(dir) == "" {
		return nil
	}
	return removeIfExists(filepath.Join(dir, "active"))
}

func removeIfExists(path string) error {
	err := os.Remove(path)
	if err == nil || errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func writeAtomic(path string, body []byte) error {
	var b [16]byte
	_, _ = rand.Read(b[:])
	staging := strings.TrimSuffix(path, filepath.Ext(path)) + "." + hex.EncodeToString(b[:]) + ".tmp"
	f, err := os.OpenFile(staging, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, werr := f.Write(body)
	cerr := f.Close()
	if werr != nil {
		_ = os.Remove(staging)
		return werr
	}
	if cerr != nil {
		_ = os.Remove(staging)
		return cerr
	}
	if err := os.Rename(staging, path); err != nil {
		_ = os.Remove(staging)
		return err
	}
	return nil
}

func marshalPretty(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

func (s *Relay) audit(ctx context.Context, actor domain.Actor, method, path, action, message string) {
	if s.port == nil {
		return
	}
	if actor.OrgID < 0 {
		actor.OrgID = 0
	}
	_ = s.port.Audit(ctx, domain.Audit{
		OrgID: actor.OrgID, UserID: actor.UserID, Module: "admin", EntityType: "seller_relay",
		EntityID: "singleton", Method: method, Path: path, Action: action, Message: message,
	})
}

func summary(text string) string {
	raw, err := domain.Marshal(struct {
		Summary string `json:"summary"`
	}{Summary: text})
	if err != nil {
		return text
	}
	return string(raw)
}

func asValidation(err error) error {
	var ae *domain.APIError
	if errors.As(err, &ae) {
		return err
	}
	return domain.Fail(400, "VALIDATION", err.Error())
}

func shortID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return hex.EncodeToString(b[:])[:12]
}
