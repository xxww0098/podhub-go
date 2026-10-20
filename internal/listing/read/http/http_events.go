package readhttp

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

// SSEAuthRecheck is the session recheck period from stream.rs.
const SSEAuthRecheck = 30 * time.Second

// SSEIdle is the keep-alive interval. Rust's SSE_IDLE_POLL_SECS was not in
// the files read for this port; the axum keep-alive is 15s, and this feed
// uses that same interval for the idle poll. See docs/parity/listing-write-parity.md.
const SSEIdle = 15 * time.Second

func (h Host) events(w http.ResponseWriter, r *http.Request) {
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	cards, message := WatchCards(r.URL.Query().Get("cards"), r.Header.Get("Last-Event-ID"))
	if message != "" {
		writeErr(w, http.StatusBadRequest, message, "validation")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	flush := func() {
		if flusher != nil {
			flusher.Flush()
		}
	}
	flush()
	after := map[string]int64{}
	for _, card := range cards {
		after[card.ID] = card.Seq
	}
	authed := time.Now()
	var listen *pgxpool.Conn
	if h.Pool != nil {
		conn, err := h.Pool.Acquire(r.Context())
		if err == nil {
			if _, err := conn.Exec(r.Context(), "LISTEN "+CardEventChannel); err != nil {
				conn.Release()
			} else {
				listen = conn
				defer func() {
					_, _ = listen.Exec(context.Background(), "UNLISTEN "+CardEventChannel)
					listen.Release()
				}()
			}
		}
	}
	for {
		if time.Since(authed) >= SSEAuthRecheck {
			if !h.stillListing(r) {
				data, _ := ResetData(p.OrgID, cards[0].ID, "permission_changed")
				_, _ = w.Write([]byte(FormatSSE("", "reset", data)))
				flush()
				return
			}
			authed = time.Now()
		}
		for _, card := range cards {
			if h.emitCard(w, r, p.OrgID, card.ID, after, flush) {
				return
			}
		}
		waitCtx, cancel := context.WithTimeout(r.Context(), SSEIdle)
		notified := false
		if listen != nil {
			_, err := listen.Conn().WaitForNotification(waitCtx)
			notified = err == nil
		} else {
			<-waitCtx.Done()
		}
		cancel()
		if r.Context().Err() != nil {
			return
		}
		if !notified {
			if _, err := w.Write([]byte(SSEKeepAlive)); err != nil {
				return
			}
			flush()
		}
	}
}

func (h Host) stillListing(r *http.Request) bool {
	if h.Access == nil {
		return false
	}
	p, refusal, err := h.Access.Resolve(r)
	if err != nil || refusal != nil || p == nil {
		return false
	}
	_, _, ok := access.ListingPrepare(*p)
	return ok
}

// emitCard writes the next frames for one card. true means the feed closed.
func (h Host) emitCard(w http.ResponseWriter, r *http.Request, org int64, id string, after map[string]int64, flush func()) bool {
	var page Replay
	err := h.withOrg(r.Context(), org, func(tx pgx.Tx) error {
		var head, floor int64
		var events []byte
		err := tx.QueryRow(r.Context(), `
			WITH head AS (
				SELECT COALESCE((SELECT seq FROM listing_card_cursors
					WHERE org_id = $1 AND card_id = $2::uuid), 0) AS seq
				FROM listing_cards WHERE org_id = $1 AND id = $2::uuid
			), retained AS (
				SELECT stream_seq AS seq, payload FROM listing_row_events, head
				WHERE org_id = $1 AND stream_card_id = $2::uuid
				  AND stream_seq > head.seq - $5
				  AND created_at >= clock_timestamp() - interval '24 hours'
			)
			SELECT head.seq,
			       COALESCE((SELECT min(seq) FROM retained), head.seq + 1),
			       COALESCE((SELECT jsonb_agg(batch ORDER BY seq) FROM (
			         SELECT seq, payload FROM retained WHERE seq > $3 ORDER BY seq LIMIT $4
			       ) batch), '[]'::jsonb)
			FROM head`, org, id, after[id], StreamBatch, StreamRetainedEvents).Scan(&head, &floor, &events)
		if errors.Is(err, pgx.ErrNoRows) {
			page = Replay{Missing: true, Reset: true}
			return nil
		}
		if err != nil {
			return err
		}
		page, err = ReadReplay(false, head, floor, after[id], events)
		return err
	})
	if err != nil || page.Missing || page.Reset {
		reason := "snapshot_required"
		name := "reset"
		if err == nil && page.Overflow {
			name = "resync_required"
			reason = "resync_required"
		}
		data, encErr := ResetData(org, id, reason)
		if encErr != nil {
			return true
		}
		if _, werr := w.Write([]byte(FormatSSE("", name, data))); werr != nil {
			return true
		}
		flush()
		return true
	}
	cursor := after[id]
	for _, event := range page.Events {
		if event.Seq != cursor+1 {
			data, _ := ResetData(org, id, "sequence_gap")
			_, _ = w.Write([]byte(FormatSSE("", "reset", data)))
			flush()
			return true
		}
		if event.Upsert {
			data, _ := ResetData(org, id, "snapshot_required")
			_, _ = w.Write([]byte(FormatSSE("", "reset", data)))
			flush()
			return true
		}
		var data []byte
		var name string
		var encErr error
		if event.CardLevel {
			name = "card.invalidate"
			data, encErr = CardInvalidateData(org, id, event.Reason, event.Template, event.Seq)
		} else {
			name = "row.remove"
			data, encErr = RowRemoveData(org, id, event.RemoveID, event.Seq)
		}
		if encErr != nil {
			return true
		}
		if _, werr := w.Write([]byte(FormatSSE(strconv.FormatInt(event.Seq, 10), name, data))); werr != nil {
			return true
		}
		flush()
		cursor = event.Seq
		after[id] = cursor
	}
	return false
}
