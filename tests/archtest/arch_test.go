// Package archtest enforces the layering rules in docs/architecture-tree.md.
// It parses imports only (no type-checking), so it runs in under a second.
package archtest

import (
	"bufio"
	"flag"
	"go/parser"
	"go/scanner"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
)

const modulePath = "github.com/xxww0098/podhub-go/"

var update = flag.Bool("update", false, "rewrite baseline.txt with the current violations")

// layer directory names that may appear inside a unit.
var layers = map[string]bool{"domain": true, "service": true, "repo": true, "http": true, "jobs": true, "contract": true, "gen": true}

// level is the DAG rank of every unit. A unit may import another unit's
// contract package only when the target has a strictly lower level.
// Unknown units fail the test: add the unit here when you add a domain.
var level = map[string]int{
	"identity": 1,
	"queue":    2, "media": 2, "catalog": 2, "billing": 2, "seller": 2, "telemetry": 2,
	"listing/core": 3, "ai": 3, "supply": 3, "delegate": 3, "supplier": 3, "agent": 3, "ops": 3, "shipping": 3, "ozonerr": 3, "ratings": 3, "warehouse": 3, "store": 3,
	"listing/rules": 4, "automation": 4,
	"listing/read": 5, "listing/write": 5,
	"listing/submit": 6, "mcp": 6,
	// listing/http/gen is the merged listing wire unit (jobs + submit).
	"listing": 6,
	// admin is split by topic (docs/architecture-tree.md). admin/core holds the
	// shared contract and repo plumbing; admin/<topic> sits between it and admin.
	"admin/core":     5,
	"admin/billing":  6,
	"admin/catalog":  6,
	"admin/delegate": 6,
	"admin/observe":  6,
	"admin/shipping": 6,
	"admin/supplier": 6,
	"admin/users":    6,
	"admin/x1":       6,
	"admin":          7,
}

// deny lists third-party prefixes by layer.
var deny = map[string][]string{
	"domain":   {"github.com/jackc/", "github.com/go-chi/", "github.com/aws/", "github.com/riverqueue/", "go.opentelemetry.io/", "net/http"},
	"contract": {"github.com/jackc/", "github.com/go-chi/", "github.com/aws/", "github.com/riverqueue/"},
	"service":  {"github.com/go-chi/", "net/http"},
}

// onlyIn pins a third-party module to the single package tree allowed to import it.
var onlyIn = map[string]string{
	"github.com/QuantumNous/new-api/relaykit": "internal/platform/llm",
	"github.com/aws/aws-sdk-go-v2":            "internal/platform/r2",
	"github.com/tetratelabs/wazero":           "internal/platform/wasm",
	"github.com/pressly/goose":                "internal/platform/db",
}

// pkg describes one directory under internal/.
type pkg struct {
	rel     string // e.g. internal/listing/submit/service
	unit    string // e.g. listing/submit ("" for platform/app)
	layer   string // e.g. service ("" when flat)
	root    string // platform | app | unit
	imports []string
}

func classify(rel string) (unit, layer, root string) {
	parts := strings.Split(strings.TrimPrefix(rel, "internal/"), "/")
	switch parts[0] {
	case "platform":
		return "", "", "platform"
	case "app":
		return "", "", "app"
	}
	for i, p := range parts {
		if layers[p] {
			return strings.Join(parts[:i], "/"), p, "unit"
		}
	}
	return strings.Join(parts, "/"), "", "unit"
}

