package bench

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	submitdomain "github.com/xxww0098/podhub-go/internal/listing/submit/domain"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/httpx"
	"github.com/xxww0098/podhub-go/internal/seller"
	sellercontract "github.com/xxww0098/podhub-go/internal/seller/contract"
)

// TestSellerRepliesMatchRestricted checks the bytes, status, error mapping,
// and single attempt that seller.Egress returns against the pre-change
// client: Restricted transport, LimitReader of 1MB, no HTTP retry.
func TestSellerRepliesMatchRestricted(t *testing.T) {
	const reqBody = `{"items":[{"offer_id":"a"}]}`
	cases := []struct {
		name   string
		path   string
		write  bool
		status int
		resp   string
		task   int64
		code   int64
		big    bool
	}{
		{name: "import 200 task 42", path: "/v3/product/import", write: true, status: 200, resp: `{"result":{"task_id":42}}`, task: 42},
		{name: "import 400 code 3", path: "/v3/product/import", write: true, status: 400, resp: `{"code":3}`, code: 3},
		{name: "import 401 code 16", path: "/v3/product/import", write: true, status: 401, resp: `{"code":16}`, code: 16},
		{name: "import 403 code 7", path: "/v3/product/import", write: true, status: 403, resp: `{"code":7}`, code: 7},
		{name: "import 403 code 9", path: "/v3/product/import", write: true, status: 403, resp: `{"code":9}`, code: 9},
		{name: "import 429 code 8", path: "/v3/product/import", write: true, status: 429, resp: `{"code":8}`, code: 8},
		{name: "import 500", path: "/v3/product/import", write: true, status: 500, resp: `{"code":13,"message":"boom"}`, code: 13},
		{name: "info list 200", path: "/v3/product/info/list", status: 200, resp: `{"items":[{"offer_id":"a"}]}`},
		{name: "seller info 200", path: "/v1/seller/info", status: 200, resp: `{"company":{"name":"shop"}}`},
		{name: "warehouse list 200", path: "/v2/warehouse/list", status: 200, resp: `{"warehouses":[]}`},
		{name: "import over 1MB", path: "/v3/product/import", write: true, status: 200, big: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := tc.resp
			if tc.big {
				resp = strings.Repeat("x", (1<<20)+32)
			}
			var hits atomic.Int32
			var accepts atomic.Int64
			var snap reqSnap
			srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				raw, _ := io.ReadAll(r.Body)
				snap = reqSnap{
					method: r.Method,
					path:   r.URL.Path,
					ct:     r.Header.Get("Content-Type"),
					cid:    r.Header.Get("Client-Id"),
					key:    r.Header.Get("Api-Key"),
					expect: r.Header.Get("Expect"),
					body:   string(raw),
				}
				hits.Add(1)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(resp))
			}))
			srv.Config.ConnState = func(_ net.Conn, state http.ConnState) {
				if state == http.StateNew {
					accepts.Add(1)
				}
			}
			srv.Start()
			t.Cleanup(srv.Close)
			if !strings.HasPrefix(srv.URL, "http://127.0.0.1:") {
				t.Fatal(srv.URL)
			}

			oldClient := &http.Client{
				Timeout:       30 * time.Second,
				Transport:     httpx.Restricted(),
				CheckRedirect: httpx.UseLast,
			}
			before := hits.Load()
			oldStatus, oldBody, oldErr := restrictedExchange(t, oldClient, srv.URL+tc.path, []byte(reqBody))
			oldSnap := snap
			if hits.Load()-before != 1 {
				t.Fatalf("old hits %d", hits.Load()-before)
			}

			t.Setenv("CLOUD_SELLER_BASE_URL", srv.URL+"/")
			t.Setenv("OZON_WRITE_KILL_SWITCH", "0")
			eg := seller.New(config.Load())
			before = hits.Load()
			reply, newErr := eg.Call(context.Background(), http.MethodPost, tc.path, []byte(reqBody), tc.write, false, "cid", "key")
			newSnap := snap
			if hits.Load()-before != 1 {
				t.Fatalf("new hits %d", hits.Load()-before)
			}
			if (oldErr == nil) != (newErr == nil) || oldStatus != reply.Status || oldBody != reply.Body {
				t.Fatalf("old %d %q err %v new %d %q err %v", oldStatus, oldBody, oldErr, reply.Status, reply.Body, newErr)
			}
			if newSnap != oldSnap || newSnap.expect != "" || newSnap.body != reqBody || newSnap.cid != "cid" || newSnap.key != "key" || newSnap.ct != "application/json" || newSnap.method != http.MethodPost || newSnap.path != tc.path {
				t.Fatalf("request old %+v new %+v", oldSnap, newSnap)
			}
			if gotTask, gotCode := taskID(reply.Body), providerCode(reply.Body); gotTask != tc.task || gotCode != tc.code {
				t.Fatalf("task %d code %d", gotTask, gotCode)
			}
			if tc.big && len(reply.Body) != 1<<20 {
				t.Fatalf("prefix %d", len(reply.Body))
			}
			oldOut := submitdomain.Classify(attemptReply(oldStatus, oldBody, oldErr))
			newOut := submitdomain.Classify(attemptReply(reply.Status, reply.Body, newErr))
			if oldOut != newOut {
				t.Fatalf("classify old %+v new %+v", oldOut, newOut)
			}
			if newOut.Requests != 1 {
				t.Fatalf("requests %d", newOut.Requests)
			}

			before = hits.Load()
			again, againErr := eg.Call(context.Background(), http.MethodPost, tc.path, []byte(reqBody), tc.write, false, "cid", "key")
			if hits.Load()-before != 1 || againErr != nil || again.Status != reply.Status || again.Body != reply.Body {
				t.Fatalf("again hits %d err %v status %d", hits.Load()-before, againErr, again.Status)
			}
			// Two transports, one request each, then the drained Ozon connection is reused.
			if accepts.Load() != 2 {
				t.Fatalf("accepts %d", accepts.Load())
			}
			if tc.write && eg.WritePosts() != 2 || !tc.write && eg.ReadPosts() != 2 {
				t.Fatalf("writePosts %d readPosts %d", eg.WritePosts(), eg.ReadPosts())
			}
		})
	}
}

