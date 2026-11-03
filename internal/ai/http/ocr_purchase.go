package aihttp

import (
	"context"

	billing "github.com/xxww0098/podhub-go/internal/billing/contract"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/aiclient"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

type completedOCR struct {
	Body      []byte
	Billing   billingView
	RequestID string
}

func (h httpHandler) completeOCR(ctx context.Context, p access.Principal, provider OCRProvider, request []byte, open func(billing.Price, int64) (openedHold, Response)) (completedOCR, Response) {
	tx, err := tenantx.BeginApp(ctx, h.deps.Pool.Begin, p.OrgID)
	if err != nil {
		return completedOCR{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	if h.deps.Wallet.CurrentForModel == nil {
		_ = tx.Rollback(ctx)
		return completedOCR{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	price, found, err := h.deps.Wallet.CurrentForModel(ctx, tx, provider.Model)
	_ = tx.Rollback(ctx)
	if err != nil || !found {
		return completedOCR{}, fail(503, "RELAY_UNAVAILABLE", "模型价格未发布")
	}
	hold, err := price.QuotePrepay()
	if err != nil {
		return completedOCR{}, fail(503, "RELAY_UNAVAILABLE", "模型价格不可用")
	}
	limits, resp := h.deps.limits(ctx)
	if resp.Status != 0 {
		return completedOCR{}, resp
	}
	lease, status, message := Acquire(ctx, h.deps.Pool, limits, p.UserID, provider.AccountID, true)
	if status != 0 {
		return completedOCR{}, fail(status, "BUSY", message)
	}
	defer lease.Release(context.Background())
	opened, resp := open(price, hold)
	if resp.Status != 0 {
		return completedOCR{}, resp
	}
	status, raw, err := provider.Complete(ctx, request)
	if err != nil {
		_ = releaseRequest(ctx, h.deps.Deps, p.OrgID, opened, "unbilled_unknown", "transport_unknown", nil)
		return completedOCR{}, fail(504, "UPSTREAM_UNKNOWN", "识别调用结果未知，本次未计费，请读取恢复状态")
	}
	if status != 200 {
		return completedOCR{}, settleFault(ctx, h.deps.Deps, p.OrgID, opened, status, raw)
	}
	folded, err := FoldCompletion(raw)
	if err != nil {
		_ = releaseRequest(ctx, h.deps.Deps, p.OrgID, opened, "unbilled_unknown", "missing_usage", nil)
		return completedOCR{}, fail(502, "UPSTREAM_UNBILLABLE", "识别结果缺少计费凭据，本次未计费")
	}
	usage, responseID, err := ParseUsage(aiclient.ChatCompletions, folded)
	if err != nil {
		_ = releaseRequest(ctx, h.deps.Deps, p.OrgID, opened, "unbilled_unknown", "missing_usage", nil)
		return completedOCR{}, fail(502, "UPSTREAM_UNBILLABLE", "识别结果缺少计费凭据，本次未计费")
	}
	charge, err := price.ChargeUsage(usage)
	if err != nil {
		_ = releaseRequest(ctx, h.deps.Deps, p.OrgID, opened, "unbilled_unknown", "usage_not_priceable", nil)
		return completedOCR{}, fail(502, "UPSTREAM_UNBILLABLE", "识别计费凭据无效")
	}
	view, err := settleRequest(ctx, h.deps.Deps, p.OrgID, opened, usage, charge, responseID, folded)
	if err != nil {
		return completedOCR{}, fail(500, "INTERNAL", "识别结果正在恢复，请勿重复购买")
	}
	return completedOCR{Body: folded, Billing: view, RequestID: opened.PublicID}, Response{}
}
