package adminrepo

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

const ledgerFrom = `
FROM ai_requests r
  JOIN organizations o ON o.id = r.org_id
  JOIN account_users u ON u.id = r.user_id`

const ledgerWhere = `
($1::text IS NULL OR o.name ILIKE '%' || $1 || '%'
       OR u.email ILIKE '%' || $1 || '%'
       OR r.model ILIKE '%' || $1 || '%'
       OR r.public_id ILIKE '%' || $1 || '%')
  AND ($2::text IS NULL OR r.status = $2)
  AND ($3::text IS NULL OR r.api_format = $3)
  AND ($4::text IS NULL OR r.operation = $4)
  AND ($5::text IS NULL OR r.created_at >= $5::timestamptz)
  AND r.created_at >= $6::timestamptz`

func filterArgs(f domain.UsageFilter) []any {
	var q, status, format, operation, since any
	if f.Q != "" {
		q = f.Q
	}
	if f.Status != "" {
		status = f.Status
	}
	if f.APIFormat != "" {
		format = f.APIFormat
	}
	if f.Operation != "" {
		operation = f.Operation
	}
	if f.SinceText != "" {
		since = f.SinceText
	}
	return []any{q, status, format, operation, since, f.Retained}
}

// ListUsage counts and pages the ledger. It does not audit.
func (s *Store) ListUsage(ctx context.Context, f domain.UsageFilter, limit, offset int64) (int64, []domain.UsageRow, *contract.Fault) {
	args := filterArgs(f)
	var total int64
	if err := s.pool.QueryRow(ctx, `SELECT count(*)::bigint AS rows `+ledgerFrom+` WHERE `+ledgerWhere, args...).Scan(&total); err != nil {
		return 0, nil, dbFault(err)
	}
	args = append(args, limit, offset)
	rows, err := s.pool.Query(ctx, `
SELECT r.public_id, r.model, r.operation, r.status, r.thinking_depth, r.channel_name,
       r.api_format,
       r.prompt_tokens, r.cached_prompt_tokens, r.completion_tokens,
       r.reasoning_completion_tokens, r.total_microfen,
       r.charged_microfen, r.absorbed_microfen, r.error_class,
       CASE WHEN r.status = 'failed' THEN jsonb_pretty(r.response_body) ELSE NULL END,
       r.created_at,
       CASE WHEN r.settled_at IS NULL THEN NULL
            ELSE greatest(0, round(extract(epoch FROM (r.settled_at - r.created_at)) * 1000)::bigint)
       END,
       CASE WHEN r.status = 'settled'
              AND r.completion_tokens > 0
              AND r.dispatched_at IS NOT NULL
              AND r.settled_at > r.dispatched_at
        THEN round(r.completion_tokens::numeric * 1000 / extract(epoch FROM (r.settled_at - r.dispatched_at)))::bigint
        ELSE NULL END,
       o.name, u.email
`+ledgerFrom+` WHERE `+ledgerWhere+`
ORDER BY r.created_at DESC, r.id DESC
LIMIT $7 OFFSET $8`, args...)
	if err != nil {
		return 0, nil, dbFault(err)
	}
	defer rows.Close()
	var out []domain.UsageRow
	for rows.Next() {
		var row domain.UsageRow
		if err := rows.Scan(&row.RequestID, &row.Model, &row.Operation, &row.Status, &row.Thinking, &row.Channel,
			&row.APIFormat, &row.Input, &row.Cached, &row.Output, &row.Reasoning, &row.Total, &row.Charged, &row.Absorbed,
			&row.ErrorClass, &row.Upstream, &row.CreatedAt, &row.Latency, &row.Speed, &row.Workspace, &row.Email); err != nil {
			return 0, nil, dbFault(err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return 0, nil, dbFault(err)
	}
	if out == nil {
		out = []domain.UsageRow{}
	}
	return total, out, nil
}

// SummarizeUsage aggregates the same filter. It does not audit.
func (s *Store) SummarizeUsage(ctx context.Context, f domain.UsageFilter) (domain.UsageSummary, *contract.Fault) {
	args := filterArgs(f)
	var sum domain.UsageSummary
	err := s.pool.QueryRow(ctx, `
SELECT
    count(*) FILTER (WHERE r.status = 'settled'),
    count(*) FILTER (WHERE r.status = 'failed'),
    count(*) FILTER (WHERE r.status = 'unbilled_unknown'),
    count(*) FILTER (WHERE r.status IN ('held', 'dispatching')),
    count(*),
    (coalesce(sum(r.prompt_tokens) FILTER (WHERE r.status = 'settled'), 0))::bigint,
    (coalesce(sum(r.cached_prompt_tokens) FILTER (WHERE r.status = 'settled'), 0))::bigint,
    (coalesce(sum(r.completion_tokens) FILTER (WHERE r.status = 'settled'), 0))::bigint,
    (coalesce(sum(r.charged_microfen), 0))::bigint,
    (coalesce(sum(r.absorbed_microfen), 0))::bigint,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (r.settled_at - r.created_at)) * 1000))::bigint,
    round(percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM (r.settled_at - r.created_at)) * 1000))::bigint,
    round(percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM (r.settled_at - r.created_at)) * 1000))::bigint,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (r.settled_at - r.dispatched_at)) * 1000)
          FILTER (WHERE r.dispatched_at IS NOT NULL AND r.settled_at > r.dispatched_at))::bigint,
    round(percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM (r.settled_at - r.dispatched_at)) * 1000)
          FILTER (WHERE r.dispatched_at IS NOT NULL AND r.settled_at > r.dispatched_at))::bigint,
    round(percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM (r.settled_at - r.dispatched_at)) * 1000)
          FILTER (WHERE r.dispatched_at IS NOT NULL AND r.settled_at > r.dispatched_at))::bigint,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY r.completion_tokens::numeric * 1000
          / NULLIF(extract(epoch FROM (r.settled_at - r.dispatched_at)), 0))
          FILTER (WHERE r.status = 'settled' AND r.completion_tokens > 0
                  AND r.dispatched_at IS NOT NULL AND r.settled_at > r.dispatched_at))::bigint
`+ledgerFrom+` WHERE `+ledgerWhere, args...).Scan(
		&sum.Settled, &sum.Failed, &sum.Unknown, &sum.InFlight, &sum.Total,
		&sum.Input, &sum.Cached, &sum.Output, &sum.Charged, &sum.Absorbed,
		&sum.P50, &sum.P90, &sum.P99, &sum.UP50, &sum.UP90, &sum.UP99, &sum.Speed)
	if err != nil {
		return domain.UsageSummary{}, dbFault(err)
	}
	classRows, err := s.pool.Query(ctx, `
SELECT r.error_class, count(*)
`+ledgerFrom+` WHERE `+ledgerWhere+`
  AND r.error_class IS NOT NULL
GROUP BY r.error_class
ORDER BY count(*) DESC, r.error_class`, args...)
	if err != nil {
		return domain.UsageSummary{}, dbFault(err)
	}
	defer classRows.Close()
	for classRows.Next() {
		var c domain.UsageClass
		if err := classRows.Scan(&c.ErrorClass, &c.Count); err != nil {
			return domain.UsageSummary{}, dbFault(err)
		}
		sum.Classes = append(sum.Classes, c)
	}
	if sum.Classes == nil {
		sum.Classes = []domain.UsageClass{}
	}
	return sum, nil
}
