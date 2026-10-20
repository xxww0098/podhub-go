package service

import (
	"context"
	"time"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

// AgentsPort is the admin agent persistence seam.
type AgentsPort interface {
	ListCommissions(ctx context.Context, status *string, limit, offset int64) (int64, []domain.Commission, error)
	SetPolicy(ctx context.Context, actor domain.Actor, in domain.PolicyInput) error
	ListWithdrawals(ctx context.Context, status *string) ([]domain.AgentWithdrawal, error)
	Pay(ctx context.Context, actor domain.Actor, publicID string, reference *string) (domain.AgentWithdrawal, error)
	Reject(ctx context.Context, actor domain.Actor, publicID, reason string) (domain.AgentWithdrawal, error)
	ListAgents(ctx context.Context, actor domain.Actor, query, status *string, flagged bool) (domain.Policy, []domain.Agent, error)
	CreateAgent(ctx context.Context, actor domain.Actor, email string, invite *string, generated string) (domain.Agent, error)
	UpdateAgent(ctx context.Context, actor domain.Actor, uuid, status string, invite *string, keep bool) (domain.Agent, error)
}

// AgentsOptions is the clock.
type AgentsOptions struct {
	Now func() time.Time
}
