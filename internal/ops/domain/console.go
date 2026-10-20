package domain

import (
	"encoding/json"
	"math"
	"strings"
	"time"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
)

const (
	LedgerRowCap   = 2000
	MetricsFreshMS = 60_000
	ReconcileBatch = 32
	// LedgerSQL is the snapshot union. Unresolved states stay outside the NOT IN list.
	LedgerSQL = `
WITH ledger AS (
        SELECT 'listing' AS kind,
               CASE state
                   WHEN 'submitting' THEN 'dispatching'
                   WHEN 'unknown'    THEN 'result_unknown'
                   WHEN 'accepted'   THEN 'succeeded'
                   WHEN 'rejected'   THEN 'failed'
                   WHEN 'cancelled'  THEN 'failed'
                   ELSE state
               END AS status,
               created_at, updated_at
        FROM submission_intents
        WHERE org_id = $1
        UNION ALL
        SELECT 'write' AS kind,
               CASE state
                   WHEN 'settled' THEN 'succeeded'
                   ELSE state
               END AS status,
               created_at, updated_at
        FROM seller_upstream_writes
        WHERE org_id = $1
    ),
    ranked AS (
        SELECT kind, status, created_at, updated_at,
               ROW_NUMBER() OVER (ORDER BY updated_at DESC) AS rn
        FROM ledger
    )
    SELECT kind, status, created_at, updated_at
    FROM ranked
    WHERE rn <= $2
       OR status NOT IN ('queued', 'dispatching', 'succeeded', 'reconciled', 'operator_attested')
    ORDER BY updated_at DESC`
)

// StatusFromWire fails closed: a state neither table can produce is unknown.
func StatusFromWire(raw string) string {
	switch raw {
	case "queued", "recorded":
		return "queued"
	case "succeeded", "failed", "result_unknown", "reconciled", "conflict", "operator_attested", "dispatching":
		return raw
	default:
		return "unknown"
	}
}

func sameObservation(last []byte, summary string) bool {
	if len(last) == 0 {
		return false
	}
	var text string
	if json.Unmarshal(last, &text) == nil {
		return text == summary
	}
	return string(last) == summary
}

// MetricsRefreshDue is true when there is no row, the retry is due, and the last sync is stale.
func MetricsRefreshDue(lastSync, retry *int64, now int64) bool {
	if retry != nil && *retry > now {
		return false
	}
	if lastSync == nil {
		return true
	}
	return now-*lastSync >= MetricsFreshMS
}

type ConsoleSnapshot struct {
	Ordered float64
	Days    []float64
	Through string
	SyncMS  int64
}

// Validated refuses a series that is not exactly 30 non-negative days.
func Validated(s ConsoleSnapshot) bool {
	if s.Ordered < 0 || math.IsNaN(s.Ordered) || math.IsInf(s.Ordered, 0) {
		return false
	}
	if len(s.Days) != 30 || strings.TrimSpace(s.Through) == "" || s.SyncMS <= 0 {
		return false
	}
	for _, d := range s.Days {
		if d < 0 || math.IsNaN(d) || math.IsInf(d, 0) {
			return false
		}
	}
	return true
}

// Refreshable is a configured store whose cloud status is active.
func Refreshable(configured bool, cloudStatus string) bool {
	return configured && cloudStatus == "active"
}

type ProbeVerdict struct {
	State   string
	Code    string
	Summary string
}

// Decide maps an observation onto the ledger. Applied reconciles immediately.
// AppliedByAbsence and Contradicted need a previous identical observation.
func Decide(kind string, passes int, last []byte, summary string) ProbeVerdict {
	same := sameObservation(last, summary)
	switch kind {
	case "applied":
		return ProbeVerdict{State: "reconciled", Summary: summary}
	case "applied_by_absence":
		if passes > 0 && same {
			return ProbeVerdict{State: "reconciled", Summary: summary}
		}
		return ProbeVerdict{State: "result_unknown", Code: contract.ProbeUnknown, Summary: summary}
	case "contradicted":
		if passes > 0 && same {
			return ProbeVerdict{State: "conflict", Code: contract.ProbeConflict, Summary: summary}
		}
		return ProbeVerdict{State: "result_unknown", Code: contract.ProbeUnknown, Summary: summary}
	default:
		return ProbeVerdict{State: "result_unknown", Code: contract.ProbeUnknown, Summary: summary}
	}
}

