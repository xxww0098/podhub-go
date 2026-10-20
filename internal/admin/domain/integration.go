package domain

import (
	"strings"
	"unicode"
)

// Thinking pairs that the normalizer accepts when thinking is not the default.
func ThinkingOK(format, thinking, thinkingFormat string) string {
	if thinking == "provider_default" {
		return ""
	}
	if thinkingFormat == "none" {
		return "“由模型 ID 决定”只能跟随供应商默认"
	}
	switch format {
	case "responses":
		if thinkingFormat != "reasoning_effort" {
			return "AI API 格式、思考状态与思考协议不兼容"
		}
	case "anthropic_messages":
		if thinkingFormat != "anthropic_budget" && thinkingFormat != "anthropic_adaptive" {
			return "AI API 格式、思考状态与思考协议不兼容"
		}
	case "chat_completions":
		if thinkingFormat == "anthropic_budget" || thinkingFormat == "anthropic_adaptive" {
			return "AI API 格式、思考状态与思考协议不兼容"
		}
		if thinkingFormat == "thinking_type" && (thinking == "medium" || thinking == "high") {
			return "AI API 格式、思考状态与思考协议不兼容"
		}
	default:
		return "AI API 格式、思考状态与思考协议不兼容"
	}
	return ""
}

// AIID accepts ASCII letters, digits, '-' and '_', at most 80 bytes.
func AIID(id string) bool {
	id = strings.TrimSpace(id)
	if id == "" || len(id) > 80 {
		return false
	}
	for _, r := range id {
		if r > unicode.MaxASCII || !(r == '-' || r == '_' || (r >= '0' && r <= '9') || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z')) {
			return false
		}
	}
	return true
}

// SliceBucket checks the fixed roster rules. oldEurope is true when the
// previous snapshot contained an account whose id is exactly podhub-slices.
func SliceBucket(accounts []MediaAccount, oldEurope bool) string {
	apac := 0
	var apacRow *MediaAccount
	var europe *MediaAccount
	for i := range accounts {
		row := &accounts[i]
		switch row.Bucket {
		case "podhub-slices-apac-test":
			return "podhub-slices-apac-test 只是测速桶，不能作为切片存储"
		case "podhub-supplier", "podhub-delegate":
			return "切片不能写入商库桶或用户素材桶"
		case "podhub-slices-apac":
			apac++
			apacRow = row
		}
		if row.ID == "podhub-slices" {
			europe = row
		}
	}
	if apac > 1 {
		return "亚太切片桶 podhub-slices-apac 只能配置一个账号"
	}
	if apacRow != nil {
		if !apacRow.Active {
			return "新切片写入亚太桶 podhub-slices-apac，它必须是当前媒体账号"
		}
		if strings.TrimRight(strings.TrimSpace(apacRow.PublicBaseURL), "/") != "https://podhub-slices-apac.ozon-pod.com" {
			return "亚太切片桶的公开域名必须是 https://podhub-slices-apac.ozon-pod.com"
		}
	}
	if oldEurope && europe == nil {
		return "欧洲切片桶 podhub-slices 仍有历史对象，不能从配置中移除"
	}
	if europe != nil && (europe.Bucket != "podhub-slices" || strings.TrimRight(strings.TrimSpace(europe.PublicBaseURL), "/") != strings.TrimRight(strings.TrimSpace(europe.PreviousOrigin), "/")) {
		if europe.PreviousOrigin != "" && strings.TrimRight(strings.TrimSpace(europe.PublicBaseURL), "/") != strings.TrimRight(strings.TrimSpace(europe.PreviousOrigin), "/") {
			return "历史切片仍从原欧洲桶读取，不能改它的桶名或公开域名"
		}
		if europe.Bucket != "podhub-slices" {
			return "历史切片仍从原欧洲桶读取，不能改它的桶名或公开域名"
		}
	}
	return ""
}

// MediaAccount is one normalized storage row used by the slice check.
type MediaAccount struct {
	ID             string
	Bucket         string
	Active         bool
	PublicBaseURL  string
	PreviousOrigin string
}

// SameBucket reports the 409 exclusivity sentence, or empty.
func SameBucket(delegate, supplier *BucketKey, media []BucketKey) string {
	if delegate != nil {
		for _, row := range media {
			if delegate.Equal(row) {
				return "委托原图存储桶不得与切片媒体桶共用"
			}
		}
		if supplier != nil && delegate.Equal(*supplier) {
			return "委托原图存储桶不得与平台货源存储桶共用"
		}
	}
	if supplier != nil {
		for _, row := range media {
			if supplier.Equal(row) {
				return "平台货源存储桶不得与切片媒体桶共用"
			}
		}
	}
	return ""
}

// BucketKey is provider + endpoint + bucket after normalization.
type BucketKey struct {
	Provider string
	Endpoint string
	Bucket   string
}

func (b BucketKey) Equal(o BucketKey) bool {
	return b.Provider == o.Provider && b.Endpoint == o.Endpoint && b.Bucket == o.Bucket
}
