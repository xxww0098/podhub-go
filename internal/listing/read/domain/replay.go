package domain

import "encoding/json"

// Replay is one card_events page after the SQL, before row hydration.
type Replay struct {
	Missing  bool
	Head     int64
	Floor    int64
	Reset    bool
	Overflow bool
	Events   []ReplayItem
}

// ReplayItem is a sealed event the feed can emit without listing-core.
// Upsert is a row event that still has a row document. The feed must not
// invent that view; it resets instead.
type ReplayItem struct {
	Seq       int64
	Upsert    bool
	RemoveID  string
	Reason    string
	Template  string
	CardLevel bool
}

// ReadReplay classifies the card_events columns. eventsJSON is the aggregated
// batch. missing means the card row was absent.
func ReadReplay(missing bool, head, floor, after int64, eventsJSON []byte) (Replay, error) {
	page := ClassifyReplay(after, head, floor)
	out := Replay{Missing: missing, Head: head, Floor: floor, Reset: page.Reset || missing, Overflow: page.Overflow}
	if missing || out.Reset {
		return out, nil
	}
	if len(eventsJSON) == 0 {
		return out, nil
	}
	var batch []struct {
		Seq     int64           `json:"seq"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(eventsJSON, &batch); err != nil {
		return Replay{}, err
	}
	for _, item := range batch {
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(item.Payload, &payload); err != nil {
			return Replay{}, err
		}
		rowID, hasRow := payload["rowId"]
		if !hasRow || string(rowID) == "null" {
			reason, template, err := cardPayload(payload)
			if err != nil {
				return Replay{}, err
			}
			out.Events = append(out.Events, ReplayItem{
				Seq: item.Seq, Reason: reason, Template: template, CardLevel: true,
			})
			continue
		}
		var id string
		if err := json.Unmarshal(rowID, &id); err != nil || id == "" {
			return Replay{}, errString("event rowId")
		}
		removed := string(payload["removed"]) == "true"
		if removed {
			out.Events = append(out.Events, ReplayItem{Seq: item.Seq, RemoveID: id})
			continue
		}
		out.Events = append(out.Events, ReplayItem{Seq: item.Seq, Upsert: true, RemoveID: id})
	}
	return out, nil
}

func cardPayload(payload map[string]json.RawMessage) (string, string, error) {
	var reason, template string
	if err := json.Unmarshal(payload["reason"], &reason); err != nil || reason == "" {
		return "", "", errString("card event reason missing")
	}
	if err := json.Unmarshal(payload["psdTemplateSha256"], &template); err != nil {
		return "", "", errString("card event template missing")
	}
	return reason, template, nil
}

type errString string

func (e errString) Error() string { return string(e) }
