package domain

import (
	"strings"
	"unicode/utf8"
)

// Card event channel shared with seal_listing_row_events' pg_notify.
const CardEventChannel = "listing_card_events"

// Stream batch, retention, and live buffer from kernel/stream.rs.
const (
	StreamBatch          int64 = 32
	StreamRetainedEvents int64 = 10_000
	StreamLiveBuffer     int64 = 64
	MaxWatchedCards            = 128
)

// SSEKeepAlive is axum KeepAlive::new().interval(15s). The comment body is "ping".
const SSEKeepAlive = ": ping\n\n"

// WatchedCard is one `cards` query item, id and the last seq the client has.
type WatchedCard struct {
	ID  string
	Seq int64
}

// WatchCards parses `cards=id:seq,id:seq`. A single card's Last-Event-ID
// replaces that card's seq. Messages match stream.rs tests.
func WatchCards(query string, lastEventID string) ([]WatchedCard, string) {
	var cards []WatchedCard
	for _, item := range strings.Split(query, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		id, seqText, ok := strings.Cut(item, ":")
		if !ok || id == "" {
			return nil, "无效的事件游标"
		}
		seq, ok := parseNonNeg(seqText)
		if !ok {
			return nil, "无效的事件游标"
		}
		for _, existing := range cards {
			if existing.ID == id {
				return nil, "重复的卡片"
			}
		}
		cards = append(cards, WatchedCard{ID: id, Seq: seq})
	}
	if len(cards) == 0 {
		return nil, "缺少卡片游标"
	}
	if len(cards) > MaxWatchedCards {
		return nil, "打开的卡片过多"
	}
	if len(cards) == 1 && strings.TrimSpace(lastEventID) != "" {
		seq, ok := parseNonNeg(strings.TrimSpace(lastEventID))
		if !ok {
			return nil, "无效的事件游标"
		}
		cards[0].Seq = seq
	}
	return cards, ""
}

func parseNonNeg(raw string) (int64, bool) {
	if raw == "" {
		return 0, false
	}
	var n int64
	for _, r := range raw {
		if r < '0' || r > '9' {
			return 0, false
		}
		n = n*10 + int64(r-'0')
	}
	return n, true
}

// ParseCardHint splits `card seq` from pg_notify. Empty card or a bad seq is absent.
func ParseCardHint(payload string) (card string, seq int64, ok bool) {
	card, seqText, found := strings.Cut(payload, " ")
	if !found || card == "" {
		return "", 0, false
	}
	seq, ok = parseNonNeg(seqText)
	if !ok {
		return "", 0, false
	}
	return card, seq, true
}

// EventPage is the reset/overflow decision in card_events, without hydration.
type EventPage struct {
	Reset    bool
	Overflow bool
}

// ClassifyReplay matches card_events: stale when the cursor is past the head
// or behind the retained floor, overflow when the gap exceeds the live buffer.
func ClassifyReplay(after, head, floor int64) EventPage {
	stale := after > head || after < floor-1
	gap := head - after
	if after > head {
		gap = 0
	}
	overflow := !stale && gap > StreamLiveBuffer
	return EventPage{Reset: stale || overflow, Overflow: overflow}
}

// UUIDText reports whether id is a canonical or unhyphenated uuid. Card event
// filters compare the id as uuid, so a bad id must not reach the statement.
func UUIDText(id string) bool {
	hex := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(id)), "-", "")
	if len(hex) != 32 {
		return false
	}
	for _, r := range hex {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return utf8.ValidString(id)
}
