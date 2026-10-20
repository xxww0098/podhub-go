package service

import (
	"context"
	"errors"
	"strings"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

// ErrProbeLarge is the 1 MiB catalogue cap.
var ErrProbeLarge = errors.New("catalogue too large")

// ErrProbeShort is a truncated upstream body.
var ErrProbeShort = errors.New("catalogue short")

// ProbeIn is the camelCase probe body after defaults.
type ProbeIn struct {
	AccountID string
	BaseURL   string
	APIKey    string
	APIFormat string
	Model     string
	HasFormat bool
}

type probeTarget struct {
	Base   string
	Format string
	Model  string
	Key    string
}

func (a *API) ListModels(ctx context.Context, in ProbeIn) (any, *contract.Fault) {
	target, fault := a.resolveProbe(ctx, in, false)
	if fault != nil {
		return nil, fault
	}
	models, fault := a.fetchModels(ctx, target)
	if fault != nil {
		return nil, fault
	}
	type option struct {
		ID    string `json:"id"`
		Owned string `json:"ownedBy"`
	}
	out := make([]option, 0, len(models))
	for _, m := range models {
		out = append(out, option{m.ID, m.OwnedBy})
	}
	return struct {
		Data struct {
			Models []option `json:"models"`
		} `json:"data"`
	}{Data: struct {
		Models []option `json:"models"`
	}{out}}, nil
}

func (a *API) VerifyModel(ctx context.Context, in ProbeIn) (any, *contract.Fault) {
	target, fault := a.resolveProbe(ctx, in, true)
	if fault != nil {
		return nil, fault
	}
	models, fault := a.fetchModels(ctx, target)
	if fault != nil {
		return nil, fault
	}
	return struct {
		Data struct {
			Verified bool `json:"verified"`
			Present  bool `json:"modelPresent"`
		} `json:"data"`
	}{Data: struct {
		Verified bool `json:"verified"`
		Present  bool `json:"modelPresent"`
	}{true, domain.ModelPresent(models, target.Model)}}, nil
}

func (a *API) resolveProbe(ctx context.Context, in ProbeIn, needModel bool) (probeTarget, *contract.Fault) {
	key := strings.TrimSpace(in.APIKey)
	draft := key != ""
	var stored *domain.StoredAI
	if id := strings.TrimSpace(in.AccountID); id != "" {
		snap, fault := a.readSnapshot(ctx, true)
		if fault != nil {
			return probeTarget{}, fault
		}
		if snap != nil {
			for i := range snap.AIAccounts {
				if snap.AIAccounts[i].ID == id {
					stored = &snap.AIAccounts[i]
					break
				}
			}
		}
		if stored == nil {
			return probeTarget{}, contract.Validation("AI 账户不存在")
		}
	}
	base := strings.TrimSpace(in.BaseURL)
	if base == "" && stored != nil {
		base = stored.BaseURL
	}
	format := "chat_completions"
	if in.HasFormat && in.APIFormat != "" {
		format = in.APIFormat
	} else if stored != nil && stored.APIFormat != "" {
		format = stored.APIFormat
	}
	model := strings.TrimSpace(in.Model)
	if model == "" && stored != nil {
		model = stored.Model
	}
	if !draft && stored != nil {
		if strings.TrimRight(strings.TrimSpace(stored.BaseURL), "/") != strings.TrimRight(base, "/") || stored.APIFormat != format {
			return probeTarget{}, contract.Validation("更改 AI 端点或 API 格式时必须重新填写 API Key")
		}
		key = stored.APIKey
	}
	if strings.TrimSpace(base) == "" || strings.TrimSpace(key) == "" {
		return probeTarget{}, contract.Validation("请先填写接口地址与 API Key")
	}
	if needModel && model == "" {
		return probeTarget{}, contract.Validation("请先填写模型名称")
	}
	if msg := domain.PublicEndpoint(base, a.Loopback); msg != "" {
		return probeTarget{}, contract.Validation(msg)
	}
	return probeTarget{Base: base, Format: format, Model: model, Key: key}, nil
}

func (a *API) fetchModels(ctx context.Context, target probeTarget) ([]domain.ModelOption, *contract.Fault) {
	if a.Fetch == nil {
		return nil, contract.Unavailable("RELAY_UNAVAILABLE", "AI 探测客户端不可用")
	}
	endpoint, ok := domain.ModelsEndpoint(target.Base, target.Format)
	if !ok {
		return nil, contract.Validation("接口地址不是允许的公网 https 端点")
	}
	status, body, dnsRefused, err := a.Fetch.Fetch(ctx, endpoint, target.Format, target.Key)
	if dnsRefused {
		return nil, contract.Validation("接口地址不是允许的公网 https 端点")
	}
	if errors.Is(err, ErrProbeLarge) {
		return nil, contract.Coded(502, "UPSTREAM_FAILED", "AI 服务返回的模型列表过大")
	}
	if errors.Is(err, ErrProbeShort) {
		return nil, contract.Coded(502, "UPSTREAM_FAILED", "AI 服务响应不完整")
	}
	if err != nil {
		return nil, contract.Coded(502, "UPSTREAM_FAILED", "无法连接 AI 服务")
	}
	if status < 200 || status >= 300 {
		code := "UPSTREAM_FAILED"
		if status == 401 || status == 403 {
			code = "UPSTREAM_CREDENTIALS"
		}
		return nil, contract.Coded(502, code, domain.ClientErrorSummary(status, string(body), target.Key))
	}
	models, ok := domain.ParseModels(body)
	if !ok {
		return nil, contract.Coded(502, "UPSTREAM_FAILED", "AI 服务返回了无法识别的模型列表")
	}
	return models, nil
}
