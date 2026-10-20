package i18n

import "github.com/QuantumNous/new-api/hostctx"

// Podhub adapter. The translation bundle in i18n/ was not copied.
// T returns the message key, which is also new-api's fallback when a
// localizer has no entry (i18n.go returns the key on Localize error).
// These two keys are the constants in i18n/keys.go lines 41-42.

const (
	MsgRelayModelPriceNotConfigured      = "relay.model_price_not_configured"
	MsgRelayModelPriceNotConfiguredAdmin = "relay.model_price_not_configured_admin"
)

func T(c *hostctx.Context, key string, args ...map[string]any) string {
	return key
}