// SnapshotJSON is the console overview. active_id is null. Secrets are absent.
func SnapshotJSON(meta contract.RosterMeta, heads []contract.StoreHead, ledger []contract.LedgerEntry, metrics []contract.MetricRow, products []contract.ProductRow) json.RawMessage {
	type store struct {
		ID                    string `json:"id"`
		RefID                 string `json:"ref_id"`
		Name                  string `json:"name"`
		CreateOrder           int64  `json:"create_order"`
		ClientID              string `json:"client_id"`
		CloudStatus           string `json:"cloud_status"`
		SecretStatus          string `json:"secret_status"`
		CanManage             bool   `json:"can_manage"`
		Active                bool   `json:"active"`
		NeedsReentry          bool   `json:"needs_reentry"`
		WatermarkName         string `json:"watermark_name"`
		AdvertisingClientID   string `json:"advertising_client_id"`
		AdvertisingConfigured bool   `json:"advertising_configured"`
		UpdatedAtMS           int64  `json:"updated_at_ms"`
		AssigneeMembershipID  *int64 `json:"assignee_membership_id,omitempty"`
		AssigneeName          string `json:"assignee_name,omitempty"`
		AssigneeEmail         string `json:"assignee_email,omitempty"`
	}
	stores := make([]store, 0, len(heads))
	for _, h := range heads {
		status := "active"
		switch {
		case h.QuotaSuspended:
			status = "quota_suspended"
		case h.ManualDisabled:
			status = "manual_disabled"
		}
		secret := "absent"
		if h.Configured {
			secret = "present"
		}
		stores = append(stores, store{
			ID: h.UUID, RefID: h.UUID, Name: h.Name, CreateOrder: h.CreateOrder, ClientID: h.ClientID,
			CloudStatus: status, SecretStatus: secret, CanManage: h.CanManage,
			AssigneeMembershipID: h.AssigneeID, AssigneeName: h.AssigneeName, AssigneeEmail: h.AssigneeEmail,
		})
	}
	type led struct {
		Kind      string `json:"kind"`
		Status    string `json:"status"`
		CreatedMS int64  `json:"created_at_ms"`
		UpdatedMS int64  `json:"updated_at_ms"`
	}
	rows := make([]led, 0, len(ledger))
	for _, e := range ledger {
		kind := "write"
		if e.Kind == "listing" {
			kind = "listing"
		}
		rows = append(rows, led{Kind: kind, Status: StatusFromWire(e.Status), CreatedMS: e.CreatedMS, UpdatedMS: e.UpdatedMS})
	}
	if metrics == nil {
		metrics = []contract.MetricRow{}
	}
	if products == nil {
		products = []contract.ProductRow{}
	}
	raw, err := compact(struct {
		Roster struct {
			Stores     []store `json:"stores"`
			ActiveID   *string `json:"active_id"`
			StoreLimit int64   `json:"store_limit"`
			StoresUsed int64   `json:"stores_used"`
			Suspended  int64   `json:"suspended"`
		} `json:"roster"`
		Ledger   []led                 `json:"ledger"`
		Metrics  []contract.MetricRow  `json:"metrics"`
		Products []contract.ProductRow `json:"products"`
	}{
		Roster: struct {
			Stores     []store `json:"stores"`
			ActiveID   *string `json:"active_id"`
			StoreLimit int64   `json:"store_limit"`
			StoresUsed int64   `json:"stores_used"`
			Suspended  int64   `json:"suspended"`
		}{Stores: stores, StoreLimit: meta.StoreLimit, StoresUsed: meta.StoresUsed, Suspended: meta.Suspended},
		Ledger: rows, Metrics: metrics, Products: products,
	})
	if err != nil {
		return []byte(`{}`)
	}
	return raw
}

// DayWindow is [through-(days-1), through] in UTC, YYYY-MM-DD.
func DayWindow(now time.Time, days int) (from, through string) {
	end := now.UTC()
	through = end.Format("2006-01-02")
	from = end.AddDate(0, 0, -(days - 1)).Format("2006-01-02")
	return from, through
}
