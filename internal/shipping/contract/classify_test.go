package contract

import "testing"

func TestPickListedTable(t *testing.T) {
	express := Method{ID: 3, WarehouseID: 1, Name: "Express", Express: true}
	other := Method{ID: 7, WarehouseID: 1, Name: "other", Express: false}
	far := Method{ID: 9, WarehouseID: 2, Name: "Express", Express: true}
	blank := Method{ID: 4, WarehouseID: 1, Name: "", Express: true}
	methods := []Method{other, far, blank, express}
	known := int64(7)
	empty := ""
	name := "Express"
	cases := []struct {
		name   string
		filter *string
		known  *int64
		want   int
	}{
		{"known id wins", nil, &known, 0},
		{"nil filter takes first express on warehouse", nil, nil, 2},
		{"empty filter requires an empty name", &empty, nil, 2},
		{"name filter", &name, nil, 3},
		{"missing known falls through", nil, i64(8), 2},
	}
	for _, tc := range cases {
		if got := PickListed(tc.filter, 1, tc.known, methods); got != tc.want {
			t.Fatalf("%s: got %d want %d", tc.name, got, tc.want)
		}
	}
	if PickListed(&name, 1, nil, nil) != -1 {
		t.Fatal("empty list")
	}
}

func TestProofAndSentences(t *testing.T) {
	now := int64(1_000_000)
	fresh := now - 1000
	stale := now - AbsenceFreshMS - 1
	edge := now - AbsenceFreshMS
	wh := int64(1)
	if ProofMessage("unknown", &fresh, nil, now) != "" {
		t.Fatal("fresh")
	}
	if ProofMessage("unknown", &edge, nil, now) != "" {
		t.Fatal("edge")
	}
	if ProofMessage("unknown", &stale, nil, now) != "远端不存在证明已过期，请先重新核对" {
		t.Fatal("stale")
	}
	if ProofMessage("unknown", nil, nil, now) != "须先重新核对并证明远端不存在" {
		t.Fatal("missing proof")
	}
	if ProofMessage("waiting", &fresh, nil, now) != "须先重新核对并证明远端不存在" {
		t.Fatal("inflight")
	}
	if !CanSafeContinue("unknown", &stale, nil) || CanSafeContinue("unknown", &fresh, &wh) {
		t.Fatal("flag")
	}
	if SafeError("unknown", &fresh) != "远端未找到同名仓库，可安全继续" || SafeError("failed", nil) != "注入已失败" || SafeError("waiting", nil) != "" {
		t.Fatal("sentence")
	}
	if !Inflight("queued") || !Inflight("submitting") || !Inflight("waiting") || Inflight("unknown") {
		t.Fatal("inflight set")
	}
}

func i64(n int64) *int64 { return &n }
