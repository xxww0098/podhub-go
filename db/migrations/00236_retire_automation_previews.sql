-- +goose Up
-- declaration 236 RetireAutomationPreviews m20260929_000418_retire_automation_previews
-- source: migration/src/retire_automation_previews.rs @ a03d735
-- +goose StatementBegin
DO $$
DECLARE
    remaining bigint;
BEGIN
    SELECT count(*) INTO remaining FROM public.automation_previews;
    IF remaining > 0 THEN
        RAISE EXCEPTION 'automation_previews has % row(s); refusing to drop a non-empty table', remaining
            USING ERRCODE = '55000';
    END IF;
END
$$;

DROP TABLE public.automation_previews;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
