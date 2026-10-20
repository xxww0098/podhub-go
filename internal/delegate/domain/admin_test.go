package domain

import (
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
)

func TestNormalizeUUID(t *testing.T) {
	id := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	got, ok := NormalizeUUID("  " + strings.ToUpper(id) + "  ")
	if !ok || got != id {
		t.Fatalf("%q %v", got, ok)
	}
	for _, bad := range []string{"", "not-a-uuid", id[:35], strings.Replace(id, "-", "", 1)} {
		if _, ok := NormalizeUUID(bad); ok {
			t.Fatalf("%q accepted", bad)
		}
	}
}

func TestNormalizeNoteAndLineIDs(t *testing.T) {
	if _, err := NormalizeNote(strings.Repeat("字", 1001), "派发备注"); err == nil {
		t.Fatal("1001 runes")
	}
	got, err := NormalizeNote("  备注  ", "派发备注")
	if err != nil || got != "备注" {
		t.Fatal(err, got)
	}
	ids, err := NormalizeLineIDs([]string{
		"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
		"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
	})
	if err != nil || len(ids) != 1 {
		t.Fatal(ids, err)
	}
	if _, err := NormalizeLineIDs([]string{"bad"}); err == nil {
		t.Fatal("bad line")
	}
}

func TestResolveRequestedLines(t *testing.T) {
	lines := []string{"a", "b", "c"}
	all, err := ResolveRequestedLines(lines, nil)
	if err != nil || strings.Join(all, ",") != "a,b,c" {
		t.Fatal(all, err)
	}
	picked, err := ResolveRequestedLines(lines, []string{"c", "a"})
	if err != nil || strings.Join(picked, ",") != "a,c" {
		t.Fatal(picked, err)
	}
	_, err = ResolveRequestedLines(lines, []string{"c", "missing"})
	fail, ok := err.(*contract.APIError)
	if !ok || fail.Status != 422 || !strings.Contains(fail.Message, "missing") {
		t.Fatal(err)
	}
}

func TestMicrofen(t *testing.T) {
	got, err := Microfen(1)
	if err != nil || got != 1_000_000 {
		t.Fatal(got, err)
	}
	if _, err := Microfen(0); err == nil {
		t.Fatal("zero")
	}
	if _, err := Microfen(-1); err == nil {
		t.Fatal("negative")
	}
	if _, err := Microfen(1 << 62); err == nil {
		t.Fatal("overflow")
	}
}

func TestReceiptView(t *testing.T) {
	got := ReceiptView(map[string]any{"tracking_no": "TN", "at_ms": float64(7), "note": ""})
	if got.TrackingNo != "TN" || got.AtMs == nil || *got.AtMs != 7 {
		t.Fatalf("%+v", got)
	}
	empty := ReceiptView(map[string]any{"note": ""})
	if empty.Note != "" || empty.AtMs != nil {
		t.Fatal(empty)
	}
}

func TestSettleDispatchTable(t *testing.T) {
	cases := []struct {
		from string
		to   string
		err  bool
	}{
		{"", "settled", false},
		{"none", "settled", false},
		{"settled", "settled", false},
		{"held", "settled", false},
		{"released", "released", true},
		{"weird", "weird", true},
	}
	for _, c := range cases {
		to, err := SettleDispatch(c.from)
		if to != c.to || (err != nil) != c.err {
			t.Fatalf("%s -> %s %v", c.from, to, err)
		}
	}
}

func TestAdminCancelEdges(t *testing.T) {
	if _, err := AdminCancel("done", 0); err == nil {
		t.Fatal("done")
	}
	if _, err := AdminCancel("cancelled", 1); err == nil {
		t.Fatal("cancelled")
	}
	req, err := AdminCancel("dispatched", 1)
	if err != nil || req.Name != "cancel.request" || req.State != "dispatched" || !req.CancelRequested || !req.Recall || req.ReleaseHeld {
		t.Fatalf("%+v %v", req, err)
	}
	direct, err := AdminCancel("dispatched", 0)
	if err != nil || direct.Name != "cancel.direct" || direct.State != "cancelled" || !direct.Recall || !direct.ReleaseHeld {
		t.Fatalf("%+v", direct)
	}
}

func TestSellerAndDispatchKeys(t *testing.T) {
	if SellerKey("id") != "delegate:id" {
		t.Fatal(SellerKey("id"))
	}
	if DispatchNo("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee") != "dsp_aaaaaaaabbbbccccddddeeeeeeeeeeee" {
		t.Fatal(DispatchNo("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"))
	}
}
