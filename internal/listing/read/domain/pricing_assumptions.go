package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"math/big"
	"regexp"
	"strings"
	"unicode/utf8"
)

type pricingAssumptions struct {
	Currency string `json:"currency"`
	Costs    []struct {
		Name         string  `json:"name"`
		Amount       string  `json:"amount"`
		Currency     string  `json:"currency"`
		ExchangeRate *string `json:"exchangeRate,omitempty"`
	} `json:"costs"`
	Fees []struct {
		Name    string `json:"name"`
		RateBps *int64 `json:"rateBps"`
	} `json:"fees"`
	TargetMarginBps *int64 `json:"targetMarginBps"`
}

var pricingDecimal = regexp.MustCompile(`^(0|[1-9]\d*)(\.\d+)?$`)

func normalizePricingAssumptions(raw json.RawMessage) (json.RawMessage, error) {
	var data pricingAssumptions
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&data) != nil || !pricingCurrency(data.Currency) || len(data.Costs) == 0 || len(data.Costs) > 32 || data.Fees == nil || len(data.Fees) > 32 || !pricingBps(data.TargetMarginBps) {
		return nil, errors.New("币种、成本、费率或目标利润率格式无效")
	}
	limit := big.NewInt(999999999999)
	total := new(big.Int)
	for i := range data.Costs {
		cost := &data.Costs[i]
		cost.Name = strings.TrimSpace(cost.Name)
		amount := pricingNumber(cost.Amount, 2)
		if !pricingName(cost.Name) || !pricingCurrency(cost.Currency) || amount == nil {
			return nil, errors.New("成本名称、金额或币种无效")
		}
		source := new(big.Rat).Mul(amount, big.NewRat(100, 1))
		if !source.IsInt() || source.Num().Cmp(limit) > 0 {
			return nil, errors.New("成本金额超出上限")
		}
		rate := big.NewRat(1, 1)
		if cost.ExchangeRate != nil {
			rate = pricingNumber(*cost.ExchangeRate, 8)
		}
		if rate == nil || rate.Sign() <= 0 || rate.Cmp(big.NewRat(1000000, 1)) > 0 || cost.Currency != data.Currency && cost.ExchangeRate == nil || cost.Currency == data.Currency && rate.Cmp(big.NewRat(1, 1)) != 0 {
			return nil, errors.New("跨币种必须提供明确汇率，同币种汇率只能为 1")
		}
		converted := new(big.Rat).Mul(source, rate)
		minor := new(big.Int).Quo(converted.Num(), converted.Denom())
		if !converted.IsInt() {
			minor.Add(minor, big.NewInt(1))
		}
		total.Add(total, minor)
		if total.Cmp(limit) > 0 {
			return nil, errors.New("成本合计超出上限")
		}
		cost.Amount = strings.TrimSpace(cost.Amount)
		if cost.ExchangeRate != nil {
			trimmed := strings.TrimSpace(*cost.ExchangeRate)
			cost.ExchangeRate = &trimmed
		}
	}
	rates := *data.TargetMarginBps
	for i := range data.Fees {
		fee := &data.Fees[i]
		fee.Name = strings.TrimSpace(fee.Name)
		if !pricingName(fee.Name) || !pricingBps(fee.RateBps) {
			return nil, errors.New("费用名称或基点无效")
		}
		rates += *fee.RateBps
	}
	if rates >= 10000 {
		return nil, errors.New("总费率与目标利润率必须低于 100%")
	}
	return json.Marshal(data)
}

func pricingNumber(raw string, digits int) *big.Rat {
	raw = strings.TrimSpace(raw)
	if len(raw) > 24 || !pricingDecimal.MatchString(raw) {
		return nil
	}
	if at := strings.IndexByte(raw, '.'); at >= 0 && len(raw)-at-1 > digits {
		return nil
	}
	value, _ := new(big.Rat).SetString(raw)
	return value
}

func pricingName(name string) bool      { return name != "" && utf8.RuneCountInString(name) <= 80 }
func pricingCurrency(value string) bool { return value == "CNY" || value == "RUB" }
func pricingBps(value *int64) bool      { return value != nil && *value >= 0 && *value < 10000 }
