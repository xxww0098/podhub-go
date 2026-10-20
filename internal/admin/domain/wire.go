package domain

import (
	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	supcontract "github.com/xxww0098/podhub-go/internal/admin/supplier/contract"
)

// SupplierDb and Prop are the supplier wire rows. The types live in core so
// admin/x1 and the remaining admin repo share them.
type (
	SupplierDb = corecontract.SupplierDb
	Prop       = corecontract.Prop
)

type (
	SourceRef    = supcontract.SourceRef
	Member       = supcontract.Member
	AccountGroup = supcontract.AccountGroup
)

// GroupAccounts keeps adjacent rows that share a source id together.
func GroupAccounts(rows []Member) []AccountGroup { return supcontract.GroupAccounts(rows) }
