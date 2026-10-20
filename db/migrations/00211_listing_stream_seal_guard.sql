-- +goose Up
-- declaration 211 ListingStreamSealGuard m20260922_190000_listing_stream_seal_guard
-- source: migration/src/listing_stream_seal_guard.rs @ a03d735
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION seal_listing_row_events() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c record;
  total int;
  lo int;
  hi int;
  chunk_n int;
  chunk_ids uuid[];
  chunk_rows uuid[];
  facts jsonb;
  now_revs jsonb;
  drifted uuid[];
  resealed jsonb;
  base_seq bigint;
BEGIN
  -- Seal guard (db-write-amp 05 / D-03): the heavy projection reads run
  -- BEFORE the cursor critical section opens; inside it only the counter
  -- advance, a cheap view_revision re-check, a bounded per-drifted-row
  -- recompute and the batched seq assignment remain — never a full projection
  -- query and never a new business row lock. Guard soundness: every concurrent
  -- change to a frozen fact input bumps listing_rows.view_revision (BEFORE
  -- UPDATE trigger bump_listing_view_revision, plus the Intent touch and the
  -- template fanout triggers). jobs state moves without touching the row
  -- (claim/lease paths): a stale frozen latest_media_job is accepted and
  -- self-heals through the next event or a client snapshot refresh.
  -- Replay invariants (commit order, frozen snapshots, snapshot reset) are
  -- unchanged and pinned by the stream test net.

  -- ① Optimistic precompute — no cursor lock is held here. One entry per
  -- (org, card, rowId) this transaction staged; rows that moved away or were
  -- deleted are absent, and absence seals as removed. Map keys carry org and
  -- card because a move stages the same rowId on two cards in one transaction.
  SELECT coalesce(jsonb_object_agg(
           s.org_id::text || ':' || s.stream_card_id::text || ':' || s.row_id::text,
           jsonb_build_object('vr', r.view_revision, 'facts', to_jsonb(r) || jsonb_build_object('latest_intent', COALESCE((
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
            ORDER BY j.input_revision DESC, j.created_at DESC, j.id DESC LIMIT 1), '{}'::jsonb)))), '{}'::jsonb)
    INTO facts
    FROM (SELECT DISTINCT org_id, stream_card_id, (payload->>'rowId')::uuid AS row_id
            FROM listing_row_events
           WHERE stream_txid = txid_current() AND stream_seq IS NULL) s
    JOIN listing_rows r
      ON r.org_id = s.org_id AND r.card_id = s.stream_card_id AND r.id = s.row_id;

  -- All business writes have finished. Sort cards before locking their counters
  -- so a multi-card transaction cannot reverse another transaction's order.
  FOR c IN
    SELECT ev.org_id, ev.stream_card_id,
           array_agg(ev.id ORDER BY ev.created_at, ev.id) AS ids,
           array_agg((ev.payload->>'rowId')::uuid ORDER BY ev.created_at, ev.id) AS row_ids
      FROM listing_row_events ev
     WHERE ev.stream_txid = txid_current() AND ev.stream_seq IS NULL
     GROUP BY ev.org_id, ev.stream_card_id
     ORDER BY ev.org_id, ev.stream_card_id
  LOOP
    -- A single card with a batch larger than the chunk advances the counter
    -- once per chunk: the critical-section statements stay bounded.
    total := coalesce(array_length(c.ids, 1), 0);
    FOR lo IN 1..total BY 256 LOOP
      hi := lo + 256 - 1;
      IF hi > total THEN hi := total; END IF;
      chunk_ids := c.ids[lo:hi];
      chunk_rows := c.row_ids[lo:hi];
      chunk_n := hi - lo + 1;

      -- ② Critical section opens: take this chunk's seq range.
      INSERT INTO listing_card_cursors (org_id, card_id)
        VALUES (c.org_id, c.stream_card_id) ON CONFLICT DO NOTHING;
      UPDATE listing_card_cursors SET seq = seq + chunk_n
        WHERE org_id = c.org_id AND card_id = c.stream_card_id
        RETURNING seq - chunk_n INTO base_seq;

      -- ③ Guard: re-read only the affected rows' view_revision (one cheap
      -- primary-key lookup per chunk) and recompute just the drifted rows.
      -- The card filter matches the precompute predicate, so a row that left
      -- this card re-seals as removed exactly like a live facts query would.
      SELECT coalesce(jsonb_object_agg(r.id::text, r.view_revision), '{}'::jsonb)
        INTO now_revs
        FROM listing_rows r
        WHERE r.org_id = c.org_id AND r.card_id = c.stream_card_id
          AND r.id = ANY(chunk_rows);
      SELECT coalesce(array_agg(DISTINCT (ev.payload->>'rowId')::uuid), ARRAY[]::uuid[])
        INTO drifted
        FROM listing_row_events ev
        WHERE ev.id = ANY(chunk_ids)
          AND (facts -> (ev.org_id::text || ':' || ev.stream_card_id::text || ':' || (ev.payload->>'rowId'))) -> 'vr'
              IS DISTINCT FROM (now_revs -> (ev.payload->>'rowId'));
      IF cardinality(drifted) > 0 THEN
        SELECT coalesce(jsonb_object_agg(
                 r.org_id::text || ':' || r.card_id::text || ':' || r.id::text,
                 jsonb_build_object('vr', r.view_revision, 'facts', to_jsonb(r) || jsonb_build_object('latest_intent', COALESCE((
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
            ORDER BY j.input_revision DESC, j.created_at DESC, j.id DESC LIMIT 1), '{}'::jsonb)))), '{}'::jsonb)
          INTO resealed
          FROM listing_rows r
          WHERE r.org_id = c.org_id AND r.card_id = c.stream_card_id AND r.id = ANY(drifted);
        facts := (facts - (SELECT array_agg(c.org_id::text || ':' || c.stream_card_id::text || ':' || d::text)
                             FROM unnest(drifted) AS d)) || resealed;
      END IF;

      -- ④ One statement per chunk assigns seq + frozen payload; absent map
      -- entries seal as removed with a null row, exactly like the previous
      -- per-event facts query missing the row. ⑤ The surrounding transaction's
      -- COMMIT closes the critical section.
      WITH ranked AS (
        SELECT ev.id, base_seq + row_number() OVER (ORDER BY ev.created_at, ev.id) AS seq
          FROM listing_row_events ev
         WHERE ev.id = ANY(chunk_ids)
      )
      UPDATE listing_row_events e
         SET stream_seq = ranked.seq,
             payload = e.payload || jsonb_build_object(
               'removed', (facts -> (e.org_id::text || ':' || e.stream_card_id::text || ':' || (e.payload->>'rowId'))) IS NULL,
               'row', (facts -> (e.org_id::text || ':' || e.stream_card_id::text || ':' || (e.payload->>'rowId'))) -> 'facts')
        FROM ranked
       WHERE e.id = ranked.id;
    END LOOP;
  END LOOP;
  RETURN NULL;
END $$;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
