-- name: ListWallets :many
SELECT source_id, balance_microfen, held_microfen
FROM supplier_wallets
ORDER BY source_id;

-- name: ListWithdrawals :many
SELECT withdrawal_id::text AS withdrawal_id, source_id, status, amount_cents
FROM supplier_withdrawals
ORDER BY withdrawal_id;
