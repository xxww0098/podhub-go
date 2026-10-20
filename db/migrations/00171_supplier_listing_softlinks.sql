-- +goose Up
-- declaration 171 SupplierListingSoftlinks m20260915_000002_supplier_listing_softlinks
-- source: migration/src/supplier_listing_softlinks.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.listing_cards
    ADD COLUMN supplier_product_id text
    GENERATED ALWAYS AS (NULLIF(btrim(payload->>'supplierProductId'), '')) STORED;

DO $$
DECLARE duplicates text;
BEGIN
    SELECT string_agg(format('org=%s product=%s cards=%s', org_id,
                             supplier_product_id, card_ids), '; ')
      INTO duplicates
      FROM (
        SELECT org_id, supplier_product_id,
               string_agg(id::text, ',' ORDER BY id) AS card_ids
          FROM public.listing_cards
         WHERE supplier_product_id IS NOT NULL
         GROUP BY org_id, supplier_product_id
        HAVING count(*) > 1
         ORDER BY org_id, supplier_product_id
         LIMIT 20
      ) conflicts;
    IF duplicates IS NOT NULL THEN
        RAISE EXCEPTION
          'supplier listing softlink duplicates require explicit reconciliation; no cards, rows, jobs, or history were deleted: %',
          duplicates;
    END IF;
END $$;

CREATE UNIQUE INDEX listing_cards_one_supplier_product_per_org
    ON public.listing_cards (org_id, supplier_product_id)
    WHERE supplier_product_id IS NOT NULL;

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
        'current_template_sha256', COALESCE((SELECT CASE WHEN card.supplier_product_id IS NULL
          THEN card.payload->>'psdTemplateSha256' ELSE '' END FROM listing_cards card
          WHERE card.org_id = r.org_id AND card.id = r.card_id), ''),
        'latest_media_job', COALESCE((SELECT jsonb_build_object('kind', j.kind, 'state', j.state, 'result_ref', j.result_ref)
          FROM jobs j WHERE j.org_id = r.org_id AND j.aggregate_id = r.id
            AND j.aggregate_type = 'listing_row' AND j.kind IN ('media.render', 'media.upload')
            AND j.payload->>'executor' = 'browser'
            AND j.payload->>'sourceSha256' = r.payload->'source'->>'sha256'
            AND (EXISTS (SELECT 1 FROM listing_cards card WHERE card.org_id = r.org_id
                         AND card.id = r.card_id AND card.supplier_product_id IS NOT NULL)
                 OR j.payload->>'psdTemplateSha256' = (SELECT card.payload->>'psdTemplateSha256' FROM listing_cards card
                   WHERE card.org_id = r.org_id AND card.id = r.card_id))
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
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
