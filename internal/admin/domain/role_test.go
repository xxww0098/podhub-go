package domain

import "testing"

func TestPlatformStaff(t *testing.T) {
	for _, role := range []string{"admin", " super_admin ", "ADMIN"} {
		if !PlatformStaff(role) {
			t.Fatal(role)
		}
	}
	for _, role := range []string{"", "user", "owner", "superadmin"} {
		if PlatformStaff(role) {
			t.Fatal(role)
		}
	}
}

func TestSuperAdmin(t *testing.T) {
	if !SuperAdmin(" super_admin ") || SuperAdmin("admin") || SuperAdmin("user") {
		t.Fatal(SuperAdmin("admin"))
	}
}
