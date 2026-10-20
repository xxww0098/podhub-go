package db

import "testing"

func TestAllowSuperuserDBOnlyLiteralOne(t *testing.T) {
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "")
	if allowSuperuserDB() {
		t.Fatal("unset allows a privileged login")
	}
	for _, value := range []string{"true", "yes", "on", "0", " 1"} {
		t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", value)
		if allowSuperuserDB() {
			t.Fatalf("%q allows a privileged login", value)
		}
	}
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	if !allowSuperuserDB() {
		t.Fatal("1 does not allow a privileged login")
	}
}
