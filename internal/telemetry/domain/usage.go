package domain

import (
	"encoding/json"
	"fmt"
	"math"
	"time"
)

const gib int64 = 1_073_741_824

// S3BytesForStores is s3_bytes_for_stores: stores * (29 * GiB / 2).
func S3BytesForStores(stores int64) int64 {
	if stores <= 0 {
		return 0
	}
	per := 29 * gib / 2
	if stores > math.MaxInt64/per {
		return math.MaxInt64
	}
	return stores * per
}

// Billable is one billable_usage_events input. EventID is device_uid + ":" + item id.
type Billable struct {
	EventID      string
	Metric       string
	Unit         string
	Quantity     int64
	Source       string
	Verification string
	Provider     string
	Model        string
	ResourceID   string
	Details      string
	OccurredAtMs int64
	Period       string
}

// BillableInputs returns usage rows for an accepted inbox event. Non-billing kinds return nil.
func BillableInputs(deviceUID string, ev AcceptedEvent) ([]Billable, error) {
	eventID := deviceUID + ":" + ev.ID
	switch ev.Kind {
	case "billing.ai-token-usage.v1":
		var body struct {
			Provider     string `json:"provider"`
			Model        string `json:"model"`
			InputTokens  int64  `json:"inputTokens"`
			OutputTokens int64  `json:"outputTokens"`
			TotalTokens  int64  `json:"totalTokens"`
			OccurredAt   string `json:"occurredAt"`
			ResponseID   string `json:"responseId"`
		}
		if err := json.Unmarshal([]byte(ev.Payload), &body); err != nil {
			return nil, err
		}
		when, err := parseTime(body.OccurredAt)
		if err != nil {
			return nil, err
		}
		ms := when.UnixMilli()
		period := when.UTC().Format("2006-01")
		details, err := compactJSON(map[string]int64{"totalTokens": body.TotalTokens})
		if err != nil {
			return nil, err
		}
		base := Billable{
			EventID: eventID, Unit: "token", Source: "desktop.host.model-response",
			Verification: "reported", Provider: body.Provider, Model: body.Model,
			ResourceID: body.ResponseID, Details: details, OccurredAtMs: ms, Period: period,
		}
		in := base
		in.Metric = "ai.input_tokens"
		in.Quantity = body.InputTokens
		out := base
		out.Metric = "ai.output_tokens"
		out.Quantity = body.OutputTokens
		return []Billable{in, out}, nil
	case "billing.object-upload-usage.v1":
		var body struct {
			Bytes       int64  `json:"bytes"`
			OccurredAt  string `json:"occurredAt"`
			ObjectKey   string `json:"objectKey"`
			ContentHash string `json:"contentHash"`
			Outcome     string `json:"outcome"`
		}
		if err := json.Unmarshal([]byte(ev.Payload), &body); err != nil {
			return nil, err
		}
		when, err := parseTime(body.OccurredAt)
		if err != nil {
			return nil, err
		}
		details, err := compactJSON(struct {
			ContentHash string `json:"contentHash"`
			Outcome     string `json:"outcome"`
		}{body.ContentHash, body.Outcome})
		if err != nil {
			return nil, err
		}
		return []Billable{{
			EventID: eventID, Metric: "traffic.user_to_s3_bytes", Unit: "byte",
			Quantity: body.Bytes, Source: "desktop.host.upload-response", Verification: "reported",
			ResourceID: body.ObjectKey, Details: details, OccurredAtMs: when.UnixMilli(),
			Period: when.UTC().Format("2006-01"),
		}}, nil
	default:
		return nil, nil
	}
}

// QuotaMessage is the per-item rejection when S3 bytes would pass the monthly limit.
func QuotaMessage(used, limit int64) string {
	return fmt.Sprintf("工作空间上行流量已用尽（%d/%d 字节）", used, limit)
}

// BillingPeriodUTC is YYYY-MM in UTC. A zero time becomes 1970-01.
func BillingPeriodUTC(ms int64) string {
	if ms == 0 {
		return time.UnixMilli(0).UTC().Format("2006-01")
	}
	return time.UnixMilli(ms).UTC().Format("2006-01")
}
