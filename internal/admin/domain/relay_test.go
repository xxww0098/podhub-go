package domain

import (
	"os"
	"strings"
	"testing"
)

const sampleLink = "vless://0F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9@203.0.113.7:34567?encryption=none&security=reality&flow=xtls-rprx-vision&type=tcp&sni=www.example.com&pbk=oPqDxkIL_PywLy8a-8OfaJWEQwY3dzBwXoaFgpd8S3g&fp=chrome#233boy-reality-203.0.113.7"

func TestSingBoxMatchesFixture(t *testing.T) {
	node, err := ParseVless(sampleLink)
	if err != nil {
		t.Fatal(err)
	}
	if node.UUID != "0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9" || node.Name != "233boy-reality-203.0.113.7" || node.ShortID != "" || node.Fingerprint != "chrome" {
		t.Fatalf("%+v", node)
	}
	got := SingBoxConfig(node)
	want, err := os.ReadFile("testdata/sing-box-expected.json")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
}

func TestOptionalVlessDefaults(t *testing.T) {
	link := "vless://0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9@203.0.113.7:443?security=reality&sni=a.example&pbk=oPqDxkIL_PywLy8a-8OfaJWEQwY3dzBwXoaFgpd8S3g&sid=0a1b"
	node, err := ParseVless(link)
	if err != nil {
		t.Fatal(err)
	}
	if node.Flow != "" || node.Fingerprint != "chrome" || node.ShortID != "0a1b" || node.Name != "" {
		t.Fatalf("%+v", node)
	}
	raw := string(SingBoxConfig(node))
	if strings.Contains(raw, `"flow"`) {
		t.Fatal(raw)
	}
}

func TestVlessRefusals(t *testing.T) {
	cases := []struct{ link, want string }{
		{"http://example.com", "不是 vless:// 链接"},
		{"not a url", "不是有效的 vless:// 链接"},
		{"vless://not-a-uuid@203.0.113.7:443?security=reality", "链接里的用户 ID 不是 UUID"},
		{"vless://0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9:secret@203.0.113.7:443?security=reality", "链接格式不对：@ 前只能是 UUID，端口后不能带路径"},
		{"vless://0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9@203.0.113.7:443?security=tls&sni=a.example&pbk=oPqDxkIL_PywLy8a-8OfaJWEQwY3dzBwXoaFgpd8S3g", "只支持 REALITY（security=reality）"},
		{"vless://0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9@203.0.113.7:443?security=reality&sni=a.example&pbk=short", "公钥 pbk 无效"},
		{"vless://0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9@203.0.113.7:443?security=reality&sni=a.example&pbk=oPqDxkIL_PywLy8a-8OfaJWEQwY3dzBwXoaFgpd8S3g&fp=ie", "不支持的指纹 fp"},
	}
	for _, tc := range cases {
		_, err := ParseVless(tc.link)
		if err == nil || err.Error() != tc.want {
			t.Fatalf("%s got %v", tc.want, err)
		}
	}
	_, err := ParseLinks("\n\n")
	if err == nil || err.Error() != "先粘贴 vless:// 链接，每行一个" {
		t.Fatal(err)
	}
	_, err = ParseLinks("\nbad\n")
	if err == nil || err.Error() != "第 2 行：不是有效的 vless:// 链接" {
		t.Fatal(err)
	}
}

func TestAddNodesCapAndDedup(t *testing.T) {
	node, err := ParseVless(sampleLink)
	if err != nil {
		t.Fatal(err)
	}
	renamed := node
	renamed.Name = "other"
	cur, added, err := AddNodes(EmptyNodes(), []VlessNode{node, renamed}, func() string { return "abc123abc123" })
	if err != nil || added != 1 || len(cur.Nodes) != 1 || cur.Nodes[0].Node.Name != node.Name {
		t.Fatalf("%d %+v %v", added, cur, err)
	}
	var many []VlessNode
	for i := 0; i < 32; i++ {
		n := node
		n.Port = uint16(1000 + i)
		many = append(many, n)
	}
	if _, _, err := AddNodes(cur, many, func() string { return "id" }); err == nil || err.Error() != "最多保存 32 个节点" {
		t.Fatal(err)
	}
}

func TestActivateAndView(t *testing.T) {
	id := "n1"
	cur := Nodes{Nodes: []StoredNode{{ID: id, Node: VlessNode{Server: "203.0.113.7", Port: 443, Name: "a"}}}}
	next, err := Activate(cur, &id)
	if err != nil || next.Active == nil || *next.Active != id {
		t.Fatal(err)
	}
	if _, err := Activate(cur, strPtr("missing")); err == nil || err.Error() != "节点不存在，请刷新后重试" {
		t.Fatal(err)
	}
	off, err := Activate(next, nil)
	if err != nil || off.Active != nil {
		t.Fatal(err)
	}
	gone, existed := DeleteNode(next, id)
	if !existed || len(gone.Nodes) != 0 || gone.Active != nil {
		t.Fatalf("%+v %v", gone, existed)
	}
	view := RelayView(next, true, "")
	if view.RelayRoute != nil || !view.SidecarManaged || !view.Nodes[0].Active {
		t.Fatalf("%+v", view)
	}
	route := "socks5h://seller-relay:1080"
	view = RelayView(EmptyNodes(), false, route)
	if view.RelayRoute == nil || *view.RelayRoute != route || view.SidecarManaged {
		t.Fatalf("%+v", view)
	}
	if Address(VlessNode{Server: "2001:db8::1", Port: 1}) != "[2001:db8::1]:1" {
		t.Fatal(Address(VlessNode{Server: "2001:db8::1", Port: 1}))
	}
}

func strPtr(s string) *string { return &s }
