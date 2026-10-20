package ozonerrsvc

import (
	"bytes"
	"context"
	"encoding/json"

	"github.com/xxww0098/podhub-go/internal/ozonerr/contract"
	"github.com/xxww0098/podhub-go/internal/ozonerr/domain"
)

// Service records and lists Ozon error observations.
type Service struct {
	store Store
}

// New binds the store. A nil store fails closed on every call.
func New(store Store) *Service {
	return &Service{store: store}
}

// RecordRows stores import-info errors. The count is how many sightings
// were new. A repeated task and offer returns 0.
func (s *Service) RecordRows(ctx context.Context, orgID int64, rows []domain.Row) (int, error) {
	if s == nil || s.store == nil || orgID <= 0 {
		return 0, contract.ErrBadBody
	}
	clean := make([]domain.Row, 0, len(rows))
	for _, row := range rows {
		if row.Source != domain.SourceImportInfo && row.Source != domain.SourceRequest {
			continue
		}
		if row.Code == "" || domain.SecretCode(row.Code) || len([]rune(row.Code)) > domain.MaxCode {
			continue
		}
		if row.TaskKey == "" || len(row.TaskKey) > domain.MaxTaskKey {
			continue
		}
		row.Sample = domain.Redact(row.Sample)
		row.Field = domain.Redact(row.Field)
		row.AttributeName = domain.Redact(row.AttributeName)
		row.Level = domain.Redact(row.Level)
		row.State = domain.Redact(row.State)
		clean = append(clean, row)
	}
	if len(clean) == 0 {
		return 0, nil
	}
	return s.store.Insert(ctx, orgID, clean)
}

// RecordRequest stores grpc code and message for one browser 4xx report.
// The offer id is read from the intent row when the report has no task id.
// A task id is the shared key with a proxied 4xx, and the offer is then not
// part of that key. The request body is not stored.
func (s *Service) RecordRequest(ctx context.Context, orgID int64, in domain.RequestError) error {
	if s == nil || s.store == nil || orgID <= 0 {
		return nil
	}
	code, ok := domain.ResolveGRPC(in.HTTPStatus, in.GatewayCode)
	if !ok || in.IntentID == "" {
		return nil
	}
	return s.store.InsertRequest(ctx, orgID, in.IntentID, code, domain.Redact(in.Message), domain.SharedTaskKey(in.TaskKey))
}

// ObserveUpstream records an import/info exchange the proxy already finished.
// A missing task id records nothing. The request body is not stored.
func (s *Service) ObserveUpstream(ctx context.Context, orgID int64, status int, requestBody, responseBody []byte) error {
	if s == nil || s.store == nil || orgID <= 0 {
		return nil
	}
	taskID, ok := domain.TaskID(requestBody)
	if !ok {
		return nil
	}
	if status >= 200 && status < 300 {
		_, err := s.RecordRows(ctx, orgID, domain.ParseUpstreamItems(taskID, responseBody))
		return err
	}
	if status >= 400 && status < 500 {
		row, ok := domain.GatewayRow(taskID, status, responseBody)
		if !ok {
			return nil
		}
		_, err := s.RecordRows(ctx, orgID, []domain.Row{row})
		return err
	}
	return nil
}

// List is the super-admin global catalog.
func (s *Service) List(ctx context.Context, userID int64, rawQuery string) ([]byte, error) {
	if s == nil || s.store == nil || userID <= 0 {
		return nil, contract.ErrBadQuery
	}
	q, err := domain.ParseQuery(rawQuery)
	if err != nil {
		return nil, err
	}
	rows, err := s.store.ListGlobal(ctx, userID, q)
	if err != nil {
		return nil, err
	}
	return encodePage(q.Sort, q.Limit, rows)
}

// ListOrg is one organization's own counts.
func (s *Service) ListOrg(ctx context.Context, orgID int64, rawQuery string) ([]byte, error) {
	if s == nil || s.store == nil || orgID <= 0 {
		return nil, contract.ErrBadQuery
	}
	q, err := domain.ParseQuery(rawQuery)
	if err != nil {
		return nil, err
	}
	rows, err := s.store.ListOrg(ctx, orgID, q)
	if err != nil {
		return nil, err
	}
	return encodePage(q.Sort, q.Limit, rows)
}

func encodePage(sort string, limit int, rows []domain.Entry) ([]byte, error) {
	next := ""
	if len(rows) > limit {
		rows = rows[:limit]
		next = domain.EncodeCursor(sort, rows[len(rows)-1])
	}
	if rows == nil {
		rows = []domain.Entry{}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	payload := struct {
		Data struct {
			Items      []entryWire `json:"items"`
			NextCursor string      `json:"next_cursor"`
		} `json:"data"`
	}{}
	payload.Data.Items = make([]entryWire, 0, len(rows))
	for _, row := range rows {
		payload.Data.Items = append(payload.Data.Items, entryWire{
			Source: row.Source, Code: row.Code, AttributeID: row.AttributeID,
			DescriptionCategoryID: row.DescriptionCategoryID, TypeID: row.TypeID,
			Level: row.Level, State: row.State, Field: row.Field, AttributeName: row.AttributeName,
			SampleDescription: row.Sample, Occurrences: row.Occurrences,
			FirstSeenAt: row.FirstSeen, LastSeenAt: row.LastSeen,
		})
	}
	payload.Data.NextCursor = next
	if err := enc.Encode(payload); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

type entryWire struct {
	Source                string `json:"source"`
	Code                  string `json:"code"`
	AttributeID           int64  `json:"attribute_id"`
	DescriptionCategoryID int64  `json:"description_category_id"`
	TypeID                int64  `json:"type_id"`
	Level                 string `json:"level"`
	State                 string `json:"state"`
	Field                 string `json:"field"`
	AttributeName         string `json:"attribute_name"`
	SampleDescription     string `json:"sample_description"`
	Occurrences           int64  `json:"occurrences"`
	FirstSeenAt           string `json:"first_seen_at"`
	LastSeenAt            string `json:"last_seen_at"`
}
