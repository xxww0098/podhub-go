// Package domain is the pure store-name and company-group rules.
//
// Seller info keeps company.name, company.legal_name, company.currency,
// company.country, and subscription. Tax identifiers, ownership form, tax
// system, and ratings are not represented here, so they cannot be stored,
// logged, or returned by a caller that only keeps this value.
package domain

import (
	"encoding/json"
	"sort"
	"strings"
	"time"
)

const (
	// SourceAuto is the name_source of a store whose display name may be replaced.
	SourceAuto = "auto"
	// SourceManual is the name_source after a person renames the store.
	SourceManual = "manual"
	// Unclassified is the group for a blank company.legal_name.
	Unclassified = "未分类"

	maxStoreName = 255
	maxLegalName = 512
	maxCurrency  = 8
	maxCountry   = 8
	maxSubType   = 32

	// KeyValid means POST /v1/seller/info returned a 2xx.
	KeyValid = "valid"
	// KeyInvalid means the seller rejected the credential.
	KeyInvalid = "invalid"
	// KeyUnknown means the call did not produce a seller decision.
	KeyUnknown = "unknown"

	// Reason401 is an HTTP 401 from seller info.
	Reason401 = "401"
	// Reason403 is an HTTP 403 from seller info.
	Reason403 = "403"
	// Reason404 is an HTTP 404 from seller info.
	Reason404 = "404"
	// ReasonNetwork is a dial or transport failure.
	ReasonNetwork = "network"
	// ReasonUpstream is another non-2xx seller status.
	ReasonUpstream = "upstream"
	// ReasonUnparsed is a 2xx body that is not a JSON object.
	ReasonUnparsed = "unparsed"
)

// Company is the slice of /v1/seller/info this process keeps.
// ShortName is company.name. LegalName is company.legal_name.
// Currency is company.currency. Country is company.country.
// Premium is subscription.is_premium. SubType is subscription.type.
type Company struct {
	ShortName string
	LegalName string
	Currency  string
	Country   string
	Premium   *bool
	SubType   string
}

// Patch writes company columns. A nil pointer leaves the column.
// Name is set only when the fill rule replaces the display name.
// TouchSynced sets seller_info_synced_at to the database clock.
type Patch struct {
	Short       *string
	Legal       *string
	Name        *string
	Currency    *string
	Country     *string
	Premium     *bool
	SubType     *string
	TouchSynced bool
	KeyStatus   *string
	KeyReason   *string
}

// Store is one live organization_stores row the group and fill rules see.
type Store struct {
	UUID            string
	Name            string
	ShortName       string
	LegalName       string
	Source          string
	CreateOrder     int64
	Assignee        *int64
	Currency        string
	Country         string
	Premium         *bool
	SubType         string
	SyncedAt        *time.Time
	KeyStatus       string
	KeyReason       string
	PricingCurrency string
}

// Group is one company.legal_name bucket inside a single org.
type Group struct {
	Name   string
	Stores []Store
}

// ParseSellerInfo reads the seller-info fields this process keeps.
// A missing company object, a null, or a non-string field is empty.
// Invalid JSON returns ok false. It does not panic, and it does not copy
// company.inn, company.ogrn, company.tax_system, company.ownership_form,
// or ratings into the result.
func ParseSellerInfo(body []byte) (Company, bool) {
	if len(bytesTrimSpace(body)) == 0 {
		return Company{}, false
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(body, &root); err != nil || root == nil {
		return Company{}, false
	}
	out := Company{}
	if raw, ok := root["company"]; ok && len(raw) > 0 && string(raw) != "null" {
		var company map[string]json.RawMessage
		if err := json.Unmarshal(raw, &company); err == nil && company != nil {
			out.ShortName = jsonString(company["name"])
			out.LegalName = jsonString(company["legal_name"])
			out.Currency = jsonString(company["currency"])
			out.Country = jsonString(company["country"])
		}
	}
	if raw, ok := root["subscription"]; ok && len(raw) > 0 && string(raw) != "null" {
		var sub map[string]json.RawMessage
		if err := json.Unmarshal(raw, &sub); err == nil && sub != nil {
			if premium, ok := jsonBool(sub["is_premium"]); ok {
				out.Premium = &premium
			}
			out.SubType = jsonString(sub["type"])
		}
	}
	return out, true
}

func jsonBool(raw json.RawMessage) (bool, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return false, false
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, false
	}
	return value, true
}

