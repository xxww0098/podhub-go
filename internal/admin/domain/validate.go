// Package domain holds the pure admin checks for official packages,
// category prompts, and category videos. No I/O.
package domain

import (
	"encoding/json"
	"errors"
	x1contract "github.com/xxww0098/podhub-go/internal/admin/x1/contract"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	maxScalarName  = 255
	maxBriefBytes  = 4096
	maxFixedTags   = 30
	maxTagChars    = 30
	maxVideoURL    = 2048
	maxDurationMS  = 3_600_000
	maxPackageName = 255
)

// ErrInvalidName is 名称无效.
var ErrInvalidName = errors.New("名称无效")

// ErrNotObject is defaults_json 必须是 JSON 对象.
var ErrNotObject = errors.New("defaults_json 必须是 JSON 对象")

// ErrNotArray is dataset_json 必须是 JSON 数组.
var ErrNotArray = errors.New("dataset_json 必须是 JSON 数组")

// PackageName trims and rejects an empty name or one longer than 255 bytes.
func PackageName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" || len(name) > maxPackageName {
		return "", ErrInvalidName
	}
	return name, nil
}

// JSONObject reports whether the text parses as a JSON object.
func JSONObject(raw string) error {
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		return ErrNotObject
	}
	if _, ok := v.(map[string]any); !ok {
		return ErrNotObject
	}
	return nil
}

// JSONArray reports whether the text parses as a JSON array.
func JSONArray(raw string) error {
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		return ErrNotArray
	}
	if _, ok := v.([]any); !ok {
		return ErrNotArray
	}
	return nil
}

// PromptName trims and requires 1–255 Unicode scalars.
func PromptName(raw string) (string, error) { return x1contract.PromptName(raw) }

// PromptFile requires Path::extension to be the case-sensitive string md or txt.
func PromptFile(raw string) (string, error) { return x1contract.PromptFile(raw) }

// CanonicalBrief stores six trimmed lines joined by LF.
// The byte cap is measured after BOM removal and trim, before the join.
func CanonicalBrief(raw string) (string, error) { return x1contract.CanonicalBrief(raw) }

// FixedTags checks the 1–30 Russian hashtag list.
func FixedTags(tags []string) error { return x1contract.FixedTags(tags) }

// VideoName trims and requires 1–255 Unicode scalars.
func VideoName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" || utf8.RuneCountInString(name) > maxScalarName {
		return "", errors.New("视频名称需为 1–255 个字符")
	}
	return name, nil
}

// VideoURL trims and requires a whitespace-free https URL of at most 2048 scalars.
func VideoURL(raw string) (string, error) {
	url := strings.TrimSpace(raw)
	if utf8.RuneCountInString(url) > maxVideoURL || !strings.HasPrefix(url, "https://") {
		return "", errors.New("视频链接必须是不含空白的 HTTPS 地址")
	}
	for _, r := range url {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return "", errors.New("视频链接必须是不含空白的 HTTPS 地址")
		}
	}
	return url, nil
}

// VideoDuration requires 1 millisecond through 1 hour.
func VideoDuration(ms int64) error {
	if ms <= 0 || ms > maxDurationMS {
		return errors.New("视频时长必须在 1 毫秒–1 小时之间")
	}
	return nil
}