func load(t *testing.T, root string) []pkg {
	var out []pkg
	err := filepath.WalkDir(filepath.Join(root, "internal"), func(path string, d fs.DirEntry, err error) error {
		if err != nil || !d.IsDir() {
			return err
		}
		files, _ := filepath.Glob(filepath.Join(path, "*.go"))
		seen := map[string]bool{}
		for _, f := range files {
			if strings.HasSuffix(f, "_test.go") || strings.HasSuffix(f, ".gen.go") {
				continue
			}
			af, err := parser.ParseFile(token.NewFileSet(), f, nil, parser.ImportsOnly)
			if err != nil {
				return err
			}
			for _, im := range af.Imports {
				p, _ := strconv.Unquote(im.Path.Value)
				seen[p] = true
			}
		}
		if len(seen) == 0 && len(files) == 0 {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		u, l, r := classify(rel)
		p := pkg{rel: rel, unit: u, layer: l, root: r}
		for k := range seen {
			p.imports = append(p.imports, k)
		}
		sort.Strings(p.imports)
		out = append(out, p)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func violations(t *testing.T, root string) []string {
	var v []string
	add := func(p pkg, imp, why string) {
		v = append(v, p.rel+" -> "+strings.TrimPrefix(imp, modulePath)+" : "+why)
	}
	for _, p := range load(t, root) {
		if p.root == "unit" {
			if _, ok := level[p.unit]; !ok {
				v = append(v, p.rel+" : unit "+p.unit+" is not in the level table")
			}
		}
		for _, imp := range p.imports {
			for _, d := range deny[p.layer] {
				if strings.HasPrefix(imp, d) {
					add(p, imp, p.layer+" must not import "+d)
				}
			}
			for mod, dir := range onlyIn {
				if strings.HasPrefix(imp, mod) && !strings.HasPrefix(p.rel, dir) {
					add(p, imp, mod+" may only be imported under "+dir)
				}
			}
			if !strings.HasPrefix(imp, modulePath+"internal/") {
				continue
			}
			rel := strings.TrimPrefix(imp, modulePath)
			iu, il, ir := classify(rel)
			switch {
			case p.root == "platform" && ir != "platform":
				add(p, imp, "platform must not import business or app code")
			case p.root == "unit" && ir == "app":
				add(p, imp, "units must not import app")
			case p.root == "unit" && ir == "unit" && iu == p.unit:
				if bad := sameUnit(p.layer, il); bad != "" {
					add(p, imp, bad)
				}
			case p.root == "unit" && ir == "unit":
				if bad := crossUnit(p.unit, p.layer, iu, il); bad != "" {
					add(p, imp, bad)
				}
			}
		}
	}
	sort.Strings(v)
	return v
}

// crossUnit checks an import between two different units; "" means allowed.
// The only non-contract target is admin/core/repo, and only from the repo
// layer of admin or an admin/<topic> unit. admin/core/repo is pgx plumbing
// (audit row, error mapping, lease) that cannot live in a contract package.
func crossUnit(fromUnit, fromLayer, toUnit, toLayer string) string {
	if toLayer != "contract" && !adminCoreRepo(fromUnit, fromLayer, toUnit, toLayer) {
		return "cross-unit imports may only target <unit>/contract"
	}
	if level[toUnit] >= level[fromUnit] {
		return "contract of a unit at the same or higher level (cycle risk)"
	}
	return ""
}

func adminCoreRepo(fromUnit, fromLayer, toUnit, toLayer string) bool {
	if toUnit != "admin/core" || toLayer != "repo" || fromLayer != "repo" {
		return false
	}
	return fromUnit == "admin" || (strings.HasPrefix(fromUnit, "admin/") && fromUnit != "admin/core")
}

// sameUnit encodes the in-unit layer matrix; "" means allowed.
func sameUnit(from, to string) string {
	allow := map[string][]string{
		"domain":   {"domain", "contract"},
		"contract": {},
		"repo":     {"domain", "contract", "gen"},
		"service":  {"domain", "contract"},
		"http":     {"service", "domain", "contract", "gen"},
		"jobs":     {"service", "domain", "contract"},
		"":         {"", "domain", "service", "repo", "http", "jobs", "contract", "gen"}, // flat package: unit root
	}
	if from == "gen" {
		return ""
	}
	for _, ok := range allow[from] {
		if ok == to {
			return ""
		}
	}
	return from + " must not import " + to + " of the same unit"
}

func TestImportRules(t *testing.T) {
	root := filepath.Join("..", "..")
	got := violations(t, root)
	if *update {
		refuseBaselineUpdate(t)
		mergeBaseline(t, false, got)
		return
	}
	ratchet(t, readBaseline(t, false), got)
	// R9: cmd may import the standard library and internal/app only.
	checkCmdImports(t, root)
}

func checkCmdImports(t *testing.T, root string) {
	t.Helper()
	err := filepath.WalkDir(filepath.Join(root, "cmd"), func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return err
		}
		af, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		for _, im := range af.Imports {
			p, _ := strconv.Unquote(im.Path.Value)
			if allowedCmdImport(p) {
				continue
			}
			t.Errorf("%s: cmd may only import internal/app, found %s", rel, p)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func allowedCmdImport(p string) bool {
	const app = modulePath + "internal/app"
	if p == app || strings.HasPrefix(p, app+"/") {
		return true
	}
	first, _, _ := strings.Cut(p, "/")
	return !strings.Contains(first, ".")
}

// TestSingleParsePoints keeps the protected switches and RLS seam in one place.
// Hits outside the allowed platform directories are baseline entries. A
// fixed hit must have its baseline line deleted. The needles and allowed
// directories are not widened to hide the current tree.
func TestSingleParsePoints(t *testing.T) {
	root := filepath.Join("..", "..")
	got := parsePointViolations(root)
	if *update {
		refuseBaselineUpdate(t)
		mergeBaseline(t, true, got)
		return
	}
	ratchet(t, readBaseline(t, true), got)
}

// How a single-parse needle is recognized in non-test Go source.
type matchMode int

const (
	// matchQuoted is an exact double-quoted Go literal. Comments and longer
	// strings that only mention the name do not count.
	matchQuoted matchMode = iota
	// matchText is a raw substring, used for call patterns such as pgxpool.New(.
	matchText
	// matchGUC is the exact literal, the same text inside a raw string, or the
	// SQL form 'app.current_org_id' inside any Go string. matchQuoted alone
	// misses the name inside backtick queries.
	matchGUC
	// matchSelector is a package selector (os.Getenv). Comments and string
	// literals that spell the same text do not count.
	matchSelector
)

func parsePointViolations(root string) []string {
	var v []string
	rules := []struct {
		needle string
		okDir  string
		mode   matchMode
	}{
		{"OZON_WRITE_KILL_SWITCH", "internal/platform/config", matchQuoted},
		{"CLOUD_MEDIA_GC_DELETE", "internal/platform/config", matchQuoted},
		{"CLOUD_SELLER_BASE_URL", "internal/platform/config", matchQuoted},
		{"CLOUD_AI_EGRESS_ALLOW_PUBLIC", "internal/platform/config", matchQuoted},
		{"PODHUB_ALLOW_SUPERUSER_DB", "internal/platform/config", matchQuoted},
		{"SHIPPING_INJECT_OZON_WRITES", "internal/platform/config", matchQuoted},
		{"app.current_org_id", "internal/platform/db/tenantx", matchGUC},
		{"pgxpool.NewWithConfig(", "internal/platform/db", matchText},
		{"pgxpool.New(", "internal/platform/db", matchText},
		{"os.Getenv", "internal/platform/config", matchSelector},
		{"os.LookupEnv", "internal/platform/config", matchSelector},
	}
	_ = filepath.WalkDir(filepath.Join(root, "internal"), func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return err
		}
		b, _ := os.ReadFile(path)
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		src := string(b)
		for _, r := range rules {
			if strings.HasPrefix(rel, r.okDir+"/") {
				continue
			}
			if sourceHits(src, r.needle, r.mode) {
				v = append(v, rel+": "+strconv.Quote(r.needle)+" may only appear under "+r.okDir)
			}
		}
		return nil
	})
	sort.Strings(v)
	return v
}

func sourceHits(src, needle string, mode matchMode) bool {
	switch mode {
	case matchText:
		return strings.Contains(src, needle)
	case matchQuoted:
		return strings.Contains(src, `"`+needle+`"`)
	case matchGUC:
		return gucInSource(src, needle)
	case matchSelector:
		return selectorInSource(src, needle)
	default:
		return false
	}
}

func gucInSource(src, needle string) bool {
	quoted := `"` + needle + `"`
	sqlQuoted := "'" + needle + "'"
	return scanTokens(src, func(tok token.Token, lit string) bool {
		if tok != token.STRING {
			return false
		}
		if lit == quoted || strings.Contains(lit, sqlQuoted) {
			return true
		}
		return len(lit) >= 2 && lit[0] == '`' && strings.Contains(lit[1:len(lit)-1], needle)
	})
}

func selectorInSource(src, needle string) bool {
	pkg, name, ok := strings.Cut(needle, ".")
	if !ok || pkg == "" || name == "" {
		return false
	}
	var older, prev struct {
		tok token.Token
		lit string
	}
	return scanTokens(src, func(tok token.Token, lit string) bool {
		hit := tok == token.IDENT && lit == name &&
			prev.tok == token.PERIOD &&
			older.tok == token.IDENT && older.lit == pkg
		older = prev
		prev.tok = tok
		prev.lit = lit
		return hit
	})
}

func scanTokens(src string, hit func(token.Token, string) bool) bool {
	var s scanner.Scanner
	fset := token.NewFileSet()
	file := fset.AddFile("src.go", fset.Base(), len(src))
	s.Init(file, []byte(src), nil, 0)
	for {
		_, tok, lit := s.Scan()
		if tok == token.EOF {
			return false
		}
		if hit(tok, lit) {
			return true
		}
	}
}

const parseSection = "# single-parse-points"

// refuseBaselineUpdate blocks go test -update on a CI runner. The workflow
// does not pass -update; this still refuses if a later edit adds the flag.
func refuseBaselineUpdate(t *testing.T) {
	t.Helper()
	if os.Getenv("CI") != "" || os.Getenv("GITHUB_ACTIONS") != "" {
		t.Fatal("refusing -update in CI; the baseline is not rewritten on the runner")
	}
}

var baselineMu sync.Mutex

func baselineFile() string { return "baseline.txt" }

func readBaseline(t *testing.T, parse bool) map[string]bool {
	t.Helper()
	imports, parses := splitBaseline(t)
	lines := imports
	if parse {
		lines = parses
	}
	known := map[string]bool{}
	for _, s := range lines {
		known[s] = true
	}
	return known
}

func splitBaseline(t *testing.T) (imports, parses []string) {
	t.Helper()
	f, err := os.Open(baselineFile())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		t.Fatal(err)
	}
	defer f.Close()
	section := "import"
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		s := strings.TrimSpace(sc.Text())
		if s == "" {
			continue
		}
		if s == parseSection {
			section = "parse"
			continue
		}
		if strings.HasPrefix(s, "#") {
			continue
		}
		if section == "parse" {
			parses = append(parses, s)
		} else {
			imports = append(imports, s)
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return imports, parses
}

func mergeBaseline(t *testing.T, parse bool, got []string) {
	t.Helper()
	baselineMu.Lock()
	defer baselineMu.Unlock()
	imports, parses := splitBaseline(t)
	if parse {
		parses = append([]string(nil), got...)
	} else {
		imports = append([]string(nil), got...)
	}
	sort.Strings(imports)
	sort.Strings(parses)
	var b strings.Builder
	if len(imports) > 0 {
		b.WriteString(strings.Join(imports, "\n"))
		b.WriteString("\n")
	}
	b.WriteString(parseSection)
	b.WriteString("\n")
	if len(parses) > 0 {
		b.WriteString(strings.Join(parses, "\n"))
		b.WriteString("\n")
	}
	if err := os.WriteFile(baselineFile(), []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
}

func ratchet(t *testing.T, known map[string]bool, got []string) {
	t.Helper()
	cur := map[string]bool{}
	for _, g := range got {
		cur[g] = true
		if !known[g] {
			t.Errorf("new layering violation: %s", g)
		}
	}
	for k := range known { // ratchet: fixed entries must be deleted from the baseline
		if !cur[k] {
			t.Errorf("baseline entry is fixed, delete it: %s", k)
		}
	}
}
