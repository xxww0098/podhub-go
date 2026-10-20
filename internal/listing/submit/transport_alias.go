package submit

import sellercontract "github.com/xxww0098/podhub-go/internal/seller/contract"

// Transport and ErrNotSent are declared in seller/contract. These names keep
// the submit function bodies on the same words they had before the move.
type Transport = sellercontract.Transport

var ErrNotSent = sellercontract.ErrNotSent
