package service

import (
	"context"
	"crypto/rand"
	"math"
	"strings"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

// Agents is the admin agent use case.
type Agents struct {
	port AgentsPort
	opt  AgentsOptions
}

// NewAgents keeps the port.
func NewAgents(p AgentsPort, opt AgentsOptions) *Agents {
	return &Agents{port: p, opt: opt}
}

func (s *Agents) actor(a domain.Actor) domain.Actor {
	if a.OrgID < 0 {
		a.OrgID = 0
	}
	return a
}

// ListCommissions pages commissions. Unknown status values are filters, not errors.
func (s *Agents) ListCommissions(ctx context.Context, status *string, page, pageSize int64) (domain.CommissionList, error) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 1
	}
	if pageSize > 200 {
		pageSize = 200
	}
	total, rows, err := s.port.ListCommissions(ctx, status, pageSize, commissionOffset(page, pageSize))
	if err != nil {
		return domain.CommissionList{}, err
	}
	if rows == nil {
		rows = []domain.Commission{}
	}
	var out domain.CommissionList
	out.Data.Total = total
	out.Data.Page = page
	out.Data.PageSize = pageSize
	out.Data.Commissions = rows
	return out, nil
}

// ExportCommissions renders at most 10000 rows. Page arguments are ignored.
func (s *Agents) ExportCommissions(ctx context.Context, status *string) (string, error) {
	_, rows, err := s.port.ListCommissions(ctx, status, 10000, 0)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	b.WriteString("agent_email,invitee_email,paying_workspace,product,order_amount_cents,rebate_bps,amount_cents,status,note,payment_order,created_at\n")
	for _, row := range rows {
		b.WriteString(domain.CSVField(row.AgentEmail))
		b.WriteByte(',')
		b.WriteString(domain.CSVField(row.InviteeEmail))
		b.WriteByte(',')
		b.WriteString(domain.CSVField(row.WorkspaceName))
		b.WriteByte(',')
		b.WriteString(domain.CSVField(row.Product))
		b.WriteByte(',')
		b.WriteString(domain.CSVInt(row.OrderAmountCents))
		b.WriteByte(',')
		b.WriteString(domain.CSVInt(row.RebateBps))
		b.WriteByte(',')
		b.WriteString(domain.CSVInt(row.AmountCents))
		b.WriteByte(',')
		b.WriteString(domain.CSVField(row.Status))
		b.WriteByte(',')
		b.WriteString(domain.CSVField(row.Note))
		b.WriteByte(',')
		b.WriteString(domain.CSVField(row.PaymentOrderPublicID))
		b.WriteByte(',')
		b.WriteString(domain.CSVField(row.CreatedAt))
		b.WriteByte('\n')
	}
	return b.String(), nil
}

// SetPolicy updates the singleton and audits.
func (s *Agents) SetPolicy(ctx context.Context, actor domain.Actor, raw []byte) (domain.PolicyResponse, error) {
	in, err := domain.ParsePolicy(raw)
	if err != nil {
		return domain.PolicyResponse{}, err
	}
	if err := s.port.SetPolicy(ctx, s.actor(actor), in); err != nil {
		return domain.PolicyResponse{}, err
	}
	var out domain.PolicyResponse
	out.Data = domain.Policy{
		DefaultRebateBps: in.DefaultRebateBps, MinOrderCents: in.MinOrderCents,
		AttributionValidityDays: in.AttributionValidityDays, MinWithdrawCents: in.MinWithdrawCents,
	}
	return out, nil
}

// ListWithdrawals returns at most 500 rows.
func (s *Agents) ListWithdrawals(ctx context.Context, status *string) (domain.WithdrawalList, error) {
	rows, err := s.port.ListWithdrawals(ctx, status)
	if err != nil {
		return domain.WithdrawalList{}, err
	}
	if rows == nil {
		rows = []domain.AgentWithdrawal{}
	}
	var out domain.WithdrawalList
	out.Data.Withdrawals = rows
	return out, nil
}

// Pay settles a pending withdrawal.
func (s *Agents) Pay(ctx context.Context, actor domain.Actor, publicID string, raw []byte) (domain.WithdrawalResponse, error) {
	ref, err := domain.ParsePay(raw)
	if err != nil {
		return domain.WithdrawalResponse{}, err
	}
	row, err := s.port.Pay(ctx, s.actor(actor), publicID, ref)
	if err != nil {
		return domain.WithdrawalResponse{}, err
	}
	return domain.WithdrawalResponse{Data: row}, nil
}

// Reject releases a pending withdrawal.
func (s *Agents) Reject(ctx context.Context, actor domain.Actor, publicID string, raw []byte) (domain.WithdrawalResponse, error) {
	reason, err := domain.ParseReject(raw)
	if err != nil {
		return domain.WithdrawalResponse{}, err
	}
	row, err := s.port.Reject(ctx, s.actor(actor), publicID, reason)
	if err != nil {
		return domain.WithdrawalResponse{}, err
	}
	return domain.WithdrawalResponse{Data: row}, nil
}

// List returns agents and writes an audit row outside the write lease.
func (s *Agents) List(ctx context.Context, actor domain.Actor, query, status *string, flagged bool) (domain.AgentList, error) {
	policy, rows, err := s.port.ListAgents(ctx, s.actor(actor), query, status, flagged)
	if err != nil {
		return domain.AgentList{}, err
	}
	if rows == nil {
		rows = []domain.Agent{}
	}
	var out domain.AgentList
	out.Data.DefaultRebateBps = policy.DefaultRebateBps
	out.Data.MinOrderCents = policy.MinOrderCents
	out.Data.AttributionValidityDays = policy.AttributionValidityDays
	out.Data.MinWithdrawCents = policy.MinWithdrawCents
	out.Data.Agents = rows
	return out, nil
}

// Create enables an existing account as an agent.
func (s *Agents) Create(ctx context.Context, actor domain.Actor, raw []byte) (domain.AgentResponse, error) {
	email, invite, err := domain.ParseCreateAgent(raw)
	if err != nil {
		return domain.AgentResponse{}, err
	}
	generated := ""
	if invite == nil {
		generated, err = generateInvite()
		if err != nil {
			return domain.AgentResponse{}, err
		}
	}
	row, err := s.port.CreateAgent(ctx, s.actor(actor), email, invite, generated)
	if err != nil {
		return domain.AgentResponse{}, err
	}
	return domain.AgentResponse{Data: row}, nil
}

// Update changes status and, when set, the invite code.
func (s *Agents) Update(ctx context.Context, actor domain.Actor, uuid string, raw []byte) (domain.AgentResponse, error) {
	status, invite, keep, err := domain.ParseUpdateAgent(raw)
	if err != nil {
		return domain.AgentResponse{}, err
	}
	row, err := s.port.UpdateAgent(ctx, s.actor(actor), uuid, status, invite, keep)
	if err != nil {
		return domain.AgentResponse{}, err
	}
	return domain.AgentResponse{Data: row}, nil
}

func generateInvite() (string, error) {
	alphabet := domain.InviteAlphabet()
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", domain.Fail(500, "INTERNAL", "服务暂不可用")
	}
	out := make([]byte, 8)
	for i := range out {
		out[i] = alphabet[int(buf[i])%len(alphabet)]
	}
	return string(out), nil
}

func commissionOffset(page, pageSize int64) int64 {
	if page <= 1 || pageSize <= 0 {
		return 0
	}
	pages := page - 1
	if pages > math.MaxInt64/pageSize {
		return math.MaxInt64
	}
	return pages * pageSize
}
