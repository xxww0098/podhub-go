package service

import (
	"context"
	"strings"
	"time"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	billing "github.com/xxww0098/podhub-go/internal/billing/contract"
)

func (a *API) ListGrants(ctx context.Context, actor domain.Actor, orgID *int64) (any, *contract.Fault) {
	rows, fault := a.DB.ListGrants(ctx, actor, orgID)
	if fault != nil {
		return nil, fault
	}
	now := a.now().UnixMilli()
	views := make([]grantView, 0, len(rows))
	for _, g := range rows {
		views = append(views, grantView{
			ID: g.ID, OrgID: g.OrgID, StaffUserID: g.StaffUserID, StaffEmail: g.StaffEmail,
			Reason: g.Reason, ExpiresAt: g.ExpiresAt, RevokedAt: g.RevokedAt, CreatedBy: g.CreatedBy,
			CreatedAt: g.CreatedAt, LastAccess: g.LastAccess, Live: g.RevokedAt == 0 && g.ExpiresAt > now,
		})
	}
	return struct {
		Data struct {
			Grants []grantView `json:"grants"`
			Count  int         `json:"count"`
		} `json:"data"`
	}{Data: struct {
		Grants []grantView `json:"grants"`
		Count  int         `json:"count"`
	}{views, len(views)}}, nil
}

type grantView struct {
	ID          int64  `json:"id"`
	OrgID       int64  `json:"org_id"`
	StaffUserID int64  `json:"staff_user_id"`
	StaffEmail  string `json:"staff_email"`
	Reason      string `json:"reason"`
	ExpiresAt   int64  `json:"expires_at_ms"`
	RevokedAt   int64  `json:"revoked_at_ms"`
	CreatedBy   int64  `json:"created_by_user_id"`
	CreatedAt   int64  `json:"created_at_ms"`
	LastAccess  int64  `json:"last_access_at_ms"`
	Live        bool   `json:"live"`
}

func (a *API) IssueGrant(ctx context.Context, actor domain.Actor, orgID, staff int64, reason string, ttl *int64) (any, *contract.Fault) {
	req, msg := domain.ValidateGrant(orgID, staff, reason, ttl, actor.ID)
	if msg != "" {
		return nil, contract.Validation(msg)
	}
	expires := a.now().Add(time.Duration(req.TTLMinutes) * time.Minute)
	g, fault := a.DB.IssueGrant(ctx, actor, req, expires)
	if fault != nil {
		return nil, fault
	}
	view := grantView{
		ID: g.ID, OrgID: g.OrgID, StaffUserID: g.StaffUserID, StaffEmail: g.StaffEmail,
		Reason: g.Reason, ExpiresAt: g.ExpiresAt, RevokedAt: 0, CreatedBy: g.CreatedBy,
		CreatedAt: g.CreatedAt, Live: true,
	}
	return struct {
		Data struct {
			OK    bool      `json:"ok"`
			Grant grantView `json:"grant"`
		} `json:"data"`
	}{Data: struct {
		OK    bool      `json:"ok"`
		Grant grantView `json:"grant"`
	}{true, view}}, nil
}

func (a *API) RevokeGrant(ctx context.Context, actor domain.Actor, id int64) (any, *contract.Fault) {
	if id <= 0 {
		return nil, contract.Validation("无效授权 ID")
	}
	revoked, fault := a.DB.RevokeGrant(ctx, actor, id, "/api/admin/support-grants/"+itoa(id)+"/revoke")
	if fault != nil {
		return nil, fault
	}
	return struct {
		Data struct {
			OK      bool `json:"ok"`
			Revoked bool `json:"revoked"`
		} `json:"data"`
	}{Data: struct {
		OK      bool `json:"ok"`
		Revoked bool `json:"revoked"`
	}{true, revoked}}, nil
}

