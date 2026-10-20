// Package domain decides platform staff from the role names documented on
// access.Principal: user, admin, or super_admin.
package domain

import "strings"

// PlatformStaff is admin or super_admin after trim and ASCII lower.
func PlatformStaff(role string) bool {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "admin", "super_admin":
		return true
	default:
		return false
	}
}

// SuperAdmin is the platform role super_admin after trim and ASCII lower.
func SuperAdmin(role string) bool {
	return strings.ToLower(strings.TrimSpace(role)) == "super_admin"
}
