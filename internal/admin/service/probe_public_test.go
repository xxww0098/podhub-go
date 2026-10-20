package service

import (
	"context"
	"errors"
	"testing"
)

type refuseCatalogue struct{}

func (refuseCatalogue) Fetch(context.Context, string, string, string) (int, []byte, bool, error) {
	return 0, nil, true, errors.New("dns refused")
}

func TestPublicProbeRefusalKeepsValidationMessage(t *testing.T) {
	api := &API{Fetch: refuseCatalogue{}}
	_, fault := api.fetchModels(context.Background(), probeTarget{
		Base: "https://example.com", Format: "chat_completions", Key: "k",
	})
	if fault == nil || fault.Status != 400 || fault.Code != "VALIDATION" || fault.Message != "接口地址不是允许的公网 https 端点" {
		t.Fatalf("%+v", fault)
	}
}
