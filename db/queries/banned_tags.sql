-- name: ListEnabledBannedTags :many
-- Platform table. No org_id column and no tenant RLS in the Rust migration.
-- Do not filter by app.current_org_id. Unknown match_mode values are skipped
-- by the loader, matching banned_tags::store::load_enabled.
SELECT id, term, match_mode
FROM public.banned_tags
WHERE enabled
ORDER BY id;
