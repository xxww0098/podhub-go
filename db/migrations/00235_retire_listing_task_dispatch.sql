-- +goose Up
-- declaration 235 RetireListingTaskDispatch m20260929_000417_retire_listing_task_dispatch
-- source: migration/src/retire_listing_task_dispatch.rs @ a03d735
-- +goose StatementBegin
DO $$
DECLARE
    remaining bigint;
BEGIN
    SELECT count(*) INTO remaining FROM public.listing_tasks;
    IF remaining > 0 THEN
        RAISE EXCEPTION 'listing_tasks has % row(s); refusing to drop a non-empty table', remaining
            USING ERRCODE = '55000';
    END IF;
    SELECT count(*) INTO remaining FROM public.listing_dispatch_batches;
    IF remaining > 0 THEN
        RAISE EXCEPTION 'listing_dispatch_batches has % row(s); refusing to drop a non-empty table', remaining
            USING ERRCODE = '55000';
    END IF;
    SELECT count(*) INTO remaining FROM public.listing_dispatch_items;
    IF remaining > 0 THEN
        RAISE EXCEPTION 'listing_dispatch_items has % row(s); refusing to drop a non-empty table', remaining
            USING ERRCODE = '55000';
    END IF;
    SELECT count(*) INTO remaining FROM public.listing_dispatch_admissions;
    IF remaining > 0 THEN
        RAISE EXCEPTION 'listing_dispatch_admissions has % row(s); refusing to drop a non-empty table', remaining
            USING ERRCODE = '55000';
    END IF;
    SELECT count(*) INTO remaining FROM public.listing_dispatch_rejections;
    IF remaining > 0 THEN
        RAISE EXCEPTION 'listing_dispatch_rejections has % row(s); refusing to drop a non-empty table', remaining
            USING ERRCODE = '55000';
    END IF;
END
$$;

DROP TRIGGER IF EXISTS listing_tasks_reject_live_dispatch_mutation ON public.listing_tasks;
DROP FUNCTION IF EXISTS public.reject_live_listing_task_mutation();
DROP FUNCTION IF EXISTS public.lock_listing_dispatch_recovery_workspace();

DROP TABLE public.listing_dispatch_rejections;
DROP TABLE public.listing_dispatch_items;
DROP TABLE public.listing_dispatch_batches;
DROP TABLE public.listing_dispatch_admissions;
DROP TABLE public.listing_tasks;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
