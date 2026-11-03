package app

import (
	"context"
	"errors"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/jackc/pgx/v5/pgxpool"
	configdoc "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	"github.com/xxww0098/podhub-go/internal/ai"
	"github.com/xxww0098/podhub-go/internal/platform/aiclient"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/httpx"
)

// newTextRuntime resolves chat accounts from the sealed integration snapshot.
// It refuses an account before a hold when its endpoint cannot be called.
func newTextRuntime(pool *pgxpool.Pool, cfg config.Config) ai.TextResolver {
	return &textRuntime{
		load: func(ctx context.Context) (configdoc.Snapshot, error) {
			return requireAISnapshot(ctx, pool, cfg)
		},
		allowLoopback: cfg.AIEgressAllowLoopback,
	}
}

type textRuntime struct {
	load          func(context.Context) (configdoc.Snapshot, error)
	allowLoopback bool
	turns         sync.Map
}

func (r *textRuntime) Resolve(ctx context.Context, model string, format aiclient.Format) (ai.TextProvider, error) {
	if !format.Valid() || model == "" {
		return ai.TextProvider{}, errors.New("text model or format invalid")
	}
	snapshot, err := r.load(ctx)
	if err != nil {
		return ai.TextProvider{}, err
	}
	candidates := make([]configdoc.StoredAI, 0, 4)
	for _, account := range snapshot.AIAccounts {
		if account.Active && account.Purpose == configdoc.PurposeChat && account.APIFormat == string(format) &&
			account.Model == model && account.APIKey != "" && account.BaseURL != "" {
			candidates = append(candidates, account)
		}
	}
	if len(candidates) == 0 {
		return ai.TextProvider{}, errors.New("text model unavailable")
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].Priority != candidates[j].Priority {
			return candidates[i].Priority > candidates[j].Priority
		}
		return candidates[i].ID < candidates[j].ID
	})
	top := 0
	for top < len(candidates) && candidates[top].Priority == candidates[0].Priority {
		top++
	}
	chosen := candidates[0]
	if top > 1 {
		key := model + "|" + string(format)
		counter, _ := r.turns.LoadOrStore(key, new(atomic.Uint64))
		chosen = candidates[int(counter.(*atomic.Uint64).Add(1)-1)%top]
	}
	_, host, err := textEndpoint(chosen.BaseURL, format, r.allowLoopback)
	if err != nil {
		return ai.TextProvider{}, err
	}
	client := httpx.PublicClient(host, r.allowLoopback)
	account := chosen
	return ai.TextProvider{
		AccountID: account.ID,
		Model:     account.Model,
		Format:    format,
		Complete: func(ctx context.Context, body []byte) (int, []byte, error) {
			body, err := ai.ApplyThinking(format, body, account.Thinking, account.ThinkingFormat)
			if err != nil {
				return 0, nil, aiclient.ErrInvalid
			}
			return (aiclient.Client{HTTP: client}).Complete(ctx, aiclient.Account{
				ID: account.ID, BaseURL: account.BaseURL, APIKey: account.APIKey, Model: account.Model, Format: format,
			}, body)
		},
	}, nil
}

// textEndpoint joins the account root with the native path and applies the
// production egress rule: https on 443, or any loopback origin while the local
// test switch is on.
func textEndpoint(base string, format aiclient.Format, allowLoopback bool) (string, string, error) {
	endpoint, err := aiclient.Endpoint(base, format)
	if err != nil {
		return "", "", err
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", "", errors.New("text endpoint invalid")
	}
	loopback := httpx.LoopbackHost(u.Hostname())
	if u.Scheme == "http" && !(allowLoopback && loopback) {
		return "", "", errors.New("text endpoint must be https")
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return "", "", errors.New("text endpoint must be https")
	}
	if !loopback && u.Port() != "" && u.Port() != "443" {
		return "", "", errors.New("text endpoint must use port 443")
	}
	return u.String(), strings.ToLower(u.Hostname()), nil
}
