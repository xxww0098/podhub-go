package archtest

import "testing"

// TestAdminCoreRepoExceptionIsNarrow pins the one non-contract cross-unit
// import: the repo layer of admin or admin/<topic> may import admin/core/repo.
func TestAdminCoreRepoExceptionIsNarrow(t *testing.T) {
	level["admin/topic"] = 6
	defer delete(level, "admin/topic")
	cases := []struct {
		from, fromLayer, to, toLayer string
		ok                           bool
	}{
		{"admin", "repo", "admin/core", "repo", true},
		{"admin/topic", "repo", "admin/core", "repo", true},
		{"admin/topic", "repo", "admin/core", "contract", true},
		{"admin", "domain", "admin/core", "contract", true},

		{"admin", "service", "admin/core", "repo", false},
		{"admin", "http", "admin/core", "repo", false},
		{"admin", "domain", "admin/core", "repo", false},
		{"admin", "", "admin/core", "repo", false},
		{"admin/topic", "service", "admin/core", "repo", false},
		{"admin/topic", "http", "admin/core", "repo", false},
		{"admin/topic", "jobs", "admin/core", "repo", false},
		{"admin/topic", "repo", "admin/core", "service", false},
		{"admin/topic", "repo", "admin/core", "domain", false},
		{"admin/topic", "repo", "admin", "repo", false},
		{"admin", "repo", "admin/topic", "repo", false},
		{"admin/topic", "repo", "admin/topic2", "repo", false},
		{"administer", "repo", "admin/core", "repo", false},
		{"supplier", "repo", "admin/core", "repo", false},
		{"listing/submit", "repo", "admin/core", "repo", false},
		{"supplier", "repo", "shipping", "repo", false},
		{"admin/core", "contract", "admin", "contract", false},
		{"admin/topic", "contract", "admin", "contract", false},
	}
	for _, c := range cases {
		got := crossUnit(c.from, c.fromLayer, c.to, c.toLayer) == ""
		if got != c.ok {
			t.Errorf("%s/%s -> %s/%s: allowed=%v, want %v", c.from, c.fromLayer, c.to, c.toLayer, got, c.ok)
		}
	}
}

// TestAdminCoreRepoExceptionMatchesTree runs the real tree through the same
// check: every import that reaches admin/core/repo comes from an allowed repo.
func TestAdminCoreRepoExceptionMatchesTree(t *testing.T) {
	const target = modulePath + "internal/admin/core/repo"
	for _, p := range load(t, "../..") {
		for _, imp := range p.imports {
			if imp != target || p.unit == "admin/core" {
				continue
			}
			if p.root != "unit" || !adminCoreRepo(p.unit, p.layer, "admin/core", "repo") {
				t.Errorf("%s imports admin/core/repo", p.rel)
			}
		}
	}
}
