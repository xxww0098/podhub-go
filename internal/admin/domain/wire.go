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
	FactoryRef     = supcontract.FactoryRef
	Factory        = supcontract.Factory
	FactoryInput   = supcontract.FactoryInput
	Member         = supcontract.Member
	AccountGroup   = supcontract.AccountGroup
	Fulfiller      = supcontract.Fulfiller
	CatalogManager = supcontract.CatalogManager
)

// GroupAccounts keeps adjacent rows that share a factory together.
func GroupAccounts(rows []Member) []AccountGroup { return supcontract.GroupAccounts(rows) }
