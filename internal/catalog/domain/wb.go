package domain

import (
	"strconv"
	"unicode/utf8"
)

// WBReject is the single coordinate validation sentence.

// WB subject reads. Issue selection follows the empty, stale, and digest cases
// named in the catalog spec. A future fetched_at is not usable and uses catalog_stale.

const WBMaxAgeMs int64 = 259_200_000

const wbReject = "WB 类目需要正整数 subjectId 和 ru/en/zh language，请重新选择原生类目"

func wbSubjectID(subject string) bool {
	if subject == "" || len(subject) > 19 || !utf8.ValidString(subject) {
		return false
	}
	for _, r := range subject {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// WBLanguage is ru, en, or zh.
func WBLanguage(raw string) (string, bool) {
	switch raw {
	case "ru", "en", "zh":
		return raw, true
	default:
		return "", false
	}
}

// AcceptWBQuery is the coordinate gate. Every failure is the same sentence.
func AcceptWBQuery(subject, rawQuery, language string, unknown bool) (int64, string, string, bool) {
	if unknown || rawQuery == "" || len(rawQuery) > 32 || !wbSubjectID(subject) {
		return 0, "", wbReject, false
	}
	id, err := strconv.ParseInt(subject, 10, 64)
	if err != nil || id <= 0 {
		return 0, "", wbReject, false
	}
	lang, ok := WBLanguage(language)
	if !ok {
		return 0, "", wbReject, false
	}
	return id, lang, "", true
}

// WBIssue is one metadata issue. Field is catalog or defaults.
type WBIssue struct {
	Code  string
	Field string
}

// WBIssues selects the issue list.
// No row is catalog_unavailable only. An unusable catalog (expired or future)
// is catalog_stale plus defaults_stale. A usable catalog with no defaults row,
// or a digest that does not match, is defaults_stale only.
func WBIssues(hasRow, catalogUsable, hasDefaults, digestMatch bool) []WBIssue {
	if !hasRow {
		return []WBIssue{{Code: "catalog_unavailable", Field: "catalog"}}
	}
	if !catalogUsable {
		return []WBIssue{
			{Code: "catalog_stale", Field: "catalog"},
			{Code: "defaults_stale", Field: "defaults"},
		}
	}
	if !hasDefaults || !digestMatch {
		return []WBIssue{{Code: "defaults_stale", Field: "defaults"}}
	}
	return []WBIssue{}
}

// CatalogUsable is fetched_at <= now and age <= 72h.
func CatalogUsable(fetchedAtMs, nowMs int64) bool {
	if fetchedAtMs > nowMs {
		return false
	}
	return nowMs-fetchedAtMs <= WBMaxAgeMs
}
