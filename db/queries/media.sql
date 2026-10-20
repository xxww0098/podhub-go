-- name: OrganizationUUID :one
SELECT uuid::text AS uuid
FROM public.organizations
WHERE id = $1;
