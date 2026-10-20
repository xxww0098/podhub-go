package slicepurge

import (
	"context"
	"testing"
	"time"
)

type memStore struct {
	remaining  time.Duration
	calls      int32
	lastResult int32
	deleted    uint64
	failed     uint64
	status     string
}

func (m *memStore) Reserve(context.Context) (Reservation, bool, error) {
	if m.calls >= 10000 || m.status == "completed" {
		return Reservation{}, false, nil
	}
	m.calls++
	return Reservation{CallNo: m.calls, Remaining: m.remaining}, true, nil
}

func (m *memStore) Record(_ context.Context, reservation Reservation, deleted, failed uint32) (bool, error) {
	if reservation.CallNo != m.calls || reservation.CallNo <= m.lastResult {
		return false, nil
	}
	m.lastResult = reservation.CallNo
	m.deleted += uint64(deleted)
	m.failed += uint64(failed)
	return true, nil
}

func (m *memStore) Finish(context.Context) (bool, error) {
	if m.calls == 0 || m.lastResult != m.calls {
		return false, nil
	}
	m.status = "completed"
	return true, nil
}

func (m *memStore) RetryLater(context.Context, string) (bool, error) {
	m.status = "partial"
	return true, nil
}

type scripted struct {
	lists   [][]string
	listErr []*CallError
	deleted []string
	fail    map[string]bool
}

func (s *scripted) List(context.Context) ([]string, error) {
	if len(s.listErr) > 0 {
		err := s.listErr[0]
		s.listErr = s.listErr[1:]
		if err != nil {
			return nil, err
		}
	}
	if len(s.lists) == 0 {
		return nil, nil
	}
	keys := s.lists[0]
	s.lists = s.lists[1:]
	return keys, nil
}

func (s *scripted) Delete(_ context.Context, keys []string) (DeleteResult, error) {
	var failed []string
	var codes []string
	for _, key := range keys {
		if s.fail[key] {
			failed = append(failed, key)
			codes = append(codes, "s3_delete_rejected")
			delete(s.fail, key)
			continue
		}
		s.deleted = append(s.deleted, key)
	}
	return DeleteResult{Deleted: len(keys) - len(failed), FailedKeys: failed, FailedCodes: codes, Retryable: len(failed) > 0}, nil
}

func TestRunnerEmptiesAndCounts(t *testing.T) {
	store := &memStore{remaining: time.Hour}
	origin := &scripted{lists: [][]string{{"a", "b"}, nil}}
	report := Run(context.Background(), store, origin, func(time.Duration) {})
	if !report.Completed || report.StopCode != "empty_observed" || report.DeletedAck != 2 || store.deleted != 2 {
		t.Fatalf("report %+v store %+v origin %v", report, store, origin.deleted)
	}
	if store.status != "completed" || report.APICalls != 3 {
		t.Fatalf("calls %d status %s", report.APICalls, store.status)
	}
}

func TestRunnerRetriesListThenStopsOnBadPage(t *testing.T) {
	store := &memStore{remaining: time.Hour}
	origin := &scripted{listErr: []*CallError{{Code: "s3_network", Retryable: true}}, lists: [][]string{{"a", "a"}}}
	report := Run(context.Background(), store, origin, func(time.Duration) {})
	if report.Completed || report.StopCode != "slice_list_invalid" || len(origin.deleted) != 0 {
		t.Fatalf("%+v deleted %v", report, origin.deleted)
	}
}

func TestRunnerRetriesFailedKeysOnly(t *testing.T) {
	store := &memStore{remaining: time.Hour}
	origin := &scripted{lists: [][]string{{"a", "b"}, nil}, fail: map[string]bool{"b": true}}
	report := Run(context.Background(), store, origin, func(time.Duration) {})
	if !report.Completed || report.DeletedAck != 2 {
		t.Fatalf("%+v", report)
	}
	if len(origin.deleted) != 2 || origin.deleted[0] != "a" || origin.deleted[1] != "b" {
		t.Fatal(origin.deleted)
	}
}
