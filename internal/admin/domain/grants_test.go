package domain

import "testing"

func TestValidateGrantBounds(t *testing.T) {
	ttl := int64(0)
	if _, msg := ValidateGrant(0, 1, "because", nil, 1); msg != "org_id 无效" {
		t.Fatal(msg)
	}
	if _, msg := ValidateGrant(1, -1, "because", nil, 1); msg != "平台人员无效" {
		t.Fatal(msg)
	}
	if _, msg := ValidateGrant(1, 2, "  ", nil, 1); msg != "签发原因不能为空" {
		t.Fatal(msg)
	}
	if _, msg := ValidateGrant(1, 2, "ok", &ttl, 1); msg != "ttl_minutes 需在 1-1440 之间" {
		t.Fatal(msg)
	}
	got, msg := ValidateGrant(4, 0, " 值班 ", nil, 9)
	if msg != "" || got.StaffUserID != 9 || got.TTLMinutes != 60 || got.Reason != "值班" {
		t.Fatalf("%+v %s", got, msg)
	}
}
