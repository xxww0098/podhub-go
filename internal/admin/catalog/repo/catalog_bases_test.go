package catalogrepo

import (
	"context"
	"testing"
)

func TestBasesUsesInjectedConfigurationWithoutDatabase(t *testing.T) {
	ctx := context.Background()
	empty, err := (CatalogRepo{}).Bases(ctx)
	if err != nil || len(empty) != 0 {
		t.Fatalf("unconfigured bases=%v err=%v", empty, err)
	}
	repo := CatalogRepo{PublicBases: []string{"https://podhub-supplier.ozon-pod.com"}}
	bases, err := repo.Bases(ctx)
	if err != nil || len(bases) != 1 || bases[0] != repo.PublicBases[0] {
		t.Fatalf("configured bases=%v err=%v", bases, err)
	}
	bases[0] = "https://untrusted.example"
	if repo.PublicBases[0] != "https://podhub-supplier.ozon-pod.com" {
		t.Fatal("caller mutated server configuration")
	}
}
