// Package writer is write_under_authority's fence check from src/writer.rs
// (Rust v0.0.112). Every write domain calls Assert. The Chinese 503 text
// stays at the call site; this package only decides and heartbeats.
package writer

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/config"
)

const (
	// LeaseTTLMS is LEASE_TTL_MS.
	LeaseTTLMS int64 = 60_000
	// HolderAxum is HOLDER_AXUM. This process never presents hono.
	HolderAxum = "axum"
	// DomainAuth is CapabilityDomain::Auth.
	DomainAuth = "auth"
	// AuthGateKey is the shared advisory lock taken only for Auth writes.
	AuthGateKey int64 = 0x6f7a6f6e5f617574
)

// Identity is WriterIdentity. Holder is axum. InstanceID is CLOUD_INSTANCE_ID.
type Identity struct {
	Holder     string
	InstanceID string
}

// ProcessIdentity is WriterIdentity::axum_from_env. The instance string is
// read only through platform/config.
func ProcessIdentity() Identity {
	return Identity{Holder: HolderAxum, InstanceID: config.Load().WriterInstanceID()}
}

// Held is the lease stamped onto audit rows. Both pointers are nil when the
// domain has never been leased.
type Held struct {
	ID    *int64
	Fence *int64
}

// Active is the unrevoked row, if any, plus whether the domain was ever leased.
type Active struct {
	Present     bool
	Ever        bool
	ID          int64
	Holder      string
	Instance    string
	Fence       int64
	ExpiresAt   int64
	HeartbeatAt int64
}

// DisabledError is WriteGateError::Disabled. Message is the call-site text.
type DisabledError struct {
	Message string
}

func (e *DisabledError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

// IsDisabled reports a fence refusal.
func IsDisabled(err error) bool {
	var d *DisabledError
	return errors.As(err, &d)
}

// Decide is assert_authority without SQL. nowMS below zero is clamped to 0,
// matching now_ms on a clock before the unix epoch. A live matching row is
// allowed and must be heartbeated; every other state is refused.
//
// Rust X3-B allowed a domain that had never been leased. That let Go and
// Rust both write while writer_leases was empty. An absent row is now
// refused. Bootstrap inserts the first row; Decide does not.
func Decide(row Active, id Identity, nowMS int64) (Held, bool) {
	if nowMS < 0 {
		nowMS = 0
	}
	if !row.Present {
		return Held{}, false
	}
	if row.ExpiresAt <= nowMS || row.HeartbeatAt+LeaseTTLMS <= nowMS {
		return Held{}, false
	}
	if row.Holder != id.Holder || row.Instance != id.InstanceID {
		return Held{}, false
	}
	leaseID := row.ID
	fence := row.Fence
	return Held{ID: &leaseID, Fence: &fence}, true
}

// Assert is assert_authority plus refresh_heartbeat. Auth takes the shared
// advisory lock first. SQL order is FOR UPDATE, then EXISTS, then the
// heartbeat UPDATE when the row is ours. nowMS is used for both the expiry
// comparison and the heartbeat so a test clock does not move between them.
func Assert(ctx context.Context, tx pgx.Tx, domain string, id Identity, nowMS int64, disabledMessage string) (Held, error) {
	if domain == DomainAuth {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared($1)`, AuthGateKey); err != nil {
			return Held{}, err
		}
	}
	if nowMS < 0 {
		nowMS = 0
	}
	var row Active
	err := tx.QueryRow(ctx, `
SELECT id, holder, holder_instance, fence_token, expires_at_ms, heartbeat_at_ms
  FROM writer_leases
 WHERE domain = $1 AND revoked_at_ms IS NULL
 FOR UPDATE`, domain).Scan(&row.ID, &row.Holder, &row.Instance, &row.Fence, &row.ExpiresAt, &row.HeartbeatAt)
	if err == nil {
		row.Present = true
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return Held{}, err
	}
	if err := tx.QueryRow(ctx, `
SELECT EXISTS(SELECT 1 FROM writer_leases WHERE domain = $1)`, domain).Scan(&row.Ever); err != nil {
		return Held{}, err
	}
	held, allow := Decide(row, id, nowMS)
	if !allow {
		return Held{}, &DisabledError{Message: disabledMessage}
	}
	if held.ID != nil {
		tag, err := tx.Exec(ctx, `
UPDATE writer_leases
   SET heartbeat_at_ms = $2::bigint,
       expires_at_ms = $2::bigint + $3::bigint
 WHERE id = $1
   AND revoked_at_ms IS NULL`, *held.ID, nowMS, LeaseTTLMS)
		if err != nil {
			return Held{}, err
		}
		if tag.RowsAffected() != 1 {
			return Held{}, fmt.Errorf("writer lease %d heartbeat updated %d rows", *held.ID, tag.RowsAffected())
		}
	}
	remember(tx, held)
	return held, nil
}

// Recall is the lease Assert stored for this transaction. A missing entry
// means the write ran with no live lease, so audit columns stay NULL.
func Recall(tx pgx.Tx) Held {
	heldMu.Lock()
	defer heldMu.Unlock()
	return heldOn[txKey(tx)]
}

// Forget drops the transaction's lease stamp. Call it when the transaction ends.
func Forget(tx pgx.Tx) {
	if tx == nil {
		return
	}
	heldMu.Lock()
	delete(heldOn, txKey(tx))
	heldMu.Unlock()
}

// AuditArgs returns the lease id and fence for an INSERT, or two NULLs.
func AuditArgs(tx pgx.Tx) (any, any) {
	held := Recall(tx)
	if held.ID == nil {
		return nil, nil
	}
	fence := any(nil)
	if held.Fence != nil {
		fence = *held.Fence
	}
	return *held.ID, fence
}

var (
	heldMu sync.Mutex
	heldOn = map[string]Held{}
)

func remember(tx pgx.Tx, held Held) {
	heldMu.Lock()
	heldOn[txKey(tx)] = held
	heldMu.Unlock()
}

func txKey(tx pgx.Tx) string {
	if tx == nil {
		return ""
	}
	return fmt.Sprintf("%p", tx)
}
