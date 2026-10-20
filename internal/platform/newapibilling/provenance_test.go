package newapibilling

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"
)

const hostctxImport = `"github.com/QuantumNous/new-api/hostctx"`

// modifiedFormula lists the copied files whose only change is the gin import.
// upstream is the sha256 of the file at the provenance commit; the same bytes
// are kept under third_party/new-api/testdata/upstream.
var modifiedFormula = []struct {
	path     string
	upstream string
	ginPath  string
	renames  map[string]string
}{
	{"service/text_quota.go", "bfc67843b14994e1a996b0e010a183fd187e3d03d50251b2a73cba92f19bd919", `"github.com/gin-gonic/gin"`, ginRenames},
	{"relay/helper/billing_expr_request.go", "eaf726ee45ca4b78633e75e63ba39b1fbe0c3ea0f0b237b90f6a2008fa830289", `"github.com/gin-gonic/gin"`, ginRenames},
	{"relay/helper/price.go", "cba578ed51690a0628abba97b8743a04788d81569503bb94520612e2ba67b3b1", `"github.com/gin-gonic/gin"`, ginRenames},
	{"setting/ratio_setting/exposed_cache.go", "3a568fe9bfeded55627807c4e5152614cff955b1d8c632da13d9d2b635efde77", `"github.com/gin-gonic/gin"`, ginRenames},
	{"common/message.go", "8ce5bf4161176d064a1920739cefb084e9c667cd6c736741d128fd16ec206d77", `"github.com/gin-gonic/gin"`, ginRenames},
	{"common/json.go", "6e18f45f05aa15c13fb664ddc9dbeb608d182a7c84d20016249e42ffeb0e3e26", `"github.com/gin-gonic/gin/binding"`, map[string]string{"binding.Validator": "hostctx.Validator"}},
}

var ginRenames = map[string]string{"gin.Context": "hostctx.Context", "gin.H": "hostctx.H"}

func newAPIRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("caller")
	}
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "third_party", "new-api")
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// splitImports returns the import paths and every line outside the import block.
func splitImports(t *testing.T, src string) (imports []string, body []string) {
	t.Helper()
	lines := strings.Split(src, "\n")
	in := false
	for _, line := range lines {
		switch {
		case !in && line == "import (":
			in = true
		case in && line == ")":
			in = false
		case in:
			if f := strings.Fields(line); len(f) > 0 {
				imports = append(imports, f[len(f)-1])
			}
		default:
			body = append(body, line)
		}
	}
	if in || imports == nil {
		t.Fatal("no import block")
	}
	sort.Strings(imports)
	return imports, body
}

func TestModifiedFormulaDiffersOnlyInGinTypes(t *testing.T) {
	root := newAPIRoot(t)
	for _, f := range modifiedFormula {
		t.Run(f.path, func(t *testing.T) {
			orig, err := os.ReadFile(filepath.Join(root, "testdata", "upstream", f.path+".orig"))
			if err != nil {
				t.Fatal(err)
			}
			if got := sha256Hex(orig); got != f.upstream {
				t.Fatalf("upstream copy sha256 %s, want %s", got, f.upstream)
			}
			cur, err := os.ReadFile(filepath.Join(root, f.path))
			if err != nil {
				t.Fatal(err)
			}
			origImports, origBody := splitImports(t, string(orig))
			curImports, curBody := splitImports(t, string(cur))

			var want []string
			for _, imp := range origImports {
				if imp != f.ginPath {
					want = append(want, imp)
				}
			}
			if len(want) != len(origImports)-1 {
				t.Fatalf("upstream does not import %s", f.ginPath)
			}
			want = append(want, hostctxImport)
			sort.Strings(want)
			if strings.Join(curImports, " ") != strings.Join(want, " ") {
				t.Fatalf("imports\n got %v\nwant %v", curImports, want)
			}

			if len(curBody) != len(origBody) {
				t.Fatalf("body has %d lines, upstream %d", len(curBody), len(origBody))
			}
			changed := 0
			for i := range origBody {
				expect := origBody[i]
				for from, to := range f.renames {
					expect = regexp.MustCompile(`\b`+regexp.QuoteMeta(from)+`\b`).ReplaceAllString(expect, to)
				}
				if curBody[i] != expect {
					t.Fatalf("line %d differs beyond the gin rename\n got %q\nwant %q", i+1, curBody[i], expect)
				}
				if curBody[i] != origBody[i] {
					changed++
				}
			}
			if changed == 0 {
				t.Fatal("no gin type was renamed")
			}
			if bytes.Contains(cur, []byte("gin-gonic")) {
				t.Fatal("still names gin-gonic")
			}
		})
	}
}

// Every row in the PROVENANCE verbatim table still has the upstream bytes.
func TestVerbatimFilesMatchProvenance(t *testing.T) {
	root := newAPIRoot(t)
	doc, err := os.ReadFile(filepath.Join(root, "PROVENANCE.md"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(doc)
	start := strings.Index(text, "## 逐字文件")
	end := strings.Index(text[start+1:], "\n## ")
	if start < 0 || end < 0 {
		t.Fatal("verbatim section not found")
	}
	row := regexp.MustCompile("(?m)^\\| `([0-9a-f]{64})` \\| `([^`]+)` \\|$")
	rows := row.FindAllStringSubmatch(text[start:start+1+end], -1)
	if len(rows) < 40 {
		t.Fatalf("only %d verbatim rows", len(rows))
	}
	modified := map[string]bool{}
	for _, f := range modifiedFormula {
		modified[f.path] = true
	}
	for _, r := range rows {
		if modified[r[2]] {
			t.Errorf("%s is modified but listed as verbatim", r[2])
		}
		data, err := os.ReadFile(filepath.Join(root, r[2]))
		if err != nil {
			t.Error(err)
			continue
		}
		if got := sha256Hex(data); got != r[1] {
			t.Errorf("%s sha256 %s, PROVENANCE says %s", r[2], got, r[1])
		}
	}
}

func TestNoPackageLinksGin(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go tool not on PATH")
	}
	cmd := exec.Command("go", "list", "-deps", "./...")
	cmd.Dir = filepath.Join(newAPIRoot(t), "..", "..")
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	for _, pkg := range strings.Fields(string(out)) {
		if strings.HasPrefix(pkg, "github.com/gin-gonic/") {
			t.Fatalf("module depends on %s", pkg)
		}
	}
}
