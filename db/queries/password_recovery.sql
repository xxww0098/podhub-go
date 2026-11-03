-- name: ResetTokenOwner :one
SELECT user_id FROM auth_email_tokens t
WHERE t.token_hash=$1 AND purpose='reset' AND consumed_at IS NULL AND expires_at>clock_timestamp()
AND NOT EXISTS (SELECT 1 FROM auth_password_reset_deliveries d WHERE d.token_hash=t.token_hash AND d.state IN ('failed','cancelled'));

-- name: BumpResetRequest :one
INSERT INTO auth_password_reset_requests AS current (ip_hash,window_start,requests)
VALUES ($1,clock_timestamp(),1)
ON CONFLICT(ip_hash) DO UPDATE SET
 window_start=CASE WHEN current.window_start<=clock_timestamp()-interval '15 minutes' THEN clock_timestamp() ELSE current.window_start END,
 requests=CASE WHEN current.window_start<=clock_timestamp()-interval '15 minutes' THEN 1 ELSE least(current.requests+1,1000000) END
RETURNING requests,(greatest(1,ceil(extract(epoch FROM window_start+interval '15 minutes'-clock_timestamp()))))::integer AS retry_after;

-- name: PruneResetRequests :exec
DELETE FROM auth_password_reset_requests WHERE ip_hash IN
(SELECT ip_hash FROM auth_password_reset_requests WHERE window_start<clock_timestamp()-interval '1 day' LIMIT 32);

-- name: RecentResetRequest :one
SELECT EXISTS(SELECT 1 FROM auth_email_tokens WHERE user_id=$1 AND purpose='reset' AND created_at>clock_timestamp()-interval '60 seconds')::bool;

-- name: InsertResetToken :exec
INSERT INTO auth_email_tokens(token_hash,user_id,purpose,expires_at)
VALUES($1,$2,'reset',clock_timestamp()+interval '30 minutes');

-- name: InsertResetDelivery :exec
INSERT INTO auth_password_reset_deliveries(token_hash,secret_nonce,secret_ciphertext) VALUES($1,$2,$3);

-- name: ClaimResetDeliveries :many
WITH due AS (
 SELECT d.token_hash FROM auth_password_reset_deliveries d
 WHERE (d.state='pending' AND d.next_attempt_at<=clock_timestamp())
    OR (d.state='sending' AND d.lease_until<=clock_timestamp())
 ORDER BY d.next_attempt_at,d.token_hash LIMIT $1 FOR UPDATE OF d SKIP LOCKED
)
UPDATE auth_password_reset_deliveries d SET
 state='sending',attempts=least(d.attempts+1,5),lease_token=$2,lease_until=clock_timestamp()+interval '2 minutes',updated_at=clock_timestamp()
FROM due WHERE d.token_hash=due.token_hash
RETURNING d.token_hash,d.secret_nonce,d.secret_ciphertext,d.attempts;

-- name: ResetDeliveryRecipient :one
SELECT COALESCE(t.new_email, u.email)::text AS email, t.purpose FROM auth_password_reset_deliveries d
JOIN auth_email_tokens t ON t.token_hash=d.token_hash JOIN account_users u ON u.id=t.user_id
WHERE d.token_hash=$1 AND d.state='sending' AND d.lease_token=$2 AND d.lease_until>clock_timestamp()
 AND t.consumed_at IS NULL AND t.expires_at>clock_timestamp() AND u.disabled_at IS NULL;

-- name: FinishResetDelivery :execrows
UPDATE auth_password_reset_deliveries SET state=sqlc.arg(state)::text,
 secret_nonce=CASE WHEN sqlc.arg(state)::text='pending' THEN secret_nonce ELSE NULL END,
 secret_ciphertext=CASE WHEN sqlc.arg(state)::text='pending' THEN secret_ciphertext ELSE NULL END,
 lease_token=NULL,lease_until=NULL,last_error_code=NULLIF(sqlc.arg(error_code)::text,''),
 delivered_at=CASE WHEN sqlc.arg(state)::text='sent' THEN clock_timestamp() ELSE NULL END,
 next_attempt_at=clock_timestamp()+make_interval(secs=>sqlc.arg(delay_seconds)::integer),updated_at=clock_timestamp()
WHERE token_hash=sqlc.arg(token_hash) AND state='sending' AND lease_token=sqlc.arg(lease_token) AND lease_until>clock_timestamp();

-- name: ExpireResetDeliveries :exec
UPDATE auth_password_reset_deliveries d SET state='failed',secret_nonce=NULL,secret_ciphertext=NULL,
 lease_token=NULL,lease_until=NULL,last_error_code='expired',updated_at=clock_timestamp()
FROM auth_email_tokens t WHERE t.token_hash=d.token_hash AND d.state IN ('pending','sending')
 AND (t.expires_at<=clock_timestamp() OR t.consumed_at IS NOT NULL OR (d.attempts>=5 AND (d.state='pending' OR d.lease_until<=clock_timestamp())));

-- name: PruneResetTokens :exec
WITH owners AS MATERIALIZED (
 SELECT u.id FROM account_users u WHERE EXISTS (
  SELECT 1 FROM auth_email_tokens t WHERE t.user_id=u.id AND t.expires_at<clock_timestamp()-interval '7 days'
 ) ORDER BY u.id LIMIT 32 FOR UPDATE OF u SKIP LOCKED
)
DELETE FROM auth_email_tokens WHERE token_hash IN
(SELECT t.token_hash FROM auth_email_tokens t JOIN owners u ON u.id=t.user_id
 WHERE t.expires_at<clock_timestamp()-interval '7 days' LIMIT 32);
