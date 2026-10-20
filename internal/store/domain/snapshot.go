package domain

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

// FinanceBalance outcomes. `ready` is the only one that carries an amount.
const (
	FinanceOutcomeReady       = "ready"
	FinanceOutcomeForbidden   = "forbidden"
	FinanceOutcomeUnavailable = "unavailable"
	FinanceOutcomeError       = "error"
)

// ProductQuotaFromOzon reads POST /v4/product/info/limit. A missing bucket
// stays missing: Ozon omits what it does not cap, and `-1` is preserved as the
// "no cap" spelling rather than normalised to a number.
func ProductQuotaFromOzon(body []byte, archived *int64, fetchedAtMS int64) ProductQuota {
	out := ProductQuota{FetchedAtMS: fetchedAtMS}
	var root struct {
		DailyCreate *ozonDailyLimit `json:"daily_create"`
		DailyUpdate *ozonDailyLimit `json:"daily_update"`
		Total       *ozonTotalLimit `json:"total"`
	}
	if err := json.Unmarshal(body, &root); err != nil {
		return out
	}
	if root.DailyCreate != nil {
		out.DailyCreate = &ProductQuotaBucket{Limit: root.DailyCreate.Limit, Usage: root.DailyCreate.Usage}
	}
	if root.DailyUpdate != nil {
		out.DailyUpdate = &ProductQuotaBucket{Limit: root.DailyUpdate.Limit, Usage: root.DailyUpdate.Usage}
	}
	if root.Total != nil {
		total := &ProductQuotaTotal{Limit: root.Total.Limit, Usage: root.Total.Usage}
		if archived != nil {
			value := *archived
			total.Archived = &value
		}
		// An empty list stays an empty list, not nil: the cabinet has no
		// in-demand quotas, which is a fact the page can render.
		categories := make([]ProductQuotaCategory, 0, len(root.Total.QuotaByCategory))
		for _, category := range root.Total.QuotaByCategory {
			categories = append(categories, ProductQuotaCategory{
				CategoryID: category.CategoryID,
				Limit:      category.Limit,
				Usage:      category.Usage,
			})
		}
		total.Categories = &categories
		out.Total = total
	}
	return out
}

type ozonDailyLimit struct {
	Limit int64 `json:"limit"`
	Usage int64 `json:"usage"`
}

type ozonTotalLimit struct {
	Limit           int64 `json:"limit"`
	Usage           int64 `json:"usage"`
	QuotaByCategory []struct {
		CategoryID int64 `json:"category_id"`
		Limit      int64 `json:"limit"`
		Usage      int64 `json:"usage"`
	} `json:"quota_by_category"`
}

// ArchivedTotal reads `/v3/product/list`'s `total` for the ARCHIVED filter.
// Each archived product refunds +1 to the assortment limit in the cabinet's
// accounting, so this count is what turns `total.limit` into an effective one.
func ArchivedTotal(body []byte) (int64, bool) {
	var root struct {
		Total *int64 `json:"total"`
	}
	if err := json.Unmarshal(body, &root); err != nil || root.Total == nil || *root.Total < 0 {
		return 0, false
	}
	return *root.Total, true
}

// FinanceBalanceFromOzon classifies one POST /v1/finance/balance answer.
//
// `total.closing_balance` is «Баланс на конец периода»: the balance at
// `date_to`, with that object's own currency. The Seller API has no
// "available to withdraw" figure, and this function does not invent one.
func FinanceBalanceFromOzon(status int, body []byte, periodTo string, fetchedAtMS int64) FinanceBalance {
	switch {
	case status == 401 || status == 403:
		return blankBalance(FinanceOutcomeForbidden, periodTo, fetchedAtMS)
	case status == 404:
		return blankBalance(FinanceOutcomeUnavailable, periodTo, fetchedAtMS)
	case status < 200 || status >= 300:
		return blankBalance(FinanceOutcomeError, periodTo, fetchedAtMS)
	}
	var root struct {
		Total *struct {
			ClosingBalance *struct {
				Value        *float64 `json:"value"`
				CurrencyCode string   `json:"currency_code"`
			} `json:"closing_balance"`
		} `json:"total"`
	}
	if err := json.Unmarshal(body, &root); err != nil || root.Total == nil || root.Total.ClosingBalance == nil {
		return blankBalance(FinanceOutcomeUnavailable, periodTo, fetchedAtMS)
	}
	money := root.Total.ClosingBalance
	if money.Value == nil || math.IsNaN(*money.Value) || math.IsInf(*money.Value, 0) {
		return blankBalance(FinanceOutcomeUnavailable, periodTo, fetchedAtMS)
	}
	currency := NormalizeCurrencyCode(money.CurrencyCode)
	if currency == "" {
		return blankBalance(FinanceOutcomeUnavailable, periodTo, fetchedAtMS)
	}
	amount, ok := amountText(*money.Value)
	if !ok {
		return blankBalance(FinanceOutcomeUnavailable, periodTo, fetchedAtMS)
	}
	return FinanceBalance{
		Outcome: FinanceOutcomeReady, Amount: &amount, CurrencyCode: &currency,
		PeriodTo: periodTo, FetchedAtMS: fetchedAtMS,
	}
}

func blankBalance(outcome, periodTo string, fetchedAtMS int64) FinanceBalance {
	return FinanceBalance{Outcome: outcome, PeriodTo: periodTo, FetchedAtMS: fetchedAtMS}
}

// NormalizeCurrencyCode keeps an ISO code upper-cased and passes anything else
// through trimmed: the wire must not invent a code.
func NormalizeCurrencyCode(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	upper := strings.ToUpper(trimmed)
	if len(upper) == 3 && isASCIIAlpha(upper) {
		return upper
	}
	return trimmed
}

func isASCIIAlpha(value string) bool {
	if value == "" {
		return false
	}
	for i := 0; i < len(value); i++ {
		if value[i] < 'A' || value[i] > 'Z' {
			return false
		}
	}
	return true
}

func amountText(value float64) (string, bool) {
	scaled := math.Round(value * 100)
	if math.IsNaN(scaled) || math.IsInf(scaled, 0) || math.Abs(scaled) > math.MaxInt64 {
		return "", false
	}
	cents := int64(scaled)
	sign := ""
	if cents < 0 {
		sign = "-"
		cents = -cents
	}
	return sign + strconv.FormatInt(cents/100, 10) + "." + pad2(cents%100), true
}

func pad2(value int64) string {
	if value < 10 {
		return "0" + strconv.FormatInt(value, 10)
	}
	return strconv.FormatInt(value, 10)
}
