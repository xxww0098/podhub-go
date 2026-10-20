package domain

import "github.com/xxww0098/podhub-go/internal/warehouse/contract"

// CheckWrite is the pre-grant status check. create has no warehouse row.
// Archive requires confirm and the cached active status. Unarchive requires
// the local archived mark; a non-active Ozon status without that mark is
// refused because the archived status string is not verified.
func CheckWrite(kind string, confirm bool, warehouseID int64, row *contract.Warehouse, found bool) error {
	switch kind {
	case contract.KindCreate:
		if warehouseID != 0 {
			return contract.BadRequest("创建仓库不要带 warehouse_id")
		}
		return nil
	case contract.KindUpdate, contract.KindFirstMile:
		if warehouseID <= 0 {
			return contract.BadRequest("缺少 warehouse_id")
		}
		if !found {
			return contract.NotSynced()
		}
		return nil
	case contract.KindArchive:
		if !confirm || warehouseID <= 0 {
			return contract.ConfirmRequired()
		}
		if !found {
			return contract.NotSynced()
		}
		if row.Archived || row.Status != ActiveStatus {
			return contract.WarehouseStatus()
		}
		return nil
	case contract.KindUnarchive:
		if warehouseID <= 0 {
			return contract.BadRequest("缺少 warehouse_id")
		}
		if !found {
			return contract.NotSynced()
		}
		if !row.Archived {
			return contract.WarehouseStatus()
		}
		return nil
	default:
		return contract.BadRequest("不支持的写操作")
	}
}

// KnownKind reports whether kind is one of the fenced writes.
func KnownKind(kind string) bool {
	switch kind {
	case contract.KindCreate, contract.KindUpdate, contract.KindArchive, contract.KindUnarchive, contract.KindFirstMile:
		return true
	default:
		return false
	}
}
