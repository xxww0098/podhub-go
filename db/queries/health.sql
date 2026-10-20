-- name: DatabaseOne :one
SELECT 1::int AS ok;

-- name: CountBannedTags :one
SELECT count(*)::bigint AS n FROM public.banned_tags;
