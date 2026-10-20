package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	platform "github.com/xxww0098/podhub-go/internal/listing/rules"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func (s *Server) now() time.Time {
	if s != nil && s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Server) principal(r *http.Request) (access.Principal, *access.Refusal, error) {
	if s == nil || s.Access == nil {
		return access.Principal{}, loggedOut(), nil
	}
	p, refusal, err := s.Access.Resolve(r)
	if err != nil {
		return access.Principal{}, nil, err
	}
	if refusal != nil {
		return access.Principal{}, refusal, nil
	}
	if p == nil {
		return access.Principal{}, loggedOut(), nil
	}
	return *p, nil, nil
}

func loggedOut() *access.Refusal {
	return &access.Refusal{
		Status:  http.StatusUnauthorized,
		Message: access.MsgUnauthenticated,
		Kind:    access.RefusalUnauthenticated,
	}
}

func (s *Server) BannedTagsEnabled(w http.ResponseWriter, r *http.Request) {
	if _, refusal, err := s.principal(r); err != nil {
		writeAdmin(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
		return
	} else if refusal != nil {
		writeAdmin(w, refusal.Status, refusal.Message, adminCode(refusal))
		return
	}
	rules, err := platform.EnabledBannedTags(r.Context(), func(ctx context.Context) ([]platform.Rule, error) {
		return s.loadEnabledRules(ctx)
	})
	if err != nil {
		slog.Error("banned tags", "err", err)
		writeAdmin(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
		return
	}
	body := bannedRulesResponse{Data: bannedRulesWire{Rules: make([]bannedRuleWire, 0, len(rules))}}
	for _, rule := range rules {
		body.Data.Rules = append(body.Data.Rules, bannedRuleWire{Term: rule.Term, MatchMode: rule.MatchMode})
	}
	writeJSON(w, http.StatusOK, body)
}

func (s *Server) loadEnabledRules(ctx context.Context) ([]platform.Rule, error) {
	var out []platform.Rule
	err := s.platformRead(ctx, func(q *sqlc.Queries) error {
		rows, err := q.ListEnabledBannedTagRules(ctx)
		if err != nil {
			return err
		}
		out = make([]platform.Rule, 0, len(rows))
		for _, row := range rows {
			if row.MatchMode != "exact" && row.MatchMode != "stem" {
				continue
			}
			out = append(out, platform.Rule{Term: row.Term, MatchMode: row.MatchMode})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Server) AdminBannedTagsList(w http.ResponseWriter, r *http.Request) {
	p, refusal, err := s.principal(r)
	if err != nil {
		writeAdmin(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
		return
	}
	if refusal != nil {
		writeAdmin(w, refusal.Status, refusal.Message, adminCode(refusal))
		return
	}
	if status, message, ok := access.SuperAdmin(p); !ok {
		writeAdmin(w, status, message, "FORBIDDEN")
		return
	}
	q, err := s.queries()
	if err != nil {
		writeAdmin(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
		return
	}
	rows, err := q.ListBannedTags(r.Context())
	if err != nil {
		slog.Error("admin banned tags", "err", err)
		writeAdmin(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
		return
	}
	body := bannedTagsResponse{Data: bannedTagsWire{Tags: make([]bannedTagWire, 0, len(rows))}}
	for _, row := range rows {
		body.Data.Tags = append(body.Data.Tags, bannedTagWire{
			ID: row.ID, Term: row.Term, MatchMode: row.MatchMode, Note: row.Note,
			CreatedBy: row.CreatedBy, CreatedAt: row.CreatedAt, Enabled: row.Enabled,
		})
	}
	writeJSON(w, http.StatusOK, body)
}

func adminCode(refusal *access.Refusal) string {
	if refusal.Status == http.StatusForbidden {
		return "FORBIDDEN"
	}
	return "AUTH_INVALID"
}

func writeAdmin(w http.ResponseWriter, status int, message, code string) {
	writeJSON(w, status, adminErrorBody{Error: message, Code: code})
}

func (s *Server) BillingUsageStats(w http.ResponseWriter, r *http.Request) {
	p, refusal, err := s.principal(r)
	if err != nil {
		writeTelemetry(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
		return
	}
	if refusal != nil {
		writeTelemetry(w, refusal.Status, refusal.Message, telemetryCode(refusal))
		return
	}
	if status, message, ok := access.OrgMember(p); !ok {
		writeTelemetry(w, status, message, "FORBIDDEN")
		return
	}
	q := r.URL.Query()
	now := s.now()
	from, to, days, summaryOnly, page, pageSize, qerr := parseUsageQuery(q, now)
	if qerr != nil {
		writeTelemetry(w, http.StatusBadRequest, qerr.Error(), "VALIDATION")
		return
	}
	// rollup=1 folds the old GET /api/billing/usage view into this ledger:
	// the organization and member metric totals for the end month of the
	// range. Manager or above only; below that it is 需要主管权限.
	rollup, err := parseRollup(queryPtr(q, "rollup"))
	if err != nil {
		writeTelemetry(w, http.StatusBadRequest, err.Error(), "VALIDATION")
		return
	}
	if rollup {
		if status, message, ok := access.OrgManager(p); !ok {
			writeTelemetry(w, status, message, "FORBIDDEN")
			return
		}
	}
	body, err := s.usageStats(r.Context(), p.OrgID, p.UserID, from, to, days, summaryOnly, page, pageSize, rollup, now)
	if err != nil {
		slog.Error("usage stats", "err", err)
		writeTelemetry(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
		return
	}
	writeJSON(w, http.StatusOK, body)
}

func parseRollup(raw *string) (bool, error) {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return false, nil
	}
	switch strings.TrimSpace(*raw) {
	case "1":
		return true, nil
	default:
		return false, positiveError("rollup 必须是 1")
	}
}

func aggregateUsage(rows []sqlc.ListBillingUsageRow, viewer int64) ([]usageMetricWire, []usageMetricWire) {
	orgTotals := map[string]int64{}
	memberTotals := map[string]int64{}
	for _, row := range rows {
		key := row.Metric + "|" + row.Unit + "|" + row.Verification
		orgTotals[key] += row.Total
		if row.UserID == viewer {
			memberTotals[key] += row.Total
		}
	}
	return metricView(orgTotals), metricView(memberTotals)
}

func metricView(totals map[string]int64) []usageMetricWire {
	keys := make([]string, 0, len(totals))
	for key := range totals {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]usageMetricWire, 0, len(keys))
	for _, key := range keys {
		metric, rest, _ := cut3(key)
		unit, verification, _ := cut3(rest)
		out = append(out, usageMetricWire{Metric: metric, Unit: unit, Verification: verification, Total: totals[key]})
	}
	return out
}

func cut3(key string) (head, tail string, ok bool) {
	for i := 0; i < len(key); i++ {
		if key[i] == '|' {
			return key[:i], key[i+1:], true
		}
	}
	return key, "", false
}

func parseUsageQuery(q map[string][]string, now time.Time) (from, to string, days int32, summaryOnly bool, page, pageSize uint32, err error) {
	values := url.Values(q)
	start, end, explicit, err := parseExplicitRange(queryPtr(values, "from"), queryPtr(values, "to"))
	if err != nil {
		return "", "", 0, false, 0, 0, err
	}
	if explicit {
		from = start.Format("2006-01-02")
		to = end.Format("2006-01-02")
		span := int(end.Sub(start).Hours()/24) + 1
		days = int32(span)
	} else {
		n, err := parseRangeDays(queryPtr(values, "days"))
		if err != nil {
			return "", "", 0, false, 0, 0, err
		}
		from, to = rangeDates(n, now)
		days = int32(n)
	}
	summaryOnly, err = parseSummary(queryPtr(values, "summary"))
	if err != nil {
		return "", "", 0, false, 0, 0, err
	}
	page, err = parsePage(queryPtr(values, "page"))
	if err != nil {
		return "", "", 0, false, 0, 0, err
	}
	pageSize, err = parsePageSize(queryPtr(values, "page_size"))
	if err != nil {
		return "", "", 0, false, 0, 0, err
	}
	return from, to, days, summaryOnly, page, pageSize, nil
}

func (s *Server) usageStats(ctx context.Context, orgID, viewer int64, from, to string, days int32, summaryOnly bool, page, pageSize uint32, rollup bool, now time.Time) (usageStatsResponse, error) {
	var summary sqlc.SummarizeAIUsageRow
	var requests []usageRequestWire
	var org, member []usageMetricWire
	resolved := uint32(1)
	err := s.tenantRead(ctx, orgID, func(q *sqlc.Queries) error {
		var qerr error
		summary, qerr = q.SummarizeAIUsage(ctx, sqlc.SummarizeAIUsageParams{
			OrgID: orgID, Column2: pgDate(from), Column3: pgDate(to),
		})
		if qerr != nil {
			return qerr
		}
		if !summaryOnly {
			requests, qerr = s.listUsage(ctx, q, orgID, from, to, page, pageSize)
			if qerr != nil {
				return qerr
			}
			resolved = clampPage(page, totalPages(summary.Requests, pageSize))
			if resolved != page {
				requests, qerr = s.listUsage(ctx, q, orgID, from, to, resolved, pageSize)
				if qerr != nil {
					return qerr
				}
			}
		}
		if rollup {
			rows, rerr := q.ListBillingUsage(ctx, sqlc.ListBillingUsageParams{
				OrgID: orgID, BillingPeriod: strings.TrimSpace(to)[:7],
			})
			if rerr != nil {
				return rerr
			}
			org, member = aggregateUsage(rows, viewer)
		}
		return nil
	})
	if err != nil {
		return usageStatsResponse{}, err
	}
	if requests == nil {
		requests = []usageRequestWire{}
	}
	shownPage := int32(1)
	shownSize := int32(0)
	if !summaryOnly {
		shownPage = i32sat(resolved)
		shownSize = i32sat(pageSize)
	}
	return usageStatsResponse{Data: usageStatsWire{
		Days:              days,
		From:              from,
		To:                to,
		TotalTokens:       satAdd(summary.InputTokens, summary.OutputTokens),
		InputTokens:       summary.InputTokens,
		OutputTokens:      summary.OutputTokens,
		CachedInputTokens: summary.CachedInputTokens,
		MessageCount:      summary.Requests,
		CacheHitRateBps:   cacheHitRateBps(summary.CachedInputTokens, summary.InputTokens),
		TotalMicrofen:     satAdd(summary.ChargedMicrofen, summary.AbsorbedMicrofen),
		ChargedMicrofen:   summary.ChargedMicrofen,
		AbsorbedMicrofen:  summary.AbsorbedMicrofen,
		Page:              shownPage,
		PageSize:          shownSize,
		TotalPages:        totalPages(summary.Requests, pageSize),
		Requests:          requests,
		Organization:      org,
		Member:            member,
		GeneratedAtMs:     now.UnixMilli(),
	}}, nil
}

func (s *Server) listUsage(ctx context.Context, q *sqlc.Queries, orgID int64, from, to string, page, pageSize uint32) ([]usageRequestWire, error) {
	rows, err := q.ListAIUsageRequests(ctx, sqlc.ListAIUsageRequestsParams{
		OrgID:   orgID,
		Column2: pgDate(from),
		Column3: pgDate(to),
		Column4: int64(pageSize),
		Column5: usageOffset(page, pageSize),
	})
	if err != nil {
		return nil, err
	}
	out := make([]usageRequestWire, 0, len(rows))
	for _, row := range rows {
		if !row.CreatedAt.Valid {
			return nil, errors.New("ai request created_at missing")
		}
		item := usageRequestWire{
			RequestID:             row.PublicID,
			Model:                 row.Model,
			Operation:             row.Operation,
			Status:                row.Status,
			InputTokens:           row.PromptTokens,
			OutputTokens:          row.CompletionTokens,
			CachedInputTokens:     row.CachedPromptTokens,
			ReasoningOutputTokens: row.ReasoningCompletionTokens,
			CacheHitRateBps:       cacheHitRateBps(row.CachedPromptTokens, row.PromptTokens),
			TotalMicrofen:         row.TotalMicrofen,
			ChargedMicrofen:       row.ChargedMicrofen,
			AbsorbedMicrofen:      row.AbsorbedMicrofen,
			ErrorClass:            textPtr(row.ErrorClass),
			CreatedAt:             rfc3339Millis(row.CreatedAt.Time),
		}
		if row.SettledAt.Valid {
			settled := rfc3339Millis(row.SettledAt.Time)
			item.SettledAt = &settled
		}
		out = append(out, item)
	}
	return out, nil
}

func pgDate(day string) pgtype.Date {
	t, err := time.Parse("2006-01-02", day)
	if err != nil {
		return pgtype.Date{}
	}
	return pgtype.Date{Time: t, Valid: true}
}

func textPtr(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	s := value.String
	return &s
}

func telemetryCode(refusal *access.Refusal) string {
	switch refusal.Status {
	case http.StatusUnauthorized:
		return "AUTH_REQUIRED"
	case http.StatusForbidden:
		return "FORBIDDEN"
	default:
		return "INTERNAL"
	}
}

func writeTelemetry(w http.ResponseWriter, status int, message, code string) {
	writeJSON(w, status, telemetryErrorBody{Error: message, Code: code})
}

func (s *Server) ListListingJobs(w http.ResponseWriter, r *http.Request) {
	p, ok := s.listingActor(w, r)
	if !ok {
		return
	}
	values := r.URL.Query()
	page, err := parseLimit(queryPtr(values, "limit"))
	if err != nil {
		writeListing(w, http.StatusBadRequest, err.Error(), "validation")
		return
	}
	_, fetch := runPageBounds(page)
	card, err := cardFilter(queryPtr(values, "cardId"))
	if err != nil {
		writeListing(w, http.StatusBadRequest, "cardId 无效", "validation")
		return
	}
	micros, afterID := parseCursor(queryPtr(values, "cursor"))
	var jobs []jobSource
	err = s.tenantRead(r.Context(), p.OrgID, func(q *sqlc.Queries) error {
		var qerr error
		jobs, qerr = listJobSources(r.Context(), q, p.OrgID, fetch, micros, afterID, card)
		return qerr
	})
	if err != nil {
		slog.Error("listing runs", "err", err)
		writeListing(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	body, err := pageRuns(jobs, page)
	if err != nil {
		slog.Error("listing runs view", "err", err)
		writeListing(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	writeJSON(w, http.StatusOK, body)
}

func (s *Server) GetListingRun(w http.ResponseWriter, r *http.Request, id string) {
	p, ok := s.listingActor(w, r)
	if !ok {
		return
	}
	canonical, valid := canonicalUUID(id)
	if !valid {
		writeListing(w, http.StatusBadRequest, "作业编号无效", "validation")
		return
	}
	var uid pgtype.UUID
	if err := uid.Scan(canonical); err != nil {
		writeListing(w, http.StatusBadRequest, "作业编号无效", "validation")
		return
	}
	var row sqlc.GetJobRow
	err := s.tenantRead(r.Context(), p.OrgID, func(q *sqlc.Queries) error {
		var qerr error
		row, qerr = q.GetJob(r.Context(), sqlc.GetJobParams{OrgID: p.OrgID, Column2: uid})
		return qerr
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeListing(w, http.StatusNotFound, "准备作业不存在", "not_found")
		return
	}
	if err != nil {
		slog.Error("listing job", "err", err)
		writeListing(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	view, err := runView(sourceFromGet(row))
	if err != nil {
		slog.Error("listing job view", "err", err)
		writeListing(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	writeJSON(w, http.StatusOK, listingRunResponse{Data: view})
}

func (s *Server) listingActor(w http.ResponseWriter, r *http.Request) (access.Principal, bool) {
	p, refusal, err := s.principal(r)
	if err != nil {
		writeListing(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return access.Principal{}, false
	}
	if refusal != nil {
		writeListing(w, refusal.Status, refusal.Message, listingCode(refusal))
		return access.Principal{}, false
	}
	if status, message, ok := access.ListingPrepare(p); !ok {
		writeListing(w, status, message, "forbidden")
		return access.Principal{}, false
	}
	return p, true
}

func listingCode(refusal *access.Refusal) string {
	switch refusal.Status {
	case http.StatusUnauthorized:
		return "auth_invalid"
	case http.StatusForbidden:
		return "forbidden"
	default:
		return "internal"
	}
}

func writeListing(w http.ResponseWriter, status int, message, code string) {
	writeJSON(w, status, listingErrorBody{Error: message, Code: code})
}

func cardFilter(raw *string) (string, error) {
	if raw == nil {
		return "", nil
	}
	trimmed := strings.TrimSpace(*raw)
	if trimmed == "" {
		return "", nil
	}
	id, ok := canonicalUUID(trimmed)
	if !ok {
		return "", positiveError("cardId 无效")
	}
	return id, nil
}

type jobSource struct {
	ID             string
	Kind           string
	AggregateType  string
	AggregateID    string
	InputRevision  int64
	State          string
	Attempt        int32
	LastError      pgtype.Text
	IdempotencyKey string
	Payload        []byte
	Updated        pgtype.Timestamptz
}

func sourceFromGet(row sqlc.GetJobRow) jobSource {
	return jobSource{
		ID: row.ID, Kind: row.Kind, AggregateType: row.AggregateType, AggregateID: row.AggregateID,
		InputRevision: row.InputRevision, State: row.State, Attempt: row.Attempt, LastError: row.LastErrorCode,
		IdempotencyKey: row.IdempotencyKey, Payload: row.Payload, Updated: row.UpdatedAt,
	}
}

func listJobSources(ctx context.Context, q *sqlc.Queries, orgID, fetch, micros int64, afterID, card string) ([]jobSource, error) {
	var uid pgtype.UUID
	if afterID != "" {
		if err := uid.Scan(afterID); err != nil {
			return nil, err
		}
	}
	var cardID pgtype.UUID
	if card != "" {
		if err := cardID.Scan(card); err != nil {
			return nil, err
		}
	}
	switch {
	case card == "" && micros == 0:
		rows, err := q.ListJobs(ctx, sqlc.ListJobsParams{OrgID: orgID, Column2: fetch})
		return mapList(rows, err)
	case card == "":
		rows, err := q.ListJobsAfter(ctx, sqlc.ListJobsAfterParams{OrgID: orgID, Column2: micros, Column3: uid, Column4: fetch})
		return mapAfter(rows, err)
	case micros == 0:
		rows, err := q.ListJobsForCard(ctx, sqlc.ListJobsForCardParams{OrgID: orgID, Column2: fetch, Column3: cardID})
		return mapCard(rows, err)
	default:
		rows, err := q.ListJobsForCardAfter(ctx, sqlc.ListJobsForCardAfterParams{
			OrgID: orgID, Column2: micros, Column3: uid, Column4: fetch, Column5: cardID,
		})
		return mapCardAfter(rows, err)
	}
}

func mapList(rows []sqlc.ListJobsRow, err error) ([]jobSource, error) {
	if err != nil {
		return nil, err
	}
	out := make([]jobSource, 0, len(rows))
	for _, row := range rows {
		out = append(out, jobSource{
			ID: row.ID, Kind: row.Kind, AggregateType: row.AggregateType, AggregateID: row.AggregateID,
			InputRevision: row.InputRevision, State: row.State, Attempt: row.Attempt, LastError: row.LastErrorCode,
			IdempotencyKey: row.IdempotencyKey, Payload: row.Payload, Updated: row.UpdatedAt,
		})
	}
	return out, nil
}

func mapAfter(rows []sqlc.ListJobsAfterRow, err error) ([]jobSource, error) {
	if err != nil {
		return nil, err
	}
	out := make([]jobSource, 0, len(rows))
	for _, row := range rows {
		out = append(out, jobSource{
			ID: row.ID, Kind: row.Kind, AggregateType: row.AggregateType, AggregateID: row.AggregateID,
			InputRevision: row.InputRevision, State: row.State, Attempt: row.Attempt, LastError: row.LastErrorCode,
			IdempotencyKey: row.IdempotencyKey, Payload: row.Payload, Updated: row.UpdatedAt,
		})
	}
	return out, nil
}

func mapCard(rows []sqlc.ListJobsForCardRow, err error) ([]jobSource, error) {
	if err != nil {
		return nil, err
	}
	out := make([]jobSource, 0, len(rows))
	for _, row := range rows {
		out = append(out, jobSource{
			ID: row.ID, Kind: row.Kind, AggregateType: row.AggregateType, AggregateID: row.AggregateID,
			InputRevision: row.InputRevision, State: row.State, Attempt: row.Attempt, LastError: row.LastErrorCode,
			IdempotencyKey: row.IdempotencyKey, Payload: row.Payload, Updated: row.UpdatedAt,
		})
	}
	return out, nil
}

func mapCardAfter(rows []sqlc.ListJobsForCardAfterRow, err error) ([]jobSource, error) {
	if err != nil {
		return nil, err
	}
	out := make([]jobSource, 0, len(rows))
	for _, row := range rows {
		out = append(out, jobSource{
			ID: row.ID, Kind: row.Kind, AggregateType: row.AggregateType, AggregateID: row.AggregateID,
			InputRevision: row.InputRevision, State: row.State, Attempt: row.Attempt, LastError: row.LastErrorCode,
			IdempotencyKey: row.IdempotencyKey, Payload: row.Payload, Updated: row.UpdatedAt,
		})
	}
	return out, nil
}

func runView(row jobSource) (listingRunWire, error) {
	if !row.Updated.Valid {
		return listingRunWire{}, errors.New("job updated_at missing")
	}
	payload, err := canonicalJSON(row.Payload)
	if err != nil {
		return listingRunWire{}, err
	}
	return listingRunWire{
		ID: row.ID, Kind: row.Kind, AggregateType: row.AggregateType, AggregateID: row.AggregateID,
		InputRevision: row.InputRevision, State: row.State, Attempt: row.Attempt,
		LastErrorCode: textPtr(row.LastError), IdempotencyKey: row.IdempotencyKey,
		Payload: payload, UpdatedAtMs: row.Updated.Time.UnixMilli(),
	}, nil
}

func pageRuns(rows []jobSource, page int64) (listingRunsResponse, error) {
	var next *string
	if int64(len(rows)) > page {
		rows = rows[:page]
		if len(rows) > 0 {
			last := rows[len(rows)-1]
			if !last.Updated.Valid {
				return listingRunsResponse{}, errors.New("job updated_at missing")
			}
			cursor := formatCursor(last.Updated.Time, last.ID)
			next = &cursor
		}
	}
	items := make([]listingRunWire, 0, len(rows))
	for _, row := range rows {
		view, err := runView(row)
		if err != nil {
			return listingRunsResponse{}, err
		}
		items = append(items, view)
	}
	return listingRunsResponse{Data: listingRunsWire{Items: items, NextCursor: next}}, nil
}

func formatCursor(t time.Time, id string) string {
	return itoa(t.UnixMicro()) + ":" + id
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func (s *Server) queries() (*sqlc.Queries, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("database unavailable")
	}
	return sqlc.New(s.Pool), nil
}

// platformRead runs fn in a read-only transaction that has entered the app
// role but set no org. Only for platform tables with no org_id and no tenant
// RLS (banned_tags, platform_catalog_fetch_config). A tenant table needs
// tenantRead: without app.current_org_id, tenant_isolation matches no row.
func (s *Server) platformRead(ctx context.Context, fn func(*sqlc.Queries) error) error {
	if s == nil || s.Pool == nil {
		return errors.New("database unavailable")
	}
	return db.InTx(ctx, s.Pool, db.AppRole(), func(tx pgx.Tx) error {
		return fn(sqlc.New(tx))
	})
}

func (s *Server) tenantRead(ctx context.Context, orgID int64, fn func(*sqlc.Queries) error) error {
	if s == nil || s.Pool == nil {
		return errors.New("database unavailable")
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tenant.EnterApp(ctx, tx, orgID); err != nil {
		return err
	}
	if err := fn(sqlc.New(tx)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
