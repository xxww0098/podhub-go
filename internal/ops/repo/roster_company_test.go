package repo

import (
	"strings"
	"testing"
)

func TestRosterSQLDoesNotProjectCompanyNames(t *testing.T) {
	if strings.Contains(rosterSQL, "company_") || strings.Contains(rosterSQL, "name_source") {
		t.Fatal("roster sql changed")
	}
}
