package domain

import (
	"strings"

	"github.com/xxww0098/podhub-go/internal/store/contract"
)

const (
	// MaxAPIKey is the character ceiling for an Ozon Api-Key.
	MaxAPIKey = 512
	// FailureAuthRejected marks a probe Ozon answered "no" to.
	FailureAuthRejected = "seller_auth_rejected"
	// FailureRequestFailed marks a probe that never got an Ozon decision.
	FailureRequestFailed = "seller_request_failed"
)

// FailureCodes is the allowlist verification rows may carry. A free-form code
// would let a caller write provider text into durable state.
var FailureCodes = []string{FailureAuthRejected, FailureRequestFailed}

// NormalizeCredential trims and checks one Client ID / Api-Key pair. The
// ceiling counts characters, not bytes; the value keeps its case.
func NormalizeCredential(clientID, apiKey string) (string, string, *contract.APIError) {
	client := strings.TrimSpace(clientID)
	if client == "" {
		return "", "", contract.Validation(contract.MsgClientIDEmpty)
	}
	if len([]rune(client)) > MaxClientID {
		return "", "", contract.Validation(contract.MsgClientIDLong)
	}
	key := strings.TrimSpace(apiKey)
	if key == "" {
		return "", "", contract.Validation(contract.MsgAPIKeyEmpty)
	}
	if len([]rune(key)) > MaxAPIKey {
		return "", "", contract.Validation(contract.MsgAPIKeyLong)
	}
	return client, key, nil
}

// RegisterOutcome is one register-or-rotate decision: what the write produced
// and whether it changed anything a caller can observe.
type RegisterOutcome struct {
	// StoreUUID is the store the write touched.
	StoreUUID string
	// CredentialRevision is the generation now current.
	CredentialRevision int64
	// Revision is the roster row revision after the write.
	Revision int64
	// FingerprintChanged is false when the same pair was re-registered; the
	// write then touched nothing and the revisions stayed where they were.
	FingerprintChanged bool
	// Rotated is true when this replaced an existing generation.
	Rotated bool
}

// PlanRegister is credential_store::register's decision table. It answers the
// conflicts first — a verification is only ever recorded against a current
// generation — and otherwise says which revisions the write advances.
//
// existing is nil when the store holds no ciphertext for its current
// generation. expectedCredentialRevision is the caller's claim, nil for a
// first registration.
func PlanRegister(store Row, existing *ExistingCredential, samePair bool, expectedCredentialRevision *int64, nextClientID string) (RegisterOutcome, *contract.APIError) {
	switch {
	case existing == nil && expectedCredentialRevision != nil:
		return RegisterOutcome{}, contract.Conflict(contract.MsgKeyNotRegistered)
	case existing != nil && expectedCredentialRevision == nil:
		return RegisterOutcome{}, contract.Conflict(contract.MsgKeyRotateNeedsGen)
	case existing != nil && *expectedCredentialRevision != existing.CredentialRevision:
		return RegisterOutcome{}, contract.Conflict(contract.MsgKeyGenStale)
	case existing != nil && samePair:
		// The idempotent no-op: the same pair re-registered writes nothing so
		// the quota revision stays put, exactly as before the split.
		return RegisterOutcome{
			CredentialRevision: store.CredentialRevision,
			Revision:           store.Revision,
			FingerprintChanged: false,
			Rotated:            false,
		}, nil
	}
	rotate := existing != nil
	identityChanged := store.ClientID == nil || *store.ClientID != nextClientID
	nextCredentialRevision := store.CredentialRevision
	nextRevision := store.Revision
	switch {
	case rotate:
		nextCredentialRevision++
		nextRevision++
	case identityChanged:
		nextRevision++
	}
	return RegisterOutcome{
		CredentialRevision: nextCredentialRevision,
		Revision:           nextRevision,
		FingerprintChanged: true,
		Rotated:            rotate,
	}, nil
}

// ExistingCredential is the ciphertext row a store already holds.
type ExistingCredential struct {
	CredentialRevision int64
	Fingerprint        []byte
}

// NormalizeFailureCode trims and allowlists a verification failure code. An
// empty value is "no code". Matching is case-insensitive; the stored spelling
// is the allowlist's.
func NormalizeFailureCode(raw string) (string, *contract.APIError) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", nil
	}
	for _, allowed := range FailureCodes {
		if strings.EqualFold(trimmed, allowed) {
			return allowed, nil
		}
	}
	return "", contract.Validation(contract.MsgFailureCode)
}

// VerificationResult validates one verification outcome before it is stored:
// a success carries no failure code, a failure carries an allowlisted one.
func VerificationResult(verified bool, failureCode string) (string, *contract.APIError) {
	code, api := NormalizeFailureCode(failureCode)
	if api != nil {
		return "", api
	}
	if verified && code != "" {
		return "", contract.Validation(contract.MsgVerifiedWithFailure)
	}
	return code, nil
}

// VerificationSummary is one credential generation's verification tally.
type VerificationSummary struct {
	VerifiedOperators  int64
	LatestVerifiedAtMS *int64
}

// EnsureTestable is the shared gate register, test, and refresh answer before
// spending a Seller call: a disabled store is forbidden, a quota-suspended one
// is out of quota, and an expired key cannot be probed.
func EnsureTestable(row Row, nowMS int64) *contract.APIError {
	if row.ManualDisabled {
		return contract.Forbidden(contract.MsgStoreDisabled)
	}
	if row.QuotaSuspended {
		return contract.QuotaExhausted()
	}
	if row.CredentialKeyExpiresAtMS != nil && *row.CredentialKeyExpiresAtMS <= nowMS {
		return contract.CredentialExpired(contract.MsgKeyExpired)
	}
	return nil
}

// EnsureCanManageKey is ensure_can_manage_key: invisible is 404, visible but
// unauthorized is 403.
func EnsureCanManageKey(actor Actor, row Row) *contract.APIError {
	if !actor.Visible(row.AssigneeMembershipID) {
		return contract.NotFound(contract.MsgStoreMissing)
	}
	if actor.MayManageKey(row.AssigneeKeyManage, row.AssigneeMembershipID) {
		return nil
	}
	return contract.Forbidden(contract.MsgNoKeyPermission)
}

// EnsureCanTestKey is ensure_can_test_key: any caller who can see the store
// may spend a probe on it.
func EnsureCanTestKey(actor Actor, row Row) *contract.APIError {
	if !actor.Visible(row.AssigneeMembershipID) {
		return contract.NotFound(contract.MsgStoreMissing)
	}
	return nil
}

// ExportedCredential is one plaintext row of the export surface.
type ExportedCredential struct {
	UUID     string
	Name     string
	ClientID string
	APIKey   string
}

// OpenedCredential is one store's plaintext pair plus the generation it came
// from. It never reaches a response body except through the export surface.
type OpenedCredential struct {
	StoreID            int64
	UUID               string
	ClientID           string
	APIKey             string
	CredentialRevision int64
	KeyExpiresAtMS     *int64
}
