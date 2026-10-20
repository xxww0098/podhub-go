package testkit

import "strings"

// fingerprintTable is one head table from
// tests/integration/testdata/expected-head-fingerprint.json.
type fingerprintTable struct {
	Name    string
	Columns []fingerprintColumn
	Checks  map[string]string
	RLS     bool
	Rows    int64
}

type fingerprintColumn struct {
	Name     string
	Type     string
	NotNull  bool
	Identity bool
	Default  string
}

// loadFingerprintTables reads the head fingerprint the schema comparison uses.
// The JSON file is the only copy; there is no rendered markdown appendix.
func loadFingerprintTables() ([]fingerprintTable, error) {
	fp, err := loadHeadFingerprint()
	if err != nil {
		return nil, err
	}
	tables := make([]fingerprintTable, 0, len(fp.Fingerprint.Tables))
	for _, table := range fp.Fingerprint.Tables {
		out := fingerprintTable{
			Name:    table.Name,
			Checks:  map[string]string{},
			RLS:     table.RowSecurity.Enabled,
			Rows:    table.RowCount,
			Columns: make([]fingerprintColumn, 0, len(table.Columns)),
		}
		for _, col := range table.Columns {
			def := ""
			if col.Default != nil {
				def = normSQL(*col.Default)
			}
			out.Columns = append(out.Columns, fingerprintColumn{
				Name:     col.Name,
				Type:     col.SQLType,
				NotNull:  !col.Nullable,
				Identity: col.Identity != "",
				Default:  def,
			})
		}
		for _, cons := range table.Constraints {
			out.Checks[cons.Name] = normSQL(cons.Definition)
		}
		tables = append(tables, out)
	}
	return tables, nil
}

func normSQL(s string) string {
	s = strings.ToLower(s)
	s = strings.ReplaceAll(s, " ", "")
	s = strings.ReplaceAll(s, "\n", "")
	s = strings.ReplaceAll(s, "::text", "")
	s = strings.ReplaceAll(s, "::character varying", "")
	s = strings.ReplaceAll(s, "::jsonb", "")
	for strings.Contains(s, "((") {
		s = strings.ReplaceAll(s, "((", "(")
		s = strings.ReplaceAll(s, "))", ")")
	}
	return s
}
