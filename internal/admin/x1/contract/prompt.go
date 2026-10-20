package contract

import corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"

// Prompt is SupplierPromptData. The struct lives in core so admin/supplier
// can scan it without importing this unit.
type Prompt = corecontract.Prompt
