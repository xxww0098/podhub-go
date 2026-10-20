-- sqlc schema only. Runtime objects come from goose migrations.
CREATE TABLE supplier_wallets (
    source_id text PRIMARY KEY,
    balance_microfen bigint NOT NULL,
    held_microfen bigint NOT NULL
);

CREATE TABLE supplier_withdrawals (
    withdrawal_id uuid PRIMARY KEY,
    source_id text NOT NULL,
    status text NOT NULL,
    amount_cents bigint NOT NULL
);
