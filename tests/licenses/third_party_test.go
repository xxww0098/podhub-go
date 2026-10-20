package licenses

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// gnuAGPLv3SHA256 is the SHA-256 of https://www.gnu.org/licenses/agpl-3.0.txt.
const gnuAGPLv3SHA256 = "0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0"

func TestRootLicenseIsAGPL3Only(t *testing.T) {
	root := repoRoot(t)
	license, err := os.ReadFile(filepath.Join(root, "LICENSE"))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(license)
	if got := hex.EncodeToString(sum[:]); got != gnuAGPLv3SHA256 {
		t.Fatalf("LICENSE sha256 %s, want unmodified GNU AGPL-3.0 text %s", got, gnuAGPLv3SHA256)
	}
	notice, err := os.ReadFile(filepath.Join(root, "NOTICE"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Copyright (C) 2026 xxww", "SPDX-License-Identifier: AGPL-3.0-only"} {
		if !strings.Contains(string(notice), want) {
			t.Fatalf("NOTICE does not contain %q", want)
		}
	}
	list, err := os.ReadFile(filepath.Join(root, "THIRD-PARTY-LICENSES.md"))
	if err != nil {
		t.Fatal(err)
	}
	row := "| github.com/xxww0098/podhub-go | (main) | AGPL-3.0-only | LICENSE | " + gnuAGPLv3SHA256 + " | - |"
	if !strings.Contains(string(list), row) {
		t.Fatalf("THIRD-PARTY-LICENSES.md has no main-module row %q", row)
	}
	for name, body := range map[string][]byte{"LICENSE": license, "NOTICE": notice, "THIRD-PARTY-LICENSES.md": list} {
		if strings.Contains(string(body), "UNDECIDED") {
			t.Fatalf("%s still contains the UNDECIDED placeholder", name)
		}
	}
}

func TestThirdPartyLicensesCurrent(t *testing.T) {
	root := repoRoot(t)
	body, err := os.ReadFile(filepath.Join(root, "THIRD-PARTY-LICENSES.md"))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(body)
	if hex.EncodeToString(sum[:]) != listStamp {
		t.Fatalf("THIRD-PARTY-LICENSES.md hash %x, stamp %s", sum, listStamp)
	}
	cmd := exec.Command("python3", filepath.Join(root, "scripts", "check-third-party-licenses.py"))
	cmd.Dir = root
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("third-party license list is stale:\n%s", out)
	}
}

func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("go.mod not found")
		}
		dir = parent
	}
}
