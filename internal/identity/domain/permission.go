package domain

// PlatformPermission is a platform audience, independent of a workspace seat.
type PlatformPermission int

const (
	PermManagePlatform PlatformPermission = iota
	PermManageSupplierCatalog
	PermManageDelegateOrders
	PermManageSupplierAccounts
	PermManageSupplierWithdrawals
	PermObserveTenantBusiness
)

// PlatformPermissions is the closed set.
var PlatformPermissions = []PlatformPermission{
	PermManagePlatform,
	PermManageSupplierCatalog,
	PermManageDelegateOrders,
	PermManageSupplierAccounts,
	PermManageSupplierWithdrawals,
	PermObserveTenantBusiness,
}

func (p PlatformPermission) Allows(role Role) bool {
	switch p {
	case PermManagePlatform, PermObserveTenantBusiness:
		return role.IsSuperAdmin()
	default:
		return role.IsStaff()
	}
}

func (p PlatformPermission) Refusal() string {
	switch p {
	case PermManagePlatform, PermObserveTenantBusiness:
		return "需要超级管理员权限"
	default:
		return "需要平台管理员权限"
	}
}
