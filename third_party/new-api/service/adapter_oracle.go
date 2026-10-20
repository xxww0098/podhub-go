package service

import (
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/hostctx"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relay/helper"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	hosttypes "github.com/QuantumNous/new-api/types"

	"github.com/shopspring/decimal"
)

func init() {
	// new-api calls this from main. The copied tree has no main.
	ratio_setting.InitRatioSettings()
}

// QuoteText runs the copied ModelPriceHelper and calculateTextQuotaSummary.
// It does not reimplement either formula. group is both the user group and
// the using group. semantic is dto.Usage.UsageSemantic ("" or "anthropic").
func QuoteText(model, group string, prompt, completion, cache, cacheCreate int, semantic string) (preConsume, settled int, err error) {
	c := testContext()
	info := &relaycommon.RelayInfo{
		OriginModelName: model,
		UsingGroup:      group,
		UserGroup:       group,
		StartTime:       time.Now(),
	}
	price, err := helper.ModelPriceHelper(c, info, prompt, nil)
	if err != nil {
		return 0, 0, err
	}
	usage := &dto.Usage{
		PromptTokens:     prompt,
		CompletionTokens: completion,
		UsageSemantic:    semantic,
		PromptTokensDetails: dto.InputTokenDetails{
			CachedTokens:         cache,
			CachedCreationTokens: cacheCreate,
		},
	}
	return price.QuotaToPreConsume, calculateTextQuotaSummary(c, info, usage).Quota, nil
}

// QuotePerCall runs the copied ModelPriceHelperPerCall.
func QuotePerCall(model, group string) (int, error) {
	c := testContext()
	info := &relaycommon.RelayInfo{
		OriginModelName: model,
		UsingGroup:      group,
		UserGroup:       group,
		StartTime:       time.Now(),
	}
	price, err := helper.ModelPriceHelperPerCall(c, info)
	if err != nil {
		return 0, err
	}
	return price.Quota, nil
}

// QuotaFromDecimalInt calls the copied QuotaFromDecimal. The podhub test
// uses the returned int so it does not import a second decimal module.
func QuotaFromDecimalInt(raw int64) int {
	return common.QuotaFromDecimal(decimal.NewFromInt(raw))
}

// testContext matches gin.CreateTestContext for the formula: no Request and
// no keys.
func testContext() *hostctx.Context {
	return &hostctx.Context{}
}

// QuoteScheduled runs the copied pre-consume truncation and
// calculateTextQuotaSummary. Ratios are arguments, so the global ratio maps
// stay untouched. The using group is always "default"; its ratio comes from
// the copied GetGroupRatio. This does not reimplement either formula.
func QuoteScheduled(estimatePrompt, prompt, completion, cache int, modelRatio, completionRatio, cacheRatio float64) (preConsume, settled int, groupRatio float64, err error) {
	groupRatio = ratio_setting.GetGroupRatio("default")
	mul, err := operation_setting.InputPreConsumeMultiplier()
	if err != nil {
		return 0, 0, groupRatio, err
	}
	preConsume, err = common.QuotaFromFloatStrict(float64(estimatePrompt) * mul * modelRatio * groupRatio)
	if err != nil {
		return 0, 0, groupRatio, err
	}
	c := testContext()
	info := &relaycommon.RelayInfo{
		OriginModelName: "scheduled",
		UsingGroup:      "default",
		UserGroup:       "default",
		StartTime:       time.Now(),
		PriceData: hosttypes.PriceData{
			ModelRatio:      modelRatio,
			CompletionRatio: completionRatio,
			CacheRatio:      cacheRatio,
			GroupRatioInfo:  hosttypes.GroupRatioInfo{GroupRatio: groupRatio},
		},
	}
	usage := &dto.Usage{
		PromptTokens:     prompt,
		CompletionTokens: completion,
		TotalTokens:      prompt + completion,
		PromptTokensDetails: dto.InputTokenDetails{
			CachedTokens: cache,
		},
	}
	return preConsume, calculateTextQuotaSummary(c, info, usage).Quota, groupRatio, nil
}

// QuoteFlat runs the copied per-call truncation:
// QuotaFromFloatStrict(priceUSD * QuotaPerUnit * groupRatio).
// priceUSD is the caller's microfen amount divided by QuotaPerUnit when one
// quota unit equals one microfen. The using group is "default".
func QuoteFlat(priceUSD float64) (int, float64, error) {
	groupRatio := ratio_setting.GetGroupRatio("default")
	quota, err := common.QuotaFromFloatStrict(priceUSD * common.QuotaPerUnit * groupRatio)
	return quota, groupRatio, err
}
