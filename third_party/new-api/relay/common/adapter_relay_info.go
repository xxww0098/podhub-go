package common

import (
	"time"

	hostcommon "github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/billingexpr"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	hosttypes "github.com/QuantumNous/new-api/types"
)

// Podhub adapter. relay/common/relay_info.go is 1272 lines and also builds
// channel metadata, websockets, and gin request state. The formula files
// (relay/helper/price.go, service/text_quota.go) only read the fields and
// methods below. Method bodies are the upstream implementations:
// SetEstimatePromptTokens / GetEstimatePromptTokens relay_info.go:820-832,
// GetOriginModelName relay_info.go:841-846, GetBillingModelName
// relay_info.go:850-858, GetFinalRequestRelayFormat relay_info.go:777-788.

type ChannelMeta struct {
	ChannelType int
}

type BuildInToolInfo struct {
	CallCount int
}

type ResponsesUsageInfo struct {
	BuiltInTools map[string]*BuildInToolInfo
}

type RelayInfo struct {
	TokenId                 int
	UserId                  int
	UsingGroup              string
	UserGroup               string
	StartTime               time.Time
	IsStream                bool
	RelayMode               int
	OriginModelName         string
	BillingModelName        string
	RequestHeaders          map[string]string
	RelayFormat             types.RelayFormat
	FinalRequestRelayFormat types.RelayFormat
	RequestConversionChain  []types.RelayFormat
	FinalPreConsumedQuota   int
	PriceData               hosttypes.PriceData
	QuotaClamp              *hostcommon.QuotaClamp
	TieredBillingSnapshot   *billingexpr.BillingSnapshot
	BillingRequestInput     *billingexpr.RequestInput
	ImageQuotaBeforeGroup   float64
	Request                 dto.Request
	UserSetting             dto.UserSetting
	ResponsesUsageInfo      *ResponsesUsageInfo
	ChannelId               int
	PerformanceOutputTokens int64
	estimatePromptTokens    int
	*ChannelMeta
}

func (info *RelayInfo) SetEstimatePromptTokens(promptTokens int) {
	if info == nil {
		return
	}
	info.estimatePromptTokens = promptTokens
}

func (info *RelayInfo) GetEstimatePromptTokens() int {
	if info == nil {
		return 0
	}
	return info.estimatePromptTokens
}

func (info *RelayInfo) GetOriginModelName() string {
	if info == nil {
		return ""
	}
	return info.OriginModelName
}

func (info *RelayInfo) GetBillingModelName() string {
	if info == nil {
		return ""
	}
	if info.BillingModelName != "" {
		return info.BillingModelName
	}
	return info.OriginModelName
}

func (info *RelayInfo) GetFinalRequestRelayFormat() types.RelayFormat {
	if info == nil {
		return ""
	}
	if info.FinalRequestRelayFormat != "" {
		return info.FinalRequestRelayFormat
	}
	if n := len(info.RequestConversionChain); n > 0 {
		return info.RequestConversionChain[n-1]
	}
	return info.RelayFormat
}
