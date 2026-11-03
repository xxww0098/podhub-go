package aihttp

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestDepsLimitsFailClosedWhenTheLoaderFails(t *testing.T) {
	limits, resp := Deps{}.limits(context.Background())
	if resp.Status != 0 || limits != (Limits{}) {
		t.Fatalf("no loader means every ceiling off: %+v %+v", limits, resp)
	}
	want := Limits{Global: 3, User: 2, LeaseTTL: time.Minute}
	limits, resp = Deps{Limits: func(context.Context) (Limits, error) { return want, nil }}.limits(context.Background())
	if resp.Status != 0 || limits != want {
		t.Fatalf("loaded limits: %+v %+v", limits, resp)
	}
	_, resp = Deps{Limits: func(context.Context) (Limits, error) { return Limits{}, errors.New("sealed row unreadable") }}.limits(context.Background())
	body, _ := resp.JSON.(map[string]string)
	if resp.Status != 503 || body["code"] != "RELAY_UNAVAILABLE" || body["error"] != "AI 服务配置暂不可用" {
		t.Fatalf("an unreadable configuration must answer 503 RELAY_UNAVAILABLE: %+v", resp)
	}
}
