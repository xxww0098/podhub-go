package contract

import (
	"errors"
	"fmt"
	"testing"

	"github.com/xxww0098/podhub-go/internal/admin/core/contract/outcome"
)

func TestOutcomeAliasesMatchLegacyShape(t *testing.T) {
	kinds := []string{KindValidation, KindNotFound, KindConflict, KindForbidden, KindWritesDisabled, KindInternal, KindUnavailable}
	want := []string{"validation", "not_found", "conflict", "forbidden", "writes_disabled", "internal", "unavailable"}
	for i, kind := range kinds {
		if kind != want[i] {
			t.Fatalf("kind %d %q", i, kind)
		}
	}
	samples := []*Fail{
		{Kind: KindValidation, Message: "请求格式无效"},
		{Kind: KindInternal, Status: 503, RetryAfter: 1, Message: "资源正在更新，请稍后重试"},
		{Kind: KindInternal, Status: 409, Message: "媒体对象已进入回收，请重新上传"},
		{Kind: KindValidation, Message: "商品尚未满足上架条件", Missing: []string{"prompt"}},
		nil,
	}
	for _, sample := range samples {
		if sample.Error() != legacyError(sample) {
			t.Fatalf("error %q", sample.Error())
		}
		got, ok := AsFail(sample)
		wantFail, wantOK := outcome.AsFail(sample)
		if ok != wantOK || got != wantFail {
			t.Fatalf("AsFail %+v %v", got, ok)
		}
		if sample != nil {
			wrapped, ok := AsFail(fmt.Errorf("wrap: %w", sample))
			if !ok || wrapped.Message != sample.Message || wrapped.Kind != sample.Kind {
				t.Fatalf("wrapped %+v", wrapped)
			}
		}
	}
	if _, ok := AsFail(errors.New("boom")); ok {
		t.Fatal("plain error")
	}
	actor := Actor{UserID: 7, OrgID: 1, Role: "admin"}
	if actor != (outcome.Actor{UserID: 7, OrgID: 1, Role: "admin"}) {
		t.Fatalf("%+v", actor)
	}
}

func legacyError(f *Fail) string {
	if f == nil {
		return ""
	}
	return f.Message
}
