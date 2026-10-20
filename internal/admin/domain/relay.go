package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
)

const socksPort = 1080

var fingerprints = []string{"chrome", "firefox", "edge", "safari", "360", "qq", "ios", "android", "random", "randomized"}

// VlessNode is one imported REALITY node. The credential stays in nodes.json.
type VlessNode struct {
	Name        string `json:"name"`
	Server      string `json:"server"`
	Port        uint16 `json:"port"`
	UUID        string `json:"uuid"`
	Flow        string `json:"flow"`
	ServerName  string `json:"serverName"`
	PublicKey   string `json:"publicKey"`
	ShortID     string `json:"shortId"`
	Fingerprint string `json:"fingerprint"`
}

// StoredNode is one row of nodes.json.
type StoredNode struct {
	ID   string    `json:"id"`
	Node VlessNode `json:"node"`
}

// Nodes is the nodes.json document. Active is null when the relay is off.
type Nodes struct {
	Active *string      `json:"active"`
	Nodes  []StoredNode `json:"nodes"`
}

// RelayNodeView is the public node. The UUID never leaves the process.
type RelayNodeView struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Address string `json:"address"`
	Active  bool   `json:"active"`
}

// RelayData is the seller-relay success object.
type RelayData struct {
	Nodes          []RelayNodeView `json:"nodes"`
	RelayRoute     *string         `json:"relayRoute"`
	SidecarManaged bool            `json:"sidecarManaged"`
}

// RelayResponse wraps RelayData.
type RelayResponse struct {
	Data RelayData `json:"data"`
}

// ProbeData is the probe result. Latency is omitted when the probe did not connect.
type ProbeData struct {
	Reachable bool    `json:"reachable"`
	LatencyMs *uint64 `json:"latencyMs,omitempty"`
}

// ProbeResponse wraps ProbeData.
type ProbeResponse struct {
	Data ProbeData `json:"data"`
}

// ParseVless parses one vless:// link.
func ParseVless(link string) (VlessNode, error) {
	u, err := url.Parse(strings.TrimSpace(link))
	if err != nil || u.Scheme == "" {
		return VlessNode{}, errors.New("不是有效的 vless:// 链接")
	}
	if u.Scheme != "vless" {
		return VlessNode{}, errors.New("不是 vless:// 链接")
	}
	id, err := uuid.Parse(u.User.Username())
	if err != nil {
		return VlessNode{}, errors.New("链接里的用户 ID 不是 UUID")
	}
	if _, ok := u.User.Password(); ok || (u.Path != "" && u.Path != "/") {
		return VlessNode{}, errors.New("链接格式不对：@ 前只能是 UUID，端口后不能带路径")
	}
	server := u.Hostname()
	if server == "" {
		return VlessNode{}, errors.New("链接缺少服务器地址")
	}
	portText := u.Port()
	nport, err := strconv.ParseUint(portText, 10, 16)
	if err != nil || nport == 0 {
		return VlessNode{}, errors.New("链接缺少端口")
	}
	port := uint16(nport)
	q := func(key string) string {
		vals := u.Query()[key]
		if len(vals) == 0 {
			return ""
		}
		return vals[len(vals)-1]
	}
	if q("security") != "reality" {
		return VlessNode{}, errors.New("只支持 REALITY（security=reality）")
	}
	if t := q("type"); t != "" && t != "tcp" {
		return VlessNode{}, errors.New("只支持 TCP 传输（type=tcp）")
	}
	if enc := q("encryption"); enc != "" && enc != "none" {
		return VlessNode{}, errors.New("VLESS 加密只支持 none")
	}
	flow := q("flow")
	if flow != "" && flow != "xtls-rprx-vision" {
		return VlessNode{}, errors.New("流控只支持 xtls-rprx-vision")
	}
	sni := q("sni")
	if sni == "" {
		return VlessNode{}, errors.New("链接缺少 sni（REALITY 伪装域名）")
	}
	if len(sni) > 253 || !sniOK(sni) {
		return VlessNode{}, errors.New("sni 不是有效的域名")
	}
	pbk := q("pbk")
	if pbk == "" {
		return VlessNode{}, errors.New("链接缺少公钥 pbk")
	}
	if len(pbk) != 43 || !pbkOK(pbk) {
		return VlessNode{}, errors.New("公钥 pbk 无效")
	}
	sid := q("sid")
	if len(sid) > 16 || len(sid)%2 != 0 || !hexOK(sid) {
		return VlessNode{}, errors.New("short id（sid）须为不超过 16 位的偶数长度十六进制")
	}
	fp := q("fp")
	if fp == "" {
		fp = "chrome"
	}
	if !containsStr(fingerprints, fp) {
		return VlessNode{}, errors.New("不支持的指纹 fp")
	}
	name := u.Fragment
	if utf8.RuneCountInString(name) > 64 {
		name = string([]rune(name)[:64])
	}
	return VlessNode{
		Name: name, Server: server, Port: port, UUID: id.String(), Flow: flow,
		ServerName: sni, PublicKey: pbk, ShortID: sid, Fingerprint: fp,
	}, nil
}

