// Package newapibilling keeps the copied new-api formula module on the
// podhub build graph. Formula bytes live in third_party/new-api. This
// package does not import relaykit and does not call the wallet.
package newapibilling

import (
	_ "github.com/QuantumNous/new-api/common"
	_ "github.com/QuantumNous/new-api/service"
)
