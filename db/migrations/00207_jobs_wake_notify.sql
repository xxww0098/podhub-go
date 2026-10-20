-- +goose Up
-- declaration 207 JobsWakeNotify m20260922_150000_jobs_wake_notify
-- source: migration/src/jobs_wake_notify.rs @ a03d735
-- +goose StatementBegin
CREATE FUNCTION public.notify_ozon_jobs_wake()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    PERFORM pg_notify('ozon_jobs_wake', NEW.kind);
    RETURN NEW;
END;
$$;

CREATE TRIGGER jobs_wake_after_insert
AFTER INSERT ON public.jobs
FOR EACH ROW
WHEN (
    NEW.state = 'queued'
    AND COALESCE(NEW.payload->>'executor', '') NOT IN ('browser', 'http')
)
EXECUTE FUNCTION public.notify_ozon_jobs_wake();

GRANT EXECUTE ON FUNCTION public.notify_ozon_jobs_wake() TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
