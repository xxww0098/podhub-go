package x1repo

import "context"

// ConfigValidator runs the shared Rust supplier-default rules against current material.
type ConfigValidator func(ctx context.Context, material, config []byte) ([]byte, error)
