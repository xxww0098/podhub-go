package contract

import (
	"encoding/json"
	"strings"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	"github.com/xxww0098/podhub-go/internal/admin/core/contract/outcome"
)

// NormalizedDb is an upsert body after trim and bounds checks.
// KeepViewPrefs is set when an update sent JSON null for viewPrefs.
type NormalizedDb struct {
	Name            string
	Country         string
	Contact         string
	InternalNote    string
	Icon            string
	Listed          bool
	AcceptsDelegate bool
	ViewPrefs       json.RawMessage
	KeepViewPrefs   bool
	Template        string
	AccountEmail    *string
}

// PropSeed is one factory attribute inserted with the new source.
type PropSeed struct {
	PropID        string
	Name          string
	Type          string
	Options       json.RawMessage
	Position      int64
	SellerVisible bool
}

// PropOption is one select choice. JSON field order is value then label.
type PropOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

// NormalizedProp is a property upsert. Position nil means auto on create
// and keep-current on update.
type NormalizedProp struct {
	Name          string
	Type          string
	Options       []PropOption
	Position      *int64
	SellerVisible bool
}

// OptionsJSON encodes choices with value before label.
func OptionsJSON(options []PropOption) json.RawMessage {
	if options == nil {
		options = []PropOption{}
	}
	return json.RawMessage(corecontract.JSONText(options))
}

// Withdrawal is SupplierWithdrawalView. Blank optional fields are omitted.
type Withdrawal struct {
	WithdrawalID  string `json:"withdrawalId"`
	SourceID      string `json:"sourceId"`
	Name          string `json:"name"`
	AmountCents   int64  `json:"amountCents"`
	Channel       string `json:"channel"`
	Account       string `json:"account"`
	RealName      string `json:"realName"`
	Status        string `json:"status"`
	Reference     string `json:"reference,omitempty"`
	RejectReason  string `json:"rejectReason,omitempty"`
	RequestedAtMs int64  `json:"requestedAtMs"`
	DecidedAtMs   *int64 `json:"decidedAtMs,omitempty"`
}

// Bounded trims and checks a 1..max rune length.
func Bounded(raw string, max int, message string) (string, error) {
	value := strings.TrimSpace(raw)
	n := 0
	for range value {
		n++
	}
	if n < 1 || n > max {
		return "", &outcome.Fail{Kind: outcome.KindValidation, Message: message}
	}
	return value, nil
}

// SourceRef is SellerSupplierDbData.
type SourceRef struct {
	SourceID string `json:"sourceId"`
	Name     string `json:"name"`
	Country  string `json:"country"`
	Icon     string `json:"icon"`
}

// Member is one supplier account. Name is omitted when blank.
type Member struct {
	MemberID    string    `json:"memberId"`
	Source      SourceRef `json:"source"`
	Email       string    `json:"email"`
	Name        *string   `json:"name,omitempty"`
	Status      string    `json:"status"`
	CreatedAtMs int64     `json:"createdAtMs"`
}

// AccountGroup is one factory and its members, in SQL order.
type AccountGroup struct {
	Source  SourceRef `json:"source"`
	Members []Member  `json:"members"`
}

// GroupAccounts keeps adjacent rows that share a source id together.
func GroupAccounts(rows []Member) []AccountGroup {
	if rows == nil {
		rows = []Member{}
	}
	var groups []AccountGroup
	for _, row := range rows {
		if n := len(groups); n > 0 && groups[n-1].Source.SourceID == row.Source.SourceID {
			groups[n-1].Members = append(groups[n-1].Members, row)
			continue
		}
		groups = append(groups, AccountGroup{Source: row.Source, Members: []Member{row}})
	}
	if groups == nil {
		groups = []AccountGroup{}
	}
	return groups
}

// NormalizedAccount is a create-account body.
type NormalizedAccount struct {
	SourceID string
	Email    string
	Name     *string
	Password *string
}

// AccountPatch is a status and/or password change.
type AccountPatch struct {
	Status   *string
	Password *string
}
