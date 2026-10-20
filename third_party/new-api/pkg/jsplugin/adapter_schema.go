package jsplugin

import "regexp"

// Podhub adapter. Not a copy of pkg/jsplugin/registry.go (plugin runtime).
// ValidPluginKey matches registry.go lines 39-46 at 3e2ce2c. UsageFieldSchema
// keeps the three fields tiered_billing.go reads (Type, Unit, Enum).

var pluginKeyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)

func ValidPluginKey(key string) bool {
	return len(key) <= 30 && pluginKeyPattern.MatchString(key)
}

type UsageFieldSchema struct {
	Type string
	Unit string
	Enum []string
}
