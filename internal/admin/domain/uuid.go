package domain

import corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"

// NormalizeUUID is Scope::normalize_uuid: trim, lower, 36 chars, dashes, hex.
func NormalizeUUID(raw string) (string, bool) { return corecontract.NormalizeUUID(raw) }
