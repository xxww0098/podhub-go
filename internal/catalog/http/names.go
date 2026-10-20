package cataloghttp

import (
	"time"

	"github.com/xxww0098/podhub-go/internal/catalog/domain"
)

// Same-package names for symbols that live in domain, so handler.go keeps
// the body it had in package catalog.
type (
	TreeNode = domain.TreeNode
	TreeData = domain.TreeData
)

func LanguageKey(raw string) (string, bool) { return domain.LanguageKey(raw) }

func Fresh(now time.Time, fetchedAtMs int64) bool { return domain.Fresh(now, fetchedAtMs) }

func DecodeTree(payload []byte) ([]TreeNode, error) { return domain.DecodeTree(payload) }
