-- +goose Up
-- 00360 account_kind: every account is either a platform user or a supplier.
--
-- The column lands before the CHECK so the constraint has something to
-- validate. Existing supplier accounts were introduced by 00143 and are
-- recognised by target='/supplier', which provision wrote unconditionally.
-- +goose StatementBegin

ALTER TABLE public.account_users
    ADD COLUMN IF NOT EXISTS account_kind text NOT NULL DEFAULT 'platform';
ALTER TABLE public.account_users
    ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

-- Fail loudly instead of guessing. target is server-written and never read
-- back by the frontend, so a row that says '/supplier' while carrying a staff
-- role means two writers disagreed about what this account is. Silently
-- classifying it either way would bury that.
DO $backfill$
DECLARE
    bad bigint;
    n bigint;
BEGIN
    SELECT count(*) INTO bad
      FROM public.account_users
     WHERE target = '/supplier' AND role <> 'user';
    IF bad > 0 THEN
        RAISE EXCEPTION '00360: % account(s) have target=/supplier but role<>user; resolve them before migrating', bad;
    END IF;

    UPDATE public.account_users
       SET account_kind = 'supplier'
     WHERE target = '/supplier' AND role = 'user';
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE '00360: marked % account(s) as supplier', n;
END
$backfill$;

-- The two values are the whole vocabulary. Anything else is a bug, and a
-- silent third kind would break every surface that switches on this column.
ALTER TABLE public.account_users
    ADD CONSTRAINT ck_account_users_kind
        CHECK (account_kind IN ('platform', 'supplier'));

-- The one place that can actually guarantee a supplier account is never an
-- admin. SetRole issues a plain UPDATE, so even if the Go-side guard were
-- bypassed this CHECK would still refuse the write.
ALTER TABLE public.account_users
    ADD CONSTRAINT ck_account_users_supplier_is_user
        CHECK (account_kind = 'platform' OR role = 'user');

-- No CHECK tying account_kind to supplier_id. A supplier account is a person
-- who may be granted fulfilment or catalogue rights on any number of sources
-- (00361 holds that grant); supplier_id records the one source it is bound to
-- and is empty for a fresh account (provision writes ''). Requiring the two to
-- agree would make provision fail on its first insert.

CREATE INDEX IF NOT EXISTS ix_account_users_account_kind
    ON public.account_users (account_kind);

-- Email identity is case-insensitive but 00151 only added a non-unique
-- lower(email) index, so 'A@x.com' and 'a@x.com' could both exist and the
-- lowercase lookup in provision could pick either. Uniqueness has to be
-- established before the index can be built, and the failure has to name the
-- colliding rows: a bare 23505 here is unattributable in production.
DO $emaildup$
DECLARE
    dup record;
BEGIN
    SELECT lower(email) AS addr, count(*) AS n, string_agg(id::text, ',' ORDER BY id) AS ids
      INTO dup
      FROM public.account_users
     GROUP BY lower(email)
    HAVING count(*) > 1
     ORDER BY count(*) DESC
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION '00360: duplicate account email % (% rows: %); merge them before adding uq_account_users_email_lower',
            dup.addr, dup.n, dup.ids;
    END IF;
END
$emaildup$;

-- DROP first so a re-run on a database where a partially applied earlier
-- attempt left the non-unique index of the same name behind still works.
DROP INDEX IF EXISTS public.ix_account_users_email_lower;
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_users_email_lower
    ON public.account_users (lower(email));

-- +goose StatementEnd

-- +goose Down
-- Rust down() refuses a destructive rollback.
-- +goose StatementBegin
SELECT 1;
-- +goose StatementEnd
