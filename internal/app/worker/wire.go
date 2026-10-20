package worker

import sellerpkg "github.com/xxww0098/podhub-go/internal/seller"

// Egress is the seller pool. The alias keeps reconcile.go's signature text
// identical to the function that used to live in package seller.
type Egress = sellerpkg.Egress

func init() {
	sellerpkg.Attach = Attach
}
