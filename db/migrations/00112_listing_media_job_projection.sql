-- +goose Up
-- declaration 112 ListingMediaJobProjection m20260905_000273_listing_media_job_projection
-- source: migration/src/listing_media_job_projection.rs @ a03d735
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION touch_listing_card_media_rows() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Batch send locks the same rows in ID order before reading Card facts.
  PERFORM id FROM listing_rows WHERE org_id = NEW.org_id AND card_id = NEW.id
    ORDER BY id FOR UPDATE;
  UPDATE listing_rows SET updated_at = clock_timestamp()
    WHERE org_id = NEW.org_id AND card_id = NEW.id;
  RETURN NULL;
END $$;

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

CREATE INDEX listing_current_media_job_idx ON jobs
 (org_id, aggregate_id, (payload->>'sourceSha256'), (payload->>'psdTemplateSha256'),
  input_revision DESC, created_at DESC, id DESC)
 WHERE aggregate_type = 'listing_row' AND kind IN ('media.render', 'media.upload')
   AND payload->>'executor' = 'browser';
-- Old retained pages lack required frozen inputs. Advance past every old head
-- so even a fully caught-up connection must take a fresh snapshot.
DELETE FROM listing_row_events;
UPDATE listing_card_cursors SET seq = seq + 1;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
