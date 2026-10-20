-- +goose Up
-- declaration 109 ListingRowStream m20260905_000270_listing_row_stream
-- source: migration/src/listing_row_stream.rs @ a03d735
-- +goose StatementBegin
-- This counter is independent of business rows: deferred writers must never
-- acquire a Card / Team / Listing Row lock after taking it.
CREATE TABLE listing_card_cursors (
    org_id bigint NOT NULL,
    card_id uuid NOT NULL,
    seq bigint NOT NULL DEFAULT 0 CHECK (seq >= 0),
    PRIMARY KEY (org_id, card_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON listing_card_cursors TO podhub_app, podhub_worker;
ALTER TABLE listing_card_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_card_cursors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON listing_card_cursors FOR ALL TO podhub_app
 USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
 WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
CREATE TABLE listing_row_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id bigint NOT NULL,
    stream_card_id uuid NOT NULL,
    stream_seq bigint,
    stream_txid bigint NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON listing_row_events TO podhub_app, podhub_worker;
ALTER TABLE listing_row_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_row_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON listing_row_events FOR ALL TO podhub_app
 USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
 WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
CREATE UNIQUE INDEX listing_stream_seq_idx ON listing_row_events (org_id, stream_card_id, stream_seq);
CREATE UNIQUE INDEX listing_stream_transaction_row_idx
 ON listing_row_events (stream_txid, org_id, stream_card_id, (payload->>'rowId'))
 WHERE stream_seq IS NULL;
CREATE INDEX listing_stream_retention_idx ON listing_row_events (created_at);

CREATE FUNCTION stage_listing_row_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.card_id IS DISTINCT FROM NEW.card_id THEN
    INSERT INTO listing_row_events (id, org_id, payload, stream_card_id, stream_txid)
    VALUES (gen_random_uuid(), OLD.org_id,
            jsonb_build_object('rowId', OLD.id, 'removed', true), OLD.card_id, txid_current())
    ON CONFLICT (stream_txid, org_id, stream_card_id, (payload->>'rowId'))
      WHERE stream_seq IS NULL
    DO UPDATE SET payload = EXCLUDED.payload;
  END IF;
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  INSERT INTO listing_row_events (id, org_id, payload, stream_card_id, stream_txid)
  VALUES (gen_random_uuid(), r.org_id,
          jsonb_build_object('rowId', r.id, 'removed', TG_OP = 'DELETE'), r.card_id, txid_current())
  ON CONFLICT (stream_txid, org_id, stream_card_id, (payload->>'rowId'))
    WHERE stream_seq IS NULL
  DO UPDATE SET payload = EXCLUDED.payload;
  RETURN NULL;
END $$;
CREATE TRIGGER listing_row_stream_stage AFTER INSERT OR UPDATE OR DELETE ON listing_rows
 FOR EACH ROW EXECUTE FUNCTION stage_listing_row_event();

CREATE OR REPLACE FUNCTION seal_listing_row_events() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record; e record; next_seq bigint; facts jsonb;
BEGIN
  -- All business writes have finished. Sort cards before locking their counters
  -- so a multi-card transaction cannot reverse another transaction's order.
  FOR c IN SELECT org_id, stream_card_id, count(*) AS event_count
    FROM listing_row_events WHERE stream_txid = txid_current() AND stream_seq IS NULL

    GROUP BY org_id, stream_card_id ORDER BY org_id, stream_card_id
  LOOP
    INSERT INTO listing_card_cursors (org_id, card_id) VALUES (c.org_id, c.stream_card_id)
      ON CONFLICT DO NOTHING;
    UPDATE listing_card_cursors SET seq = seq + c.event_count
      WHERE org_id = c.org_id AND card_id = c.stream_card_id RETURNING seq - c.event_count INTO next_seq;
    FOR e IN SELECT id, payload FROM listing_row_events
      WHERE stream_txid = txid_current() AND stream_seq IS NULL
        AND org_id = c.org_id AND stream_card_id = c.stream_card_id ORDER BY created_at, id
    LOOP
      next_seq := next_seq + 1;
      SELECT to_jsonb(r) || jsonb_build_object('latest_intent', COALESCE((
        SELECT to_jsonb(i) FROM submission_intents i
          WHERE i.org_id = r.org_id AND i.listing_row_id = r.id
          ORDER BY i.row_revision DESC, i.created_at DESC, i.id DESC LIMIT 1), '{}'::jsonb),
        'current_template_sha256', COALESCE((SELECT card.payload->>'psdTemplateSha256' FROM listing_cards card
          WHERE card.org_id = r.org_id AND card.id = r.card_id), ''),
        'latest_media_job', COALESCE((SELECT jsonb_build_object('kind', j.kind, 'state', j.state, 'result_ref', j.result_ref)
          FROM jobs j WHERE j.org_id = r.org_id AND j.aggregate_id = r.id
            AND j.aggregate_type = 'listing_row' AND j.kind IN ('media.render', 'media.upload')
            AND j.payload->>'executor' = 'browser'
            AND j.payload->>'sourceSha256' = r.payload->'source'->>'sha256'
            AND j.payload->>'psdTemplateSha256' = (SELECT card.payload->>'psdTemplateSha256' FROM listing_cards card
              WHERE card.org_id = r.org_id AND card.id = r.card_id)
            AND (j.kind = 'media.render' OR j.payload->>'manifestDigest' = r.payload->'renderEvidence'->>'manifest_digest')
          ORDER BY j.input_revision DESC, j.created_at DESC, j.id DESC LIMIT 1), '{}'::jsonb))
        INTO facts FROM listing_rows r WHERE r.org_id = c.org_id
          AND r.card_id = c.stream_card_id AND r.id = (e.payload->>'rowId')::uuid;
      UPDATE listing_row_events SET stream_seq = next_seq,
        payload = e.payload || jsonb_build_object('removed', facts IS NULL, 'row', facts)
        WHERE id = e.id;
    END LOOP;
  END LOOP;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER listing_stream_commit AFTER INSERT ON listing_row_events
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION seal_listing_row_events();
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
