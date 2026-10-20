package common

import (
	"fmt"

	"github.com/QuantumNous/new-api/hostctx"
)

// Podhub adapter. GetBodyStorage in common/gin.go stores the raw HTTP body
// for later reads. relay/helper/billing_expr_request.go calls it only when
// the request content type is JSON and no frozen BillingRequestInput exists.
// The body cache itself was not copied. A call returns an error instead of
// reading an unset body.

type BodyStorage interface {
	Bytes() ([]byte, error)
}

func GetBodyStorage(c *hostctx.Context) (BodyStorage, error) {
	return nil, fmt.Errorf("adapter: request body storage is not copied")
}
