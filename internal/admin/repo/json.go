package adminrepo

import corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"

func jsonText(v any) string { return corerepo.JSONText(v) }
