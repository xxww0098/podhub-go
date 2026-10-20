package service

import (
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/billingexpr"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"

	"github.com/QuantumNous/new-api/hostctx"
)

// Podhub adapter. text_quota.go's PostTextConsumeQuota calls these. They live
// in other new-api files that write users.quota, logs, or tiered settlement
// side effects. The formula function calculateTextQuotaSummary does not call
// them. Each one panics so a wallet path cannot run by accident.

func effectiveBillingUsage(usage *dto.Usage) *dto.Usage {
	panic("adapter: effectiveBillingUsage is not copied")
}

func ObserveChannelAffinityUsageCacheByRelayFormat(c *hostctx.Context, usage *dto.Usage, relayFormat types.RelayFormat) {
	panic("adapter: channel affinity is not copied")
}

func SettleBilling(ctx *hostctx.Context, relayInfo *relaycommon.RelayInfo, actualQuota int) error {
	panic("adapter: SettleBilling is not copied; podhub must not call new-api wallet settlement")
}

func GenerateTextOtherInfo(ctx *hostctx.Context, relayInfo *relaycommon.RelayInfo, modelRatio, groupRatio, completionRatio float64,
	cacheTokens int, cacheRatio float64, modelPrice float64, userGroupRatio float64) *model.LogOther {
	panic("adapter: consume-log other JSON is not copied")
}

func GenerateClaudeOtherInfo(ctx *hostctx.Context, relayInfo *relaycommon.RelayInfo, modelRatio, groupRatio, completionRatio float64,
	cacheTokens int, cacheRatio float64,
	cacheCreationTokens int, cacheCreationRatio float64,
	cacheCreationTokens5m int, cacheCreationRatio5m float64,
	cacheCreationTokens1h int, cacheCreationRatio1h float64,
	modelPrice float64, userGroupRatio float64) *model.LogOther {
	panic("adapter: consume-log other JSON is not copied")
}

func appendUsageBillingPathForLog(other *model.LogOther, isLocalCountTokens bool, usage *dto.Usage) {
	panic("adapter: consume-log other JSON is not copied")
}

func InjectTieredBillingInfo(other *model.LogOther, relayInfo *relaycommon.RelayInfo, result *billingexpr.TieredResult) {
	panic("adapter: tiered log injection is not copied")
}

func attachQuotaSaturation(ctx *hostctx.Context, relayInfo *relaycommon.RelayInfo, other *model.LogOther) {
	panic("adapter: quota saturation log marker is not copied")
}

func BuildTieredTokenParams(usage *dto.Usage, isClaudeUsageSemantic bool, usedVars map[string]bool) billingexpr.TokenParams {
	panic("adapter: BuildTieredTokenParams is not copied")
}

func TryTieredSettle(relayInfo *relaycommon.RelayInfo, params billingexpr.TokenParams) (ok bool, quota int, result *billingexpr.TieredResult) {
	panic("adapter: TryTieredSettle is not copied")
}

func isFixedPriceSettlement(info *relaycommon.RelayInfo, result *billingexpr.TieredResult) bool {
	panic("adapter: isFixedPriceSettlement is not copied")
}
