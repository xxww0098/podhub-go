package archtest

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

func TestQueueDependenciesAreExplicit(t *testing.T) {
	root := "../.."
	for _, p := range load(t, root) {
		if p.rel != "internal/queue/contract" {
			continue
		}
		for _, imp := range p.imports {
			if strings.HasPrefix(imp, modulePath+"internal/") {
				t.Errorf("queue/contract must own its types without other internal packages: %s", imp)
			}
		}
	}
	err := filepath.WalkDir(filepath.Join(root, "internal/queue"), func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return err
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			return err
		}
		for _, decl := range file.Decls {
			switch decl := decl.(type) {
			case *ast.FuncDecl:
				if decl.Name.Name == "init" {
					t.Errorf("%s: queue dependencies must be passed by app", path)
				}
			case *ast.GenDecl:
				if decl.Tok != token.VAR {
					continue
				}
				for _, spec := range decl.Specs {
					if value, ok := spec.(*ast.ValueSpec); ok {
						if _, ok := value.Type.(*ast.FuncType); ok {
							t.Errorf("%s: function ports must belong to instances", path)
						}
					}
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
