// Command funcbodyhash compares function declarations before and after a
// same-package file split. It prints one line per function and exits non-zero
// when a body or a declaration from -before is missing or different in -after.
//
//	go run scripts/funcbodyhash.go -before HEAD -file internal/identity/service.go -after internal/identity
//
// The declaration hash covers the bytes from the func keyword through the
// closing brace. The body hash covers the bytes from the opening brace through
// the closing brace. Doc comments are not part of either hash.
package main

import (
	"crypto/sha256"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

func main() {
	before := flag.String("before", "", "git ref whose file is the pre-split source (empty: hash -after only)")
	file := flag.String("file", "", "repo-relative path of the pre-split file")
	after := flag.String("after", "", "directory of Go files to hash")
	flag.Parse()
	if *after == "" {
		fmt.Fprintln(os.Stderr, "need -after")
		os.Exit(2)
	}
	afterFuncs, err := hashDir(*after)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if *before == "" {
		for _, f := range afterFuncs {
			fmt.Printf("%s\tdecl %s\tbody %s\n", f.key, f.decl, f.body)
		}
		return
	}
	if *file == "" {
		fmt.Fprintln(os.Stderr, "need -file with -before")
		os.Exit(2)
	}
	src, err := gitShow(*before, *file)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	beforeFuncs, err := hashSource(*file, src)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	byKey := map[string]hashed{}
	for _, f := range afterFuncs {
		byKey[f.key] = f
	}
	bad := 0
	for _, f := range beforeFuncs {
		got, ok := byKey[f.key]
		if !ok {
			fmt.Printf("MISSING %s\n", f.key)
			bad++
			continue
		}
		if got.decl != f.decl || got.body != f.body {
			fmt.Printf("CHANGED %s\n  before decl %s body %s\n  after  decl %s body %s\n", f.key, f.decl, f.body, got.decl, got.body)
			bad++
			continue
		}
		fmt.Printf("SAME %s\tdecl %s\tbody %s\n", f.key, f.decl, f.body)
	}
	if bad > 0 {
		os.Exit(1)
	}
}

type hashed struct {
	key  string
	decl string
	body string
}

func gitShow(ref, file string) ([]byte, error) {
	out, err := exec.Command("git", "show", ref+":"+file).Output()
	if err != nil {
		return nil, fmt.Errorf("git show %s:%s: %w", ref, file, err)
	}
	return out, nil
}

func hashDir(dir string) ([]hashed, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []hashed
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		src, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil, err
		}
		funcs, err := hashSource(name, src)
		if err != nil {
			return nil, err
		}
		out = append(out, funcs...)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].key < out[j].key })
	return out, nil
}

func hashSource(name string, src []byte) ([]hashed, error) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, name, src, parser.ParseComments)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	tf := fset.File(f.Pos())
	var out []hashed
	for _, d := range f.Decls {
		fn, ok := d.(*ast.FuncDecl)
		if !ok || fn.Body == nil {
			continue
		}
		key := fn.Name.Name
		if fn.Recv != nil && len(fn.Recv.List) > 0 {
			key = recvName(fn.Recv.List[0].Type) + "." + key
		}
		decl := src[tf.Offset(fn.Pos()):tf.Offset(fn.End())]
		body := src[tf.Offset(fn.Body.Lbrace) : tf.Offset(fn.Body.Rbrace)+1]
		out = append(out, hashed{key: key, decl: sum(decl), body: sum(body)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].key < out[j].key })
	return out, nil
}

func recvName(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.StarExpr:
		return recvName(t.X)
	case *ast.Ident:
		return t.Name
	default:
		return "?"
	}
}

func sum(b []byte) string {
	h := sha256.Sum256(b)
	return fmt.Sprintf("%x", h[:8])
}