// ClassifySellerCall maps one seller-info round trip to a stored status.
// A transport error is unknown/network. 401, 403, and 404 are invalid.
// Any other non-2xx is unknown/upstream. A 2xx is valid.
// The reason is a category, never a body or a credential.
func ClassifySellerCall(status int, callErr error, parsed bool) (state, reason string) {
	if callErr != nil {
		return KeyUnknown, ReasonNetwork
	}
	switch status {
	case 401:
		return KeyInvalid, Reason401
	case 403:
		return KeyInvalid, Reason403
	case 404:
		return KeyInvalid, Reason404
	}
	if status < 200 || status >= 300 {
		return KeyUnknown, ReasonUpstream
	}
	if !parsed {
		return KeyValid, ReasonUnparsed
	}
	return KeyValid, ""
}

// CurrencyWarning is empty when either side is blank or they match,
// ignoring case. Otherwise it names both currencies.
func CurrencyWarning(company, pricing string) string {
	company = strings.ToUpper(strings.TrimSpace(company))
	pricing = strings.ToUpper(strings.TrimSpace(pricing))
	if company == "" || pricing == "" || company == pricing {
		return ""
	}
	return "公司币种 " + company + " 与店铺定价币种 " + pricing + " 不一致"
}

func jsonString(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return ""
	}
	return strings.TrimSpace(text)
}

func bytesTrimSpace(body []byte) []byte {
	return []byte(strings.TrimSpace(string(body)))
}

// FillName reports the next display name.
// A manual source is never replaced. An empty name or source auto takes the
// short name when that short name fits the store name column.
func FillName(current, source, short string) (string, bool) {
	short = strings.TrimSpace(short)
	if short == "" || len([]rune(short)) > maxStoreName {
		return current, false
	}
	if source == SourceManual {
		return current, false
	}
	if strings.TrimSpace(current) == "" || source == SourceAuto || source == "" {
		return short, true
	}
	return current, false
}

// KeepShort is the company_short_name to write, or "" when the value must stay.
func KeepShort(short string) string {
	short = strings.TrimSpace(short)
	if short == "" || len([]rune(short)) > maxStoreName {
		return ""
	}
	return short
}

// KeepLegal is the company_legal_name to write, or "" when the value must stay.
func KeepLegal(legal string) string {
	legal = strings.TrimSpace(legal)
	if legal == "" || len([]rune(legal)) > maxLegalName {
		return ""
	}
	return legal
}

// KeepCurrency is the company_currency to write, or "" when the value must stay.
func KeepCurrency(currency string) string {
	return keepCode(currency, maxCurrency)
}

// KeepCountry is the company_country to write, or "" when the value must stay.
func KeepCountry(country string) string {
	return keepCode(country, maxCountry)
}

// KeepSubType is the subscription_type to write, or "" when the value must stay.
func KeepSubType(subType string) string {
	return keepCode(subType, maxSubType)
}

func keepCode(value string, max int) string {
	value = strings.TrimSpace(value)
	if value == "" || len([]rune(value)) > max {
		return ""
	}
	return value
}

// ValidName is a trimmed display name that fits the column.
func ValidName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errName
	}
	if len([]rune(name)) > maxStoreName {
		return "", errNameLength
	}
	return name, nil
}

// Sentinel errors live in this file so domain stays free of the contract
// package's identity. The service maps them.
var (
	errName       = errString("store name is empty")
	errNameLength = errString("store name is too long")
)

type errString string

func (e errString) Error() string { return string(e) }

// NameEmpty reports ValidName's empty result.
func NameEmpty(err error) bool { return err == errName }

// NameTooLong reports ValidName's length result.
func NameTooLong(err error) bool { return err == errNameLength }

// GroupByLegalName buckets stores by trimmed legal name.
// A blank legal name is 未分类, and that group is last.
// Stores inside a group keep create_order, then uuid.
func GroupByLegalName(rows []Store) []Group {
	buckets := map[string][]Store{}
	for _, row := range rows {
		key := strings.TrimSpace(row.LegalName)
		if key == "" {
			key = Unclassified
		}
		buckets[key] = append(buckets[key], row)
	}
	names := make([]string, 0, len(buckets))
	for name := range buckets {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool {
		if names[i] == Unclassified {
			return false
		}
		if names[j] == Unclassified {
			return true
		}
		return names[i] < names[j]
	})
	out := make([]Group, 0, len(names))
	for _, name := range names {
		stores := buckets[name]
		sort.Slice(stores, func(i, j int) bool {
			if stores[i].CreateOrder != stores[j].CreateOrder {
				return stores[i].CreateOrder < stores[j].CreateOrder
			}
			return stores[i].UUID < stores[j].UUID
		})
		out = append(out, Group{Name: name, Stores: stores})
	}
	return out
}
