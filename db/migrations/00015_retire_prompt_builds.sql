-- +goose Up
-- Stop the old worker before migrating. An in-flight paid call must settle first.
-- +goose StatementBegin
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.jobs WHERE kind='prompt.build' AND state='running') THEN
    RAISE EXCEPTION 'Stop worker-prompts and settle running prompt.build jobs before migration';
  END IF;
END $$;
-- +goose StatementEnd
UPDATE public.jobs SET state='cancelled',cancel_requested_at=clock_timestamp(),updated_at=clock_timestamp()
 WHERE kind='prompt.build' AND state IN ('queued','retry_wait');
DROP TABLE public.prompt_build_samples;
DROP TABLE public.prompt_build_runs;

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
  RAISE EXCEPTION 'Prompt-build removal is irreversible; restore the pre-migration backup to roll back';
END $$;
-- +goose StatementEnd
