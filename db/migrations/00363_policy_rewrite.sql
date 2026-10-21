-- +goose Up
-- 00363 policy rewrite: packets become person-scoped, and suppliers lose funds.
-- +goose StatementBegin

-- =======================================================================
-- 1. delegate_dispatches: fulfil the packet or it is not yours.
--
-- The old arm (00203:229-243) granted ALL to any active member of the source.
-- That is why a member added after dispatch could accept, and why a member
-- removed after accepting could still ship. The new arm matches on
-- fulfiller_id, which 00362 pinned at dispatch time.
-- =======================================================================
DROP POLICY IF EXISTS delegate_source_isolation ON public.delegate_dispatches;
-- Read wide, write strict. The USING arm deliberately does NOT test
-- f.status: revoking a grant ends the licence to take on work, it does not
-- erase the packets already pinned to that person. If USING required
-- status = 'active', disabling one row would make every in-flight packet
-- vanish from its own fulfiller the instant staff clicked revoke -- they
-- could no longer see what they are holding, and the row would be
-- unreachable except by staff. 00361:159 keeps the row instead of deleting
-- it precisely so the ownership chain survives; the policy has to honour
-- that, otherwise the row is preserved and then made useless.
--
-- WITH CHECK keeps status = 'active': a disabled grant must not create or
-- reassign packets. Nothing in the supplier portal writes this table
-- directly anyway (the three actions go through the 00364 definer
-- functions, which carry their own active-only gate), so the strict arm
-- is a second lock, not the load-bearing one.
CREATE POLICY delegate_fulfiller_isolation ON public.delegate_dispatches
    FOR ALL TO podhub_app
    USING (fulfiller_id IN (
        SELECT f.fulfiller_id FROM public.sc_source_fulfillers f
        WHERE f.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint
    ))
    WITH CHECK (fulfiller_id IN (
        SELECT f.fulfiller_id FROM public.sc_source_fulfillers f
        WHERE f.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint
          AND f.status = 'active'
    ));

-- =======================================================================
-- No transitional arm for fulfiller_id IS NULL.
--
-- An earlier draft kept legacy packets read-only visible to any active member
-- of the source for six weeks. That is exactly the compatibility shim this
-- project forbids: it would keep the source-wide model alive in the policy
-- layer, and the only rows it serves are packets that no longer have a
-- legitimate recipient.
--
-- 00362 backfills every packet whose source still has a fulfiller, so the
-- remaining NULLs are packets whose factory has nobody left who could take
-- them. Staff resolve those by hand; suppliers do not see them. No arm needed.
-- =======================================================================

-- =======================================================================
-- 2. delegate_settlements: source-scoped -> fulfiller-scoped.
--
-- 00258:103-116 gave any active member of the source every settlement row of
-- that source, so two members of one source could read each other's payouts.
-- =======================================================================
DROP POLICY IF EXISTS delegate_source_isolation ON public.delegate_settlements;
-- Same read-wide / write-strict split as the packet policy above: a revoked
-- fulfiller keeps read access to the settlements they earned, but cannot
-- create or move one. The WITH CHECK arm is what the money path relies on,
-- and it keeps requiring an active grant.
CREATE POLICY delegate_fulfiller_isolation ON public.delegate_settlements
    FOR ALL TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.delegate_dispatches d
        WHERE d.dispatch_id = delegate_settlements.dispatch_id
          AND d.fulfiller_id IN (
              SELECT f.fulfiller_id FROM public.sc_source_fulfillers f
              WHERE f.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint)
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.delegate_dispatches d
        WHERE d.dispatch_id = delegate_settlements.dispatch_id
          AND d.fulfiller_id IN (
              SELECT f.fulfiller_id FROM public.sc_source_fulfillers f
              WHERE f.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint
                AND f.status = 'active')
    ));

-- =======================================================================
-- 3. F4: refuse to migrate a factory that still has money on the books.
--
-- The two drops below are the point of the migration, but they are not a
-- data fix. balance_microfen is money actually owed to a factory, and a
-- 'requested' withdrawal is a payout someone has to approve or reject.
-- Neither can be zeroed or cancelled by DDL, and doing so silently would
-- erase a liability. So the migration stops here instead, names the rows,
-- and lets staff settle them offline (plan 9.2 / O15).
--
-- Placing the guard BEFORE the policy drops matters for operability: a
-- failed migration leaves the previous, working schema in place, so the
-- money surfaces still function while the balances are cleared.
-- =======================================================================
DO $residual$
DECLARE
    bad_wallets bigint;
    bad_withdrawals bigint;
    detail text;
BEGIN
    SELECT count(*), string_agg(source_id || '=' || balance_microfen::text, ',' ORDER BY source_id)
      INTO bad_wallets, detail
      FROM public.supplier_wallets
     WHERE balance_microfen <> 0;
    IF bad_wallets > 0 THEN
        RAISE EXCEPTION '00363: % supplier wallet(s) still hold a balance (%); settle them before dropping the supplier funds policies',
            bad_wallets, detail;
    END IF;

    SELECT count(*), string_agg(withdrawal_id::text, ',' ORDER BY withdrawal_id)
      INTO bad_withdrawals, detail
      FROM public.supplier_withdrawals
     WHERE status = 'requested';
    IF bad_withdrawals > 0 THEN
        RAISE EXCEPTION '00363: % supplier withdrawal(s) still pending (%); approve or reject them before dropping the supplier funds policies',
            bad_withdrawals, detail;
    END IF;
END
$residual$;
-- =======================================================================
-- 4. Suppliers have no funds access. Drop the self arms outright.
--
-- Unmounting the three /api/supplier wallet routes is not enough: the rows were
-- still reachable from SQL under a supplier session, and §9 promises a supplier
-- has no funds surface at all. The staff arms stay so the admin withdrawal
-- screens keep working.
-- =======================================================================
DROP POLICY IF EXISTS supplier_source_isolation ON public.supplier_wallets;
DROP POLICY IF EXISTS supplier_source_isolation ON public.supplier_wallet_ledger;
DROP POLICY IF EXISTS supplier_source_isolation ON public.supplier_withdrawals;

-- =======================================================================
-- 5. Retire the source-grained member count.
--
-- 00203:260-265 exposed delegate_source_active_member_count and 00191's blanket
-- GRANT made it executable by PUBLIC. The seller-side warning it served now
-- counts fulfillers (00364 defines delegate_source_active_fulfiller_count).
-- The old function stays defined but is no longer PUBLIC-executable, so a stale
-- caller fails loudly instead of reading a number that no longer means what its
-- name says.
-- =======================================================================
REVOKE EXECUTE ON FUNCTION public.delegate_source_active_member_count(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delegate_source_active_member_count(text)
    TO podhub_app, podhub_worker;

-- +goose StatementEnd

-- +goose Down
-- Rust down() refuses a destructive rollback.
-- +goose StatementBegin
SELECT 1;
-- +goose StatementEnd