func TestSellerKillSwitchSendsNothing(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"result":{"task_id":1}}`))
	}))
	t.Cleanup(srv.Close)
	t.Setenv("CLOUD_SELLER_BASE_URL", srv.URL+"/")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	eg := seller.New(config.Load())
	reply, err := eg.Write(context.Background(), "/v3/product/import", []byte(`{}`))
	if err == nil || reply.Status != 0 || reply.Body != "" || eg.WritePosts() != 0 || hits.Load() != 0 {
		t.Fatalf("write err %v reply %+v posts %d hits %d", err, reply, eg.WritePosts(), hits.Load())
	}
	status, body, portErr := eg.Port().Write(context.Background(), "/v3/product/import", []byte(`{}`))
	if status != 0 || body != "" || portErr == nil || hits.Load() != 0 {
		t.Fatalf("port %d %q %v hits %d", status, body, portErr, hits.Load())
	}
	if !errors.Is(portErr, sellercontract.ErrNotSent) {
		t.Fatal(portErr)
	}
	out := submitdomain.Classify(submitdomain.Reply{WritesDisabled: true})
	if out.Requests != 0 || out.IntentError != submitdomain.CodeWritesDisabled {
		t.Fatalf("%+v", out)
	}
}

func TestSellerRefusedPortMatchesRestricted(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	base := "http://" + addr + "/"
	oldClient := &http.Client{
		Timeout:       2 * time.Second,
		Transport:     httpx.Restricted(),
		CheckRedirect: httpx.UseLast,
	}
	oldStatus, oldBody, oldErr := restrictedExchange(t, oldClient, strings.TrimRight(base, "/")+"/v3/product/info/list", []byte(`{}`))
	t.Setenv("CLOUD_SELLER_BASE_URL", base)
	t.Setenv("OZON_WRITE_KILL_SWITCH", "0")
	eg := seller.New(config.Load())
	eg.SetTimeout(2 * time.Second)
	reply, newErr := eg.Read(context.Background(), "/v3/product/info/list", []byte(`{}`))
	if oldErr == nil || newErr == nil || oldStatus != 0 || reply.Status != 0 || oldBody != "" || reply.Body != "" {
		t.Fatalf("old %d %q %v new %d %q %v", oldStatus, oldBody, oldErr, reply.Status, reply.Body, newErr)
	}
	oldOut := submitdomain.Classify(attemptReply(oldStatus, oldBody, oldErr))
	newOut := submitdomain.Classify(attemptReply(reply.Status, reply.Body, newErr))
	if oldOut != newOut || newOut.Requests != 1 || newOut.IntentError != submitdomain.CodeDispatchInterrupted {
		t.Fatalf("old %+v new %+v", oldOut, newOut)
	}
	if eg.ReadPosts() != 1 {
		t.Fatalf("read posts %d", eg.ReadPosts())
	}
}

type reqSnap struct {
	method, path, ct, cid, key, expect, body string
}

func restrictedExchange(t *testing.T, client *http.Client, rawURL string, body []byte) (int, string, error) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, rawURL, strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Client-Id", "cid")
	req.Header.Set("Api-Key", "key")
	res, err := client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return res.StatusCode, "", err
	}
	return res.StatusCode, string(raw), nil
}

func attemptReply(status int, body string, err error) submitdomain.Reply {
	if err != nil && status == 0 {
		return submitdomain.Reply{Sent: true, Status: 0}
	}
	return submitdomain.Reply{
		Sent:         true,
		Status:       status,
		Body:         body,
		TaskID:       taskID(body),
		ProviderCode: providerCode(body),
	}
}

func providerCode(body string) int64 {
	var parsed struct {
		Code int64 `json:"code"`
	}
	if json.Unmarshal([]byte(body), &parsed) != nil {
		return 0
	}
	return parsed.Code
}

func taskID(body string) int64 {
	var parsed struct {
		Result struct {
			TaskID int64 `json:"task_id"`
		} `json:"result"`
		TaskID int64 `json:"task_id"`
	}
	if json.Unmarshal([]byte(body), &parsed) != nil {
		return 0
	}
	if parsed.Result.TaskID > 0 {
		return parsed.Result.TaskID
	}
	return parsed.TaskID
}

func TestForwardBodyMatchesRestricted(t *testing.T) {
	payload := strings.Repeat("y", (1<<20)+8)
	const reqBody = `{"limit":1}`
	var hits atomic.Int32
	var accepts atomic.Int64
	var snap reqSnap
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		snap = reqSnap{
			method: r.Method,
			path:   r.URL.RequestURI(),
			ct:     r.Header.Get("Content-Type"),
			cid:    r.Header.Get("Client-Id"),
			key:    r.Header.Get("Api-Key"),
			expect: r.Header.Get("Expect"),
			body:   string(raw),
		}
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(payload))
	}))
	srv.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			accepts.Add(1)
		}
	}
	srv.Start()
	t.Cleanup(srv.Close)
	oldReq, err := http.NewRequest(http.MethodPost, srv.URL+"/v2/warehouse/list?lang=zh", bytes.NewReader([]byte(reqBody)))
	if err != nil {
		t.Fatal(err)
	}
	oldReq.Header.Set("Content-Type", "application/json")
	oldReq.Header.Set("Client-Id", "cid")
	oldReq.Header.Set("Api-Key", "key")
	oldRes, err := (&http.Client{Timeout: 30 * time.Second, Transport: httpx.Restricted(), CheckRedirect: httpx.UseLast}).Do(oldReq)
	if err != nil {
		t.Fatal(err)
	}
	oldRaw, err := io.ReadAll(oldRes.Body)
	oldRes.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	oldSnap := snap
	t.Setenv("CLOUD_SELLER_BASE_URL", srv.URL+"/")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "0")
	eg := seller.New(config.Load())
	fwd, err := eg.Forward(context.Background(), http.MethodPost, "/v2/warehouse/list", "lang=zh", "application/json", []byte(reqBody), "cid", "key")
	if err != nil || fwd.Status != oldRes.StatusCode || fwd.Body != string(oldRaw) || len(fwd.Body) != len(payload) {
		t.Fatalf("forward %v status %d/%d len %d/%d", err, fwd.Status, oldRes.StatusCode, len(fwd.Body), len(oldRaw))
	}
	if snap != oldSnap || snap.expect != "" || snap.body != reqBody || snap.path != "/v2/warehouse/list?lang=zh" {
		t.Fatalf("request old %+v new %+v", oldSnap, snap)
	}
	if _, err := eg.Forward(context.Background(), http.MethodPost, "/v2/warehouse/list", "lang=zh", "application/json", []byte(reqBody), "cid", "key"); err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 3 || accepts.Load() != 2 {
		t.Fatalf("hits %d accepts %d", hits.Load(), accepts.Load())
	}
}
