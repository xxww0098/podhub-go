package service

import (
	"context"
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
)

type catalogUploadGrant struct{ active bool }

func (g *catalogUploadGrant) CanMaintain(_ context.Context, userID int64, sourceID string) (bool, error) {
	return g.active && userID == 7 && sourceID == "source", nil
}

func TestCatalogUploadsRequireTheLiveSourceGrant(t *testing.T) {
	service, _ := multipartService(func(context.Context, ObjectRequest) (ObjectResponse, error) {
		t.Fatal("a refused upload reached storage")
		return ObjectResponse{}, nil
	})
	grant := &catalogUploadGrant{active: true}
	service.CatalogAccess = grant
	actor := contract.Actor{UserID: 7, Role: "user"}
	body := []byte(`{"kind":"gallery","filename":"cup.png","content_type":"image/png","bytes":10,"sha256":"` + strings.Repeat("a", 64) + `"}`)
	issued, err := service.IssueCatalogUpload(context.Background(), actor, "source", body, "sha256")
	if err != nil || issued.UploadTicket == "" {
		t.Fatalf("authorized upload: %v", err)
	}
	if _, err := service.IssueCatalogUpload(context.Background(), actor, "other", body, "sha256"); err == nil {
		t.Fatal("issued upload for another source")
	}
	grant.active = false
	confirmation := []byte(`{"upload_ticket":"` + issued.UploadTicket + `"}`)
	for name, run := range map[string]func() error{
		"issue": func() error {
			_, err := service.IssueCatalogUpload(context.Background(), actor, "source", body, "sha256")
			return err
		},
		"confirm": func() error {
			_, err := service.ConfirmCatalogUpload(context.Background(), actor, "source", confirmation)
			return err
		},
		"abort": func() error { return service.AbortCatalogUpload(context.Background(), actor, "source", confirmation) },
	} {
		if failure, ok := contract.AsFail(run()); !ok || failure.Kind != contract.KindForbidden {
			t.Fatalf("%s did not reject revoked grant: %+v", name, failure)
		}
	}
}
