package app

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
	agenthttp "github.com/xxww0098/podhub-go/internal/agent/http"
	agentrepo "github.com/xxww0098/podhub-go/internal/agent/repo"
	"github.com/xxww0098/podhub-go/internal/agent/service"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

// mountAgent wires the seven agent routes.
// The agent tables have no RLS and these handlers do not call tenant.BeginApp.
// user_wallets is the only statement that sets podhub_app, and only inside
// the transfer that credits it.
func mountAgent(r chi.Router, pool *pgxpool.Pool, resolve access.Resolver) {
	agenthttp.Mount(r, agenthttp.Deps{
		Service: service.New(agentrepo.New(pool)),
		Resolve: adaptAgent(resolve),
	})
}

func adaptAgent(resolve access.Resolver) agenthttp.Resolve {
	return func(r *http.Request) (contract.Actor, *agenthttp.Refusal, error) {
		if resolve == nil {
			return contract.Actor{}, nil, nil
		}
		principal, refusal, err := resolve.Resolve(r)
		if err != nil {
			return contract.Actor{}, nil, err
		}
		if refusal != nil {
			code := "AUTH_REQUIRED"
			if refusal.Status == http.StatusForbidden {
				code = "FORBIDDEN"
			} else if refusal.Status >= 500 {
				code = "INTERNAL"
			}
			return contract.Actor{}, &agenthttp.Refusal{
				Status: refusal.Status, Code: code, Message: refusal.Message,
			}, nil
		}
		if principal == nil {
			return contract.Actor{}, nil, nil
		}
		return contract.Actor{UserID: principal.UserID, OrgID: principal.OrgID}, nil, nil
	}
}
