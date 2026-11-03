-- name: RecentEmailChange :one
SELECT EXISTS(SELECT 1 FROM auth_email_tokens WHERE user_id=$1 AND purpose='change_email' AND created_at>clock_timestamp()-interval '60 seconds')::bool;

-- name: InsertEmailChange :exec
INSERT INTO auth_email_tokens(token_hash,user_id,purpose,new_email,expires_at)
VALUES($1,$2,'change_email',$3,clock_timestamp()+interval '30 minutes');

-- name: FindEmailChange :one
SELECT t.user_id, u.email, u.account_kind, t.new_email::text AS new_email FROM auth_email_tokens t
JOIN account_users u ON u.id=t.user_id
WHERE t.token_hash=$1 AND t.purpose='change_email' AND t.consumed_at IS NULL AND t.expires_at>clock_timestamp()
AND NOT EXISTS (SELECT 1 FROM auth_password_reset_deliveries d WHERE d.token_hash=t.token_hash AND d.state IN ('failed','cancelled'));

-- name: CancelEmailChanges :exec
UPDATE auth_email_tokens SET consumed_at=clock_timestamp()
WHERE user_id=$1 AND purpose='change_email' AND consumed_at IS NULL;

-- name: CancelEmailChangeDeliveries :exec
UPDATE auth_password_reset_deliveries d SET state='cancelled',secret_nonce=NULL,secret_ciphertext=NULL,
lease_token=NULL,lease_until=NULL,last_error_code='superseded',updated_at=clock_timestamp()
FROM auth_email_tokens t WHERE t.token_hash=d.token_hash AND t.user_id=$1 AND t.purpose='change_email' AND d.state IN ('pending','sending');

-- name: UpdateUserEmail :exec
UPDATE account_users SET email=$1,session_revision=session_revision+1,updated_at=clock_timestamp() WHERE id=$2;