func (a *API) LeaseStatus(ctx context.Context, actor domain.Actor) (any, *contract.Fault) {
	rows, ever, fault := a.DB.LeaseStatus(ctx, actor)
	if fault != nil {
		return nil, fault
	}
	type view struct {
		ID             int64  `json:"id"`
		Domain         string `json:"domain"`
		Holder         string `json:"holder"`
		HolderInstance string `json:"holderInstance"`
		Fence          int64  `json:"fenceToken"`
		GrantedAt      int64  `json:"grantedAtMs"`
		ExpiresAt      int64  `json:"expiresAtMs"`
		HeartbeatAt    int64  `json:"heartbeatAtMs"`
		RevokedAt      *int64 `json:"revokedAtMs,omitempty"`
		Reason         string `json:"grantReason"`
	}
	type item struct {
		Domain string `json:"domain"`
		Ever   bool   `json:"everLeased"`
		Active *view  `json:"active,omitempty"`
	}
	out := make([]item, 0, len(domain.LeaseDomains))
	for i, name := range domain.LeaseDomains {
		entry := item{Domain: name, Ever: i < len(ever) && ever[i]}
		if i < len(rows) && rows[i].ID != 0 {
			row := rows[i]
			entry.Active = &view{
				ID: row.ID, Domain: row.Domain, Holder: row.Holder, HolderInstance: row.HolderInstance,
				Fence: row.Fence, GrantedAt: row.GrantedAt, ExpiresAt: row.ExpiresAt, HeartbeatAt: row.HeartbeatAt,
				RevokedAt: row.RevokedAt, Reason: row.Reason,
			}
		}
		out = append(out, entry)
	}
	return struct {
		Data struct {
			Domains []item `json:"domains"`
		} `json:"data"`
	}{Data: struct {
		Domains []item `json:"domains"`
	}{out}}, nil
}

func (a *API) GrantLease(ctx context.Context, actor domain.Actor, name, holder, instance, reason string, expected *int64) (any, *contract.Fault) {
	parsed, ok := domain.ParseLeaseDomain(strings.TrimSpace(name))
	if !ok {
		return nil, contract.Validation("domain 无效")
	}
	holder = strings.TrimSpace(holder)
	instance = strings.TrimSpace(instance)
	if strings.TrimSpace(reason) == "" {
		return nil, contract.Validation("grant reason is required")
	}
	if holder != domain.HolderAxum && holder != domain.HolderHono {
		return nil, contract.Validation("holder must be axum or hono")
	}
	if instance == "" {
		return nil, contract.Validation("holder_instance is required")
	}
	row, fault := a.DB.GrantLease(ctx, actor, parsed, holder, instance, reason, expected)
	if fault != nil {
		return nil, fault
	}
	return leaseGrantBody(row, domain.AuthorityReleased(holder)), nil
}

func (a *API) RevokeLease(ctx context.Context, actor domain.Actor, name, reason string, expected *int64) (any, *contract.Fault) {
	parsed, ok := domain.ParseLeaseDomain(strings.TrimSpace(name))
	if !ok {
		return nil, contract.Validation("domain 无效")
	}
	if strings.TrimSpace(reason) == "" {
		return nil, contract.Validation("revoke reason is required")
	}
	row, fault := a.DB.RevokeLease(ctx, actor, parsed, reason, expected)
	if fault != nil {
		return nil, fault
	}
	type data struct {
		Lease *leaseView `json:"lease,omitempty"`
	}
	body := data{}
	if row != nil {
		view := leaseViewFrom(*row)
		body.Lease = &view
	}
	return struct {
		Data data `json:"data"`
	}{body}, nil
}

type leaseView struct {
	ID             int64  `json:"id"`
	Domain         string `json:"domain"`
	Holder         string `json:"holder"`
	HolderInstance string `json:"holderInstance"`
	Fence          int64  `json:"fenceToken"`
	GrantedAt      int64  `json:"grantedAtMs"`
	ExpiresAt      int64  `json:"expiresAtMs"`
	HeartbeatAt    int64  `json:"heartbeatAtMs"`
	RevokedAt      *int64 `json:"revokedAtMs,omitempty"`
	Reason         string `json:"grantReason"`
}

func leaseViewFrom(row domain.LeaseRow) leaseView {
	return leaseView{
		ID: row.ID, Domain: row.Domain, Holder: row.Holder, HolderInstance: row.HolderInstance,
		Fence: row.Fence, GrantedAt: row.GrantedAt, ExpiresAt: row.ExpiresAt, HeartbeatAt: row.HeartbeatAt,
		RevokedAt: row.RevokedAt, Reason: row.Reason,
	}
}

func leaseGrantBody(row domain.LeaseRow, released bool) any {
	return struct {
		Data struct {
			Lease    leaseView `json:"lease"`
			Released bool      `json:"authorityReleased"`
		} `json:"data"`
	}{Data: struct {
		Lease    leaseView `json:"lease"`
		Released bool      `json:"authorityReleased"`
	}{leaseViewFrom(row), released}}
}

