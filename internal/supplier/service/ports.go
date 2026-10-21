package service

// Port is the read surface the supplier handlers call.
//
// Wallet and withdrawal reads were removed with the rest of the supplier
// funds surface (docs/architecture/account-permission-model.md §9): no
// supplier route can reach a wallet, a ledger row, or a withdrawal.
type Port interface{}
