package domain

import "strconv"

// SafeContinueKey includes the current millisecond and changes on every call.
func SafeContinueKey(storeUUID, presetID string, version, nowMs int64) string {
	return "ship-inject:" + storeUUID + ":" + presetID + ":" + strconv.FormatInt(version, 10) + ":safe-continue:" + strconv.FormatInt(nowMs, 10)
}

// ReconcileKey is stable for a plan version and contains no clock.
func ReconcileKey(storeUUID, presetID string, version int64) string {
	return "ship-inject:" + storeUUID + ":" + presetID + ":" + strconv.FormatInt(version, 10) + ":reconcile"
}