func (a *API) ListUsage(ctx context.Context, actor domain.Actor, q, status, format, operation, since, pageRaw, sizeRaw string) (any, *contract.Fault) {
	filter, msg := domain.ParseUsageFilter(q, status, format, operation, since, a.now())
	if msg != "" {
		return nil, contract.Validation(msg)
	}
	page, msg := domain.ParsePage(pageRaw, 1, 0, "", "page 必须是正整数")
	if msg != "" {
		return nil, contract.Validation(msg)
	}
	size, msg := domain.ParsePage(sizeRaw, 25, 100, "page_size 不能超过 100", "page_size 必须是正整数")
	if msg != "" {
		return nil, contract.Validation(msg)
	}
	total, _, fault := a.DB.ListUsage(ctx, actor.ID, filter, int64(size), 0)
	if fault != nil {
		return nil, fault
	}
	resolved, pages, limit, offset := domain.PageWindow(page, size, total)
	_, rows, fault := a.DB.ListUsage(ctx, actor.ID, filter, limit, offset)
	if fault != nil {
		return nil, fault
	}
	out := make([]usageView, 0, len(rows))
	for _, row := range rows {
		out = append(out, usageView{
			RequestID: row.RequestID, Workspace: row.Workspace, Email: row.Email, Model: row.Model,
			Channel: row.Channel, Thinking: row.Thinking, APIFormat: row.APIFormat, Operation: row.Operation,
			Status: row.Status, Input: row.Input, Output: row.Output, Cached: row.Cached, Reasoning: row.Reasoning,
			Total: row.Total, Charged: row.Charged, Absorbed: row.Absorbed, ErrorClass: row.ErrorClass,
			Upstream: row.Upstream, CreatedAt: billing.RFC3339Millis(row.CreatedAt), Latency: row.Latency, Speed: row.Speed,
		})
	}
	return struct {
		Data struct {
			Page     int32       `json:"page"`
			PageSize int32       `json:"page_size"`
			Pages    int32       `json:"total_pages"`
			Total    int64       `json:"total_rows"`
			Rows     []usageView `json:"rows"`
		} `json:"data"`
	}{Data: struct {
		Page     int32       `json:"page"`
		PageSize int32       `json:"page_size"`
		Pages    int32       `json:"total_pages"`
		Total    int64       `json:"total_rows"`
		Rows     []usageView `json:"rows"`
	}{domain.AsI32(resolved), domain.AsI32(size), pages, total, out}}, nil
}

type usageView struct {
	RequestID  string  `json:"request_id"`
	Workspace  string  `json:"workspace_name"`
	Email      string  `json:"email"`
	Model      string  `json:"model"`
	Channel    *string `json:"channel_name,omitempty"`
	Thinking   *string `json:"thinking_depth,omitempty"`
	APIFormat  *string `json:"api_format,omitempty"`
	Operation  string  `json:"operation"`
	Status     string  `json:"status"`
	Input      int64   `json:"input_tokens"`
	Output     int64   `json:"output_tokens"`
	Cached     int64   `json:"cached_input_tokens"`
	Reasoning  int64   `json:"reasoning_output_tokens"`
	Total      int64   `json:"total_microfen"`
	Charged    int64   `json:"charged_microfen"`
	Absorbed   int64   `json:"absorbed_microfen"`
	ErrorClass *string `json:"error_class,omitempty"`
	Upstream   *string `json:"upstream_error,omitempty"`
	CreatedAt  string  `json:"created_at"`
	Latency    *int64  `json:"latency_ms,omitempty"`
	Speed      *int64  `json:"generation_speed_milli_tps,omitempty"`
}

func (a *API) SummarizeUsage(ctx context.Context, actor domain.Actor, q, status, format, operation, since string) (any, *contract.Fault) {
	filter, msg := domain.ParseUsageFilter(q, status, format, operation, since, a.now())
	if msg != "" {
		return nil, contract.Validation(msg)
	}
	sum, fault := a.DB.SummarizeUsage(ctx, actor.ID, filter)
	if fault != nil {
		return nil, fault
	}
	classes := make([]struct {
		ErrorClass string `json:"error_class"`
		Count      int64  `json:"count"`
	}, 0, len(sum.Classes))
	for _, c := range sum.Classes {
		classes = append(classes, struct {
			ErrorClass string `json:"error_class"`
			Count      int64  `json:"count"`
		}{c.ErrorClass, c.Count})
	}
	return struct {
		Data usageSummary `json:"data"`
	}{usageSummary{
		Total: sum.Total, Settled: sum.Settled, Failed: sum.Failed, Unknown: sum.Unknown, InFlight: sum.InFlight,
		Input: sum.Input, Cached: sum.Cached, Output: sum.Output, Bps: domain.CacheHitBps(sum.Cached, sum.Input),
		Charged: sum.Charged, Absorbed: sum.Absorbed, P50: sum.P50, P90: sum.P90, P99: sum.P99,
		UP50: sum.UP50, UP90: sum.UP90, UP99: sum.UP99, Speed: sum.Speed, Classes: classes,
	}}, nil
}

