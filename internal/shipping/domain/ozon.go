package domain

import "context"

// Ozon is the loopback Seller port. write is true only for a mutate.
// clientID and apiKey are the unsealed shop credential for this call.
type Ozon interface {
	Post(ctx context.Context, path string, body []byte, write bool, clientID, apiKey string) (status int, resp []byte, err error)
}

// WarehouseName is one listed warehouse. Name and WarehouseName are the same label.
type WarehouseName struct {
	Name          string
	WarehouseName string
	WarehouseID   int64
}

// CallError classifies a round trip that did not return an HTTP status.
type CallError struct {
	Connect   bool
	Transport bool
	Decode    bool
}

func (e *CallError) Error() string { return "ozon" }
