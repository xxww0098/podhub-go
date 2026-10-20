package submit

import "testing"

func TestReleasedForResend(t *testing.T) {
	if releasedForResend("queued", []byte(`{"probeReleased":{"atMs":1,"passes":2}}`)) {
		t.Fatal("queued")
	}
	if !releasedForResend("superseded", []byte(`{"probeReleased":{"atMs":9,"passes":2}}`)) {
		t.Fatal("probe")
	}
	if releasedForResend("superseded", []byte(`{"probeReleased":{"atMs":9,"passes":1}}`)) {
		t.Fatal("one pass")
	}
	if !releasedForResend("superseded", []byte(`{"released":{"byUserId":3,"atMs":4}}`)) {
		t.Fatal("operator")
	}
	if releasedForResend("superseded", []byte(`{"released":{"byUserId":0,"atMs":4}}`)) {
		t.Fatal("zero user")
	}
}

func TestCanResumeRejectedUsesAllowedActions(t *testing.T) {
	code := "OZON_WRITES_DISABLED"
	issues := []byte(`[{"code":"OZON_WRITES_DISABLED","resolvedAtMs":null,"allowedActions":["resume"]}]`)
	if !canResumeRejected("rejected", &code, issues) {
		t.Fatal("resume")
	}
	if canResumeRejected("queued", &code, issues) {
		t.Fatal("queued")
	}
	if canResumeRejected("rejected", &code, []byte(`[{"code":"OZON_WRITES_DISABLED","allowedActions":["wait"]}]`)) {
		t.Fatal("no resume")
	}
}