type usageSummary struct {
	Total    int64  `json:"total_rows"`
	Settled  int64  `json:"settled_rows"`
	Failed   int64  `json:"failed_rows"`
	Unknown  int64  `json:"unbilled_unknown_rows"`
	InFlight int64  `json:"in_flight_rows"`
	Input    int64  `json:"input_tokens"`
	Cached   int64  `json:"cached_input_tokens"`
	Output   int64  `json:"output_tokens"`
	Bps      int32  `json:"cache_hit_rate_bps"`
	Charged  int64  `json:"charged_microfen"`
	Absorbed int64  `json:"absorbed_microfen"`
	P50      *int64 `json:"latency_p50_ms,omitempty"`
	P90      *int64 `json:"latency_p90_ms,omitempty"`
	P99      *int64 `json:"latency_p99_ms,omitempty"`
	UP50     *int64 `json:"upstream_latency_p50_ms,omitempty"`
	UP90     *int64 `json:"upstream_latency_p90_ms,omitempty"`
	UP99     *int64 `json:"upstream_latency_p99_ms,omitempty"`
	Speed    *int64 `json:"generation_speed_milli_tps_median,omitempty"`
	Classes  []struct {
		ErrorClass string `json:"error_class"`
		Count      int64  `json:"count"`
	} `json:"failure_classes"`
}

func (a *API) Prices(ctx context.Context) (any, *contract.Fault) {
	rows, fault := a.DB.CurrentPrices(ctx)
	if fault != nil {
		return nil, fault
	}
	return priceBody(rows), nil
}

func (a *API) PublishPrice(ctx context.Context, actor domain.Actor, model, mode string, in, cached, out, reasoning, per, max int64) (any, *contract.Fault) {
	if !domain.ValidPriceModel(model) {
		return nil, contract.Validation("模型名称无效")
	}
	price, msg := domain.NormalizePrice(domain.PriceInput{
		BillingMode: mode, Input: in, Cached: cached, Output: out, Reasoning: reasoning, PerRequest: per, MaxRequest: max,
	})
	if msg != "" {
		return nil, contract.Validation(msg)
	}
	rows, fault := a.DB.PublishPrice(ctx, actor, strings.TrimSpace(model), price)
	if fault != nil {
		return nil, fault
	}
	return priceBody(rows), nil
}

func (a *API) UnpublishPrice(ctx context.Context, actor domain.Actor, model string) (any, *contract.Fault) {
	model = strings.TrimSpace(model)
	if !domain.ValidPriceModel(model) {
		return nil, contract.Validation("模型名称无效")
	}
	def, fault := a.defaultModel(ctx)
	if fault != nil {
		return nil, fault
	}
	if def != "" && def == model {
		return nil, contract.Conflict("「" + model + "」是当前识图模型，请先切换到其他已定价模型")
	}
	ok, rows, fault := a.DB.UnpublishPrice(ctx, actor, model)
	if fault != nil {
		return nil, fault
	}
	if !ok {
		return nil, contract.NotFound("「" + model + "」没有已发布价格")
	}
	return priceBody(rows), nil
}

func priceBody(rows []domain.PriceRow) any {
	type view struct {
		Model     string `json:"model"`
		Mode      string `json:"billing_mode"`
		Input     int64  `json:"input_microfen_per_million"`
		Cached    int64  `json:"cached_input_microfen_per_million"`
		Output    int64  `json:"output_microfen_per_million"`
		Reasoning int64  `json:"reasoning_microfen_per_million"`
		Per       int64  `json:"per_request_microfen"`
		Max       int64  `json:"max_request_microfen"`
		From      string `json:"effective_from"`
	}
	out := make([]view, 0, len(rows))
	for _, row := range rows {
		out = append(out, view{row.Model, row.BillingMode, row.Input, row.Cached, row.Output, row.Reasoning, row.PerRequest, row.Max, billing.RFC3339Millis(row.Effective)})
	}
	return struct {
		Data struct {
			Prices []view `json:"prices"`
		} `json:"data"`
	}{Data: struct {
		Prices []view `json:"prices"`
	}{out}}
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	neg := n < 0
	if neg {
		n = -n
	}
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