func sniOK(s string) bool {
	for _, c := range s {
		if c > 127 || !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-') {
			return false
		}
	}
	return true
}

func pbkOK(s string) bool {
	for _, c := range s {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func hexOK(s string) bool {
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func containsStr(ss []string, v string) bool {
	for _, s := range ss {
		if s == v {
			return true
		}
	}
	return false
}

// ParseLinks parses a textarea. A blank line still counts in the 1-based line number.
func ParseLinks(text string) ([]VlessNode, error) {
	lines := strings.Split(text, "\n")
	var out []VlessNode
	any := false
	for i, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		any = true
		node, err := ParseVless(line)
		if err != nil {
			return nil, fmt.Errorf("第 %d 行：%s", i+1, err.Error())
		}
		out = append(out, node)
	}
	if !any {
		return nil, errors.New("先粘贴 vless:// 链接，每行一个")
	}
	return out, nil
}

// AddNodes appends nodes that are not already stored under (server, port, uuid).
// The 32 cap is checked after the whole batch. On error the caller must not save.
func AddNodes(cur Nodes, add []VlessNode, id func() string) (Nodes, int, error) {
	if cur.Nodes == nil {
		cur.Nodes = []StoredNode{}
	}
	added := 0
	for _, n := range add {
		if nodeExists(cur, n) {
			continue
		}
		cur.Nodes = append(cur.Nodes, StoredNode{ID: id(), Node: n})
		added++
	}
	if len(cur.Nodes) > 32 {
		return Nodes{}, 0, errors.New("最多保存 32 个节点")
	}
	return cur, added, nil
}

func nodeExists(cur Nodes, n VlessNode) bool {
	for _, stored := range cur.Nodes {
		if stored.Node.Server == n.Server && stored.Node.Port == n.Port && stored.Node.UUID == n.UUID {
			return true
		}
	}
	return false
}

// Activate selects id, or clears the selection when id is nil.
func Activate(cur Nodes, id *string) (Nodes, error) {
	if id == nil {
		cur.Active = nil
		return cur, nil
	}
	for _, stored := range cur.Nodes {
		if stored.ID == *id {
			cur.Active = id
			return cur, nil
		}
	}
	return cur, errors.New("节点不存在，请刷新后重试")
}

// DeleteNode drops id. existed is false when the id was already gone; active is still cleared if it matched.
func DeleteNode(cur Nodes, id string) (Nodes, bool) {
	existed := false
	next := make([]StoredNode, 0, len(cur.Nodes))
	for _, stored := range cur.Nodes {
		if stored.ID == id {
			existed = true
			continue
		}
		next = append(next, stored)
	}
	cur.Nodes = next
	if cur.Active != nil && *cur.Active == id {
		cur.Active = nil
	}
	return cur, existed
}

// Address is host:port, or [v6]:port when the server contains a colon.
func Address(n VlessNode) string {
	if strings.Contains(n.Server, ":") {
		return fmt.Sprintf("[%s]:%d", n.Server, n.Port)
	}
	return fmt.Sprintf("%s:%d", n.Server, n.Port)
}

// SingBoxConfig is the sing-box document for one node. An empty flow omits that key.
// The bytes match the extracted fixture, including its trailing newline.
func SingBoxConfig(n VlessNode) []byte {
	flow := ""
	if n.Flow != "" {
		flow = "\n    \"flow\": " + js(n.Flow) + ","
	}
	s := "{\n  \"log\": { \"level\": \"warn\", \"timestamp\": true },\n  \"inbounds\": [{ \"type\": \"socks\", \"listen\": \"0.0.0.0\", \"listen_port\": " + fmt.Sprint(socksPort) + " }],\n  \"outbounds\": [{\n    \"type\": \"vless\",\n    \"server\": " + js(n.Server) + ",\n    \"server_port\": " + fmt.Sprint(n.Port) + ",\n    \"uuid\": " + js(n.UUID) + "," + flow + "\n    \"tls\": {\n      \"enabled\": true,\n      \"server_name\": " + js(n.ServerName) + ",\n      \"utls\": { \"enabled\": true, \"fingerprint\": " + js(n.Fingerprint) + " },\n      \"reality\": {\n        \"enabled\": true,\n        \"public_key\": " + js(n.PublicKey) + ",\n        \"short_id\": " + js(n.ShortID) + "\n      }\n    }\n  }]\n}\n"
	return []byte(s)
}

func js(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return `""`
	}
	return string(b)
}

// RelayView builds the GET body. route is included only when it starts with socks5h://.
func RelayView(nodes Nodes, dirSet bool, route string) RelayData {
	views := make([]RelayNodeView, 0, len(nodes.Nodes))
	for _, stored := range nodes.Nodes {
		views = append(views, RelayNodeView{
			ID: stored.ID, Name: stored.Node.Name, Address: Address(stored.Node),
			Active: nodes.Active != nil && *nodes.Active == stored.ID,
		})
	}
	var label *string
	if strings.HasPrefix(route, "socks5h://") {
		label = &route
	}
	return RelayData{Nodes: views, RelayRoute: label, SidecarManaged: dirSet}
}

// ActiveNode returns the selected node when it is still in the list.
func ActiveNode(nodes Nodes) (VlessNode, bool) {
	if nodes.Active == nil {
		return VlessNode{}, false
	}
	for _, stored := range nodes.Nodes {
		if stored.ID == *nodes.Active {
			return stored.Node, true
		}
	}
	return VlessNode{}, false
}

// EmptyNodes is a missing nodes.json file.
func EmptyNodes() Nodes { return Nodes{Nodes: []StoredNode{}} }

// DecodeImport reads the links textarea. Unknown fields are 请求格式无效.
func DecodeImport(raw []byte) (string, *APIError) {
	var body struct {
		Links *string `json:"links"`
	}
	if err := decodeStrict(raw, &body); err != nil || body.Links == nil {
		return "", Fail(400, "VALIDATION", "请求格式无效")
	}
	return *body.Links, nil
}

// DecodeSwitch reads nodeId. Missing the key is 请求格式无效. JSON null clears the relay.
func DecodeSwitch(raw []byte) (*string, *APIError) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var body map[string]json.RawMessage
	if err := dec.Decode(&body); err != nil {
		return nil, Fail(400, "VALIDATION", "请求格式无效")
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return nil, Fail(400, "VALIDATION", "请求格式无效")
	}
	rawID, ok := body["nodeId"]
	if !ok || len(body) != 1 {
		return nil, Fail(400, "VALIDATION", "请求格式无效")
	}
	if string(bytes.TrimSpace(rawID)) == "null" {
		return nil, nil
	}
	var id string
	if err := json.Unmarshal(rawID, &id); err != nil {
		return nil, Fail(400, "VALIDATION", "请求格式无效")
	}
	return &id, nil
}
