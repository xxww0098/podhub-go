-- +goose Up
-- declaration 315 BrowserGrantRevocation
-- Post-Rust append. A browser grant records when the plaintext was issued
-- and when that issuance was revoked. key_expires_at_ms stays the seller
-- key's own expiry. 00001-00307 are not edited.
-- +goose StatementBegin
ALTER TABLE public.submission_intents
    ADD COLUMN credential_granted_at timestamptz,
    ADD COLUMN revoked_at timestamptz;
-- +goose StatementEnd

-- +goose Down
-- Rust down() refuses a destructive rollback. This append follows that shape.
SELECT 1;
