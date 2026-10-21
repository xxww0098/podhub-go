-- +goose Up
-- 00362 dispatch fulfiller: pin every packet to the one person who may take it.
--
-- Before this batch a packet belonged to a SOURCE and any active member of that
-- source could accept it. Two consequences: a member added after the packet was
-- created could take it, and a member removed after accepting could still be
-- holding an order nobody else could ship. Dispatch now names a person.
-- +goose StatementBegin

-- Nullable on purpose. Every packet that exists today has no fulfiller, and a
-- NOT NULL column would fail the migration on a non-empty database. NULL also
-- *means* something: a legacy packet (see 00363's transitional read-only arm).
-- MATCH SIMPLE (the default) skips the FK check when any referencing column is
-- NULL, so a NULL fulfiller_id needs no matching row.
ALTER TABLE public.delegate_dispatches
    ADD COLUMN IF NOT EXISTS fulfiller_id uuid;

-- Composite FK: the fulfiller must belong to the SAME source as the packet.
-- Checking this in the schema rather than in each caller means no code path can
-- create a packet whose recipient is a fulfiller of a different factory.
ALTER TABLE public.delegate_dispatches
    ADD CONSTRAINT fk_delegate_dispatches_fulfiller
        FOREIGN KEY (source_id, fulfiller_id)
        REFERENCES public.sc_source_fulfillers (source_id, fulfiller_id)
        ON DELETE RESTRICT;

-- Why dispatch could not name a fulfiller.
--
-- This lives on the ORDER, not the packet: the dispatcher's problem is 'this
-- order is ready but I cannot work out who receives it', and at that moment
-- there is no packet to attach a reason to. The order state machine is
-- untouched (no seventh state); the seller sees 'ready but missing a
-- fulfiller' via this column.
ALTER TABLE public.delegate_orders
    ADD COLUMN IF NOT EXISTS dispatch_blocked_reason text;

ALTER TABLE public.delegate_orders
    ADD CONSTRAINT ck_delegate_orders_blocked_reason
        CHECK (dispatch_blocked_reason IS NULL
               OR dispatch_blocked_reason IN ('no_fulfiller', 'ambiguous_fulfiller'));

-- Reading a packet by fulfiller is the portal's hot path: 'the packets I may
-- act on'. Partial, because blocked and legacy rows have no fulfiller.
CREATE INDEX IF NOT EXISTS ix_delegate_dispatches_fulfiller
    ON public.delegate_dispatches (fulfiller_id, state)
    WHERE fulfiller_id IS NOT NULL;


-- =======================================================================
-- Backfill: every in-flight packet is pinned to its source's fulfiller.
--
-- 00361 just made the oldest active member of each source its fulfiller, which
-- is exactly the person who could have accepted the packet under the old
-- source-wide rule. So no packet needs a transitional NULL: after this UPDATE
-- the only NULLs belong to sources that have no active member at all.
--
-- Those packets stay NULL and become invisible to suppliers (the staff arm
-- still sees them). They are the genuine residue: a packet in flight to a
-- factory that no longer has anyone able to take it. An operator resolves each
-- by hand. Making them invisible is correct -- handing them to a member who was
-- added after dispatch is the bug this batch exists to remove.
-- =======================================================================
UPDATE public.delegate_dispatches d
   SET fulfiller_id = f.fulfiller_id
  FROM public.sc_source_fulfillers f
 WHERE f.source_id = d.source_id
   AND f.status = 'active'
   AND d.fulfiller_id IS NULL;
-- =======================================================================
-- Rejection is remembered per FULFILLER, not per source.
--
-- 00203 stores last_rejected_source_id on delegate_order_lines. Wrong grain
-- once a source can change hands: reject a packet, swap the fulfiller inside the
-- same source, and 'rejected_source IS DISTINCT FROM binding_source' is false,
-- so the line never becomes dispatchable again and sits dead forever.
--
-- last_rejected_source_id is kept and stops being written. Dropping it would
-- break the postRustColumns tail-slice comparison in tests/testkit/fingerprint.go,
-- which only compares columns appended after the registered shape.
-- =======================================================================
ALTER TABLE public.delegate_order_lines
    ADD COLUMN IF NOT EXISTS last_rejected_fulfiller_id uuid
        REFERENCES public.sc_source_fulfillers (fulfiller_id) ON DELETE SET NULL;

-- Seed from the old column so a line that is mid-rejection right now does not
-- become dispatchable merely because the grain changed. A source with no
-- fulfiller leaves the new column NULL, which reads as 'never rejected' and
-- lets dispatch re-run: re-sending a packet to a human who can accept or reject
-- it is recoverable, whereas dropping the latch silently strands the order.
UPDATE public.delegate_order_lines l
   SET last_rejected_fulfiller_id = f.fulfiller_id
  FROM public.sc_source_fulfillers f
 WHERE l.last_rejected_source_id = f.source_id
   AND f.status = 'active'
   AND l.last_rejected_fulfiller_id IS NULL;

-- +goose StatementEnd

-- +goose Down
-- Rust down() refuses a destructive rollback.
-- +goose StatementBegin
SELECT 1;
-- +goose StatementEnd
