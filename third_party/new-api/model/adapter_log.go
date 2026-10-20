package model

import (
	"github.com/QuantumNous/new-api/common"

	"github.com/QuantumNous/new-api/hostctx"
)

// Podhub adapter. model/user.go IsAdmin queries new-api's users table.
// model/log.go RecordConsumeLog writes the unscoped logs table.
// Neither is copied. IsAdmin is only used to pick an error string in
// relay/helper/price.go. It returns false here, so the non-admin key is used.
// RecordConsumeLog and the quota counters panic: text_quota.go references
// them from PostTextConsumeQuota, which this tree does not call.

func IsAdmin(userId int) bool { return false }

type LogOther struct{}

func (o *LogOther) SetPublic(key string, value any) bool { return false }

func (o *LogOther) SetAdmin(key string, value any) bool { return false }

type RecordConsumeLogParams struct {
	ChannelId        int
	PromptTokens     int
	CompletionTokens int
	ModelName        string
	TokenName        string
	Quota            int
	Content          []*common.Message
	TokenId          int
	UseTimeSeconds   int
	IsStream         bool
	Group            string
	Other            *LogOther
}

func RecordConsumeLog(ctx *hostctx.Context, userId int, params RecordConsumeLogParams) {
	panic("adapter: new-api consume log persistence is not copied")
}

func UpdateUserUsedQuotaAndRequestCount(userId int, quota int) {
	panic("adapter: new-api users.quota is not copied")
}

func UpdateChannelUsedQuota(channelId int, quota int) {
	panic("adapter: new-api channel quota is not copied")
}
