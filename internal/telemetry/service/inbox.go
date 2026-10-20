// Package service commits inbox batches and client listing logs.
package service

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/telemetry/domain"
)

// Service is the telemetry use-case layer. A nil store fails closed.
type Service struct {
	store domain.InboxStore
}

// New binds the repository.
func New(store domain.InboxStore) Service { return Service{store: store} }

// Ingest writes accepted events in chunks of 20. Pre-validation rejects stay
// on the 200 response and are counted on the first audit row.
func (s Service) Ingest(ctx context.Context, in domain.Ingest) (domain.IngestResult, error) {
	if s.store == nil {
		return domain.IngestResult{}, domain.Unavailable()
	}
	limit, err := s.store.S3MonthlyLimit(ctx, in.OrgID)
	if err != nil {
		return domain.IngestResult{}, err
	}
	out := domain.IngestResult{
		Accepted: []string{},
		Rejected: append([]domain.RejectedEvent{}, in.Rejected...),
	}
	chunks := splitChunks(in.Events)
	if len(chunks) == 0 {
		chunks = [][]domain.AcceptedEvent{nil}
	}
	for i, events := range chunks {
		pre := 0
		if i == 0 {
			pre = len(in.Rejected)
		}
		got, err := s.store.CommitChunk(ctx, domain.Chunk{
			OrgID: in.OrgID, UserID: in.UserID, DeviceUID: in.DeviceUID,
			Events: events, PreRejected: pre, S3Limit: limit, Now: in.Now,
		})
		if err != nil {
			return domain.IngestResult{}, err
		}
		out.Accepted = append(out.Accepted, got.Accepted...)
		out.Rejected = append(out.Rejected, got.Rejected...)
	}
	return out, nil
}

// InsertClientLogs writes one batch. An empty batch does not open a transaction.
func (s Service) InsertClientLogs(ctx context.Context, orgID, userID int64, rows []domain.ClientLog) error {
	if len(rows) == 0 {
		return nil
	}
	if s.store == nil {
		return domain.LogsNotWritten()
	}
	return s.store.InsertClientLogs(ctx, orgID, userID, rows)
}

func splitChunks(events []domain.AcceptedEvent) [][]domain.AcceptedEvent {
	if len(events) == 0 {
		return nil
	}
	var out [][]domain.AcceptedEvent
	for len(events) > 0 {
		n := domain.EventInboxCommitChunk
		if n > len(events) {
			n = len(events)
		}
		out = append(out, events[:n])
		events = events[n:]
	}
	return out
}
