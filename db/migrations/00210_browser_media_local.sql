-- +goose Up
-- declaration 210 BrowserMediaLocal m20260922_180000_browser_media_local
-- source: migration/src/browser_media_local.rs @ a03d735
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.refresh_account_queue_head() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u bigint:=COALESCE(NEW.submitter_user_id,OLD.submitter_user_id);
 l text:=COALESCE(NEW.lane,OLD.lane); oq bigint:=0; nq bigint:=0; orc bigint:=0; nr bigint:=0;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.submitter_user_id<>OLD.submitter_user_id OR NEW.lane<>OLD.lane) THEN
  RAISE EXCEPTION 'Job execution User and lane are immutable';
 END IF;
 IF TG_OP<>'INSERT' AND NOT (OLD.kind IN ('media.render','media.upload') AND COALESCE(OLD.payload->>'executor','')='browser') THEN
  IF OLD.state IN ('queued','retry_wait') THEN oq:=OLD.cost_units; END IF;
  IF OLD.state='running' THEN orc:=OLD.cost_units; END IF;
 END IF;
 IF TG_OP<>'DELETE' AND NOT (NEW.kind IN ('media.render','media.upload') AND COALESCE(NEW.payload->>'executor','')='browser') THEN
  IF NEW.state IN ('queued','retry_wait') THEN nq:=NEW.cost_units; END IF;
  IF NEW.state='running' THEN nr:=NEW.cost_units; END IF;
 END IF;
 IF oq=0 AND nq=0 AND orc=0 AND nr=0 THEN RETURN COALESCE(NEW,OLD); END IF;
 INSERT INTO public.account_queue_head(user_id,lane) VALUES(u,l) ON CONFLICT DO NOTHING;
 UPDATE public.account_queue_head SET queued_cost=queued_cost-oq+nq,running_cost=running_cost-orc+nr
 WHERE user_id=u AND lane=l;
 UPDATE public.account_queue_head SET oldest_job_at=(SELECT min(run_at) FROM public.jobs
  WHERE submitter_user_id=u AND lane=l AND state IN ('queued','retry_wait') AND NOT (kind IN ('media.render','media.upload') AND COALESCE(payload->>'executor','')='browser')) WHERE user_id=u AND lane=l;
 DELETE FROM public.account_queue_head WHERE user_id=u AND lane=l AND queued_cost=0 AND running_cost=0;
 RETURN COALESCE(NEW,OLD);
END $$;

UPDATE public.account_queue_head h SET
 queued_cost=(SELECT COALESCE(sum(cost_units),0) FROM public.jobs j WHERE j.submitter_user_id=h.user_id AND j.lane=h.lane AND j.state IN ('queued','retry_wait') AND NOT (j.kind IN ('media.render','media.upload') AND COALESCE(j.payload->>'executor','')='browser')),
 running_cost=(SELECT COALESCE(sum(cost_units),0) FROM public.jobs j WHERE j.submitter_user_id=h.user_id AND j.lane=h.lane AND j.state='running' AND NOT (j.kind IN ('media.render','media.upload') AND COALESCE(j.payload->>'executor','')='browser')),
 oldest_job_at=(SELECT min(run_at) FROM public.jobs j WHERE j.submitter_user_id=h.user_id AND j.lane=h.lane AND j.state IN ('queued','retry_wait') AND NOT (j.kind IN ('media.render','media.upload') AND COALESCE(j.payload->>'executor','')='browser'))
WHERE h.lane IN ('media.render','media.upload');
DELETE FROM public.account_queue_head WHERE lane IN ('media.render','media.upload') AND queued_cost=0 AND running_cost=0;
-- Retire only browser execution permits. Real origin upload/verify units keep their own limits.
SELECT class FROM public.execution_quota ORDER BY class,user_id FOR UPDATE;
WITH released AS (
 UPDATE public.execution_permits p SET released_at=clock_timestamp()
 FROM public.jobs j WHERE p.holder_kind='job' AND p.holder_id=j.id::text
 AND p.released_at IS NULL AND j.kind IN ('media.render','media.upload') AND COALESCE(j.payload->>'executor','')='browser'
 RETURNING p.class,p.user_id
), counts AS (
 SELECT class,user_id,count(*) AS n FROM released GROUP BY class,user_id
 UNION ALL SELECT class,0::bigint,count(*) FROM released GROUP BY class
)
UPDATE public.execution_quota q SET used=q.used-counts.n FROM counts WHERE q.class=counts.class AND q.user_id=counts.user_id;
UPDATE public.jobs SET state=CASE WHEN cancel_requested_at IS NULL THEN 'queued' ELSE 'cancelled' END,
 lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()
WHERE kind IN ('media.render','media.upload') AND COALESCE(payload->>'executor','')='browser' AND state IN ('running','uncertain');
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
