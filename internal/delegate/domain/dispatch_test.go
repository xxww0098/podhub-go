package domain

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
)

type dispatchVector struct {
	Name     string `json:"name"`
	Action   string `json:"action"`
	Dispatch string `json:"dispatch"`
	Order    string `json:"order"`
	Member   bool   `json:"member"`
	Found    bool   `json:"found"`
	Want     string `json:"want"`
	Err      string `json:"err"`
}

func TestDispatchVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/dispatch_edges.json")
	if err != nil {
		t.Fatal(err)
	}
	var rows []dispatchVector
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) < 20 {
		t.Fatalf("named edges %d", len(rows))
	}
	legal := map[string]string{}
	for _, row := range rows {
		got, err := ApplyDispatch(row.Action, row.Dispatch, row.Order, row.Member, row.Found)
		if row.Err == "" {
			if err != nil || got != row.Want {
				t.Fatalf("%s: got %q %v", row.Name, got, err)
			}
			legal[edgeKey(row.Action, row.Dispatch, row.Order, row.Member, row.Found)] = row.Want
			continue
		}
		if err == nil || errString(err) != row.Err {
			t.Fatalf("%s: got %q %v, want err %s", row.Name, got, err, row.Err)
		}
	}
	actions := []string{ActionAccept, ActionReject, ActionShip, "nudge"}
	dispatches := []string{"dispatched", "accepted", "shipped", "rejected", "cancelled", ""}
	orders := []string{"awaiting_setup", "ready", "dispatched", "in_production", "shipped", "done", "cancelled", ""}
	for _, action := range actions {
		for _, dispatch := range dispatches {
			for _, order := range orders {
				for _, member := range []bool{true, false} {
					for _, found := range []bool{true, false} {
						key := edgeKey(action, dispatch, order, member, found)
						got, err := ApplyDispatch(action, dispatch, order, member, found)
						want, ok := legal[key]
						if ok {
							if err != nil || got != want {
								t.Fatalf("legal %s got %q %v", key, got, err)
							}
							continue
						}
						if err == nil {
							t.Fatalf("unlisted edge succeeded: %s -> %s", key, got)
						}
					}
				}
			}
		}
	}
}

func edgeKey(action, dispatch, order string, member, found bool) string {
	m, f := "0", "0"
	if member {
		m = "1"
	}
	if found {
		f = "1"
	}
	return action + "|" + dispatch + "|" + order + "|" + m + "|" + f
}

func errString(err error) string {
	switch err {
	case contract.ErrNotFound:
		return "not_found"
	case contract.ErrForbidden:
		return "forbidden"
	case contract.ErrTerminal:
		return "terminal"
	case contract.ErrUnknownAction:
		return "unknown_action"
	default:
		return err.Error()
	}
}
