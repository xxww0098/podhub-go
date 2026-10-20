package service

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/ratings/contract"
	"github.com/xxww0098/podhub-go/internal/ratings/domain"
)

type fakeStore struct {
	gate     domain.Gate
	gateErr  error
	due      []domain.Due
	finishes []bool
	applied  int
	bodies   [][]domain.Rating
}

func (f *fakeStore) Gate(context.Context, int64, int64, string) (domain.Gate, error) {
	return f.gate, f.gateErr
}
func (f *fakeStore) Apply(_ context.Context, _ int64, _ string, items []domain.Rating, _ time.Time, _ map[string]int) (domain.ApplyResult, error) {
	f.applied++
	f.bodies = append(f.bodies, items)
	return domain.ApplyResult{}, nil
}
func (f *fakeStore) List(context.Context, int64, string) ([]domain.Snapshot, error) {
	return nil, nil
}
func (f *fakeStore) History(context.Context, int64, string, string, int64, int) ([]domain.HistoryRow, error) {
	return nil, nil
}
func (f *fakeStore) ClaimDue(context.Context, time.Time, time.Duration, int, int, int) ([]domain.Due, error) {
	return f.due, nil
}
func (f *fakeStore) Finish(context.Context, int64, string, time.Time, bool) error {
	f.finishes = append(f.finishes, true)
	return nil
}
func (f *fakeStore) Prune(context.Context, time.Time) (int64, error) { return 0, nil }

type script struct {
	errs   []error
	bodies [][]byte
	n      int
}

func (s *script) Post(context.Context, int64, string) ([]byte, error) {
	i := s.n
	s.n++
	if i < len(s.errs) && s.errs[i] != nil {
		return nil, s.errs[i]
	}
	if i < len(s.bodies) {
		return s.bodies[i], nil
	}
	return []byte(`{"ratings":[]}`), nil
}

func TestSyncIsolatesFailuresAndDropsSecrets(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	store := &fakeStore{due: []domain.Due{{OrgID: 1, StoreID: "s1"}, {OrgID: 1, StoreID: "s2"}}}
	src := &script{
		errs: []error{errSecret},
		bodies: [][]byte{
			nil,
			[]byte(`{"ratings":[
				{"rating":"rating_ok","name":"fixture-api-key-rt1","status":"OK","value_type":"RATIO","current_value":1},
				{"rating":"rating_ok2","name":"fine","status":"OK","value_type":"RATIO","current_value":2}
			]}`),
		},
	}
	svc := New(store)
	svc.Source = src
	svc.Now = func() time.Time { return time.Unix(1_700_000_000, 0).UTC() }
	if err := svc.SyncDue(context.Background()); err != nil {
		t.Fatal(err)
	}
	if store.applied != 1 || len(store.finishes) != 2 {
		t.Fatalf("applied %d finishes %d", store.applied, len(store.finishes))
	}
	if len(store.bodies) != 1 || len(store.bodies[0]) != 1 || store.bodies[0][0].Key != "rating_ok2" {
		t.Fatalf("kept %+v", store.bodies)
	}
	if strings.Contains(buf.String(), "fixture-api-key-rt1") || strings.Contains(buf.String(), "fixture-client-rt1") {
		t.Fatal("log contains a fixture secret")
	}
}

var errSecret = secretErr{}

type secretErr struct{}

func (secretErr) Error() string { return "upstream echoed fixture-api-key-rt1" }

func TestNilSourceDoesNotDial(t *testing.T) {
	store := &fakeStore{due: []domain.Due{{OrgID: 2, StoreID: "s"}}}
	svc := New(store)
	if err := svc.SyncDue(context.Background()); err != nil {
		t.Fatal(err)
	}
	if store.applied != 0 || len(store.finishes) != 1 {
		t.Fatalf("applied %d finishes %d", store.applied, len(store.finishes))
	}
}

func TestVisibility(t *testing.T) {
	owner := &fakeStore{gate: domain.Gate{MemberID: 9, Role: "owner"}}
	svc := New(owner)
	if _, err := svc.List(context.Background(), 1, 2, "11111111-1111-1111-1111-111111111111"); err != nil {
		t.Fatal(err)
	}
	viewer := &fakeStore{gate: domain.Gate{MemberID: 4, Role: "viewer"}}
	svc = New(viewer)
	if _, err := svc.List(context.Background(), 1, 2, "11111111-1111-1111-1111-111111111111"); !isNotFound(err) {
		t.Fatal(err)
	}
	assigned := int64(4)
	viewer.gate.Assignee = &assigned
	if _, err := svc.List(context.Background(), 1, 2, "11111111-1111-1111-1111-111111111111"); err != nil {
		t.Fatal(err)
	}
	none := &fakeStore{}
	svc = New(none)
	if _, err := svc.List(context.Background(), 1, 2, "11111111-1111-1111-1111-111111111111"); err != contract.ErrForbidden {
		t.Fatal(err)
	}
	if access.StoreVisible("viewer", nil, 4) {
		t.Fatal("viewer sees an unassigned store")
	}
}

func isNotFound(err error) bool {
	return err == contract.ErrNotFound
}
