package domain

import (
	"strings"
	"testing"
)

func TestEmailAndPasswordEdges(t *testing.T) {
	if EmailShaped("a@b") || EmailShaped("a@b.") || EmailShaped(" @b.co") || EmailShaped("a@@b.co") || EmailShaped("ab.co") {
		t.Fatal("shape")
	}
	if !EmailShaped("a@b.co") || !CreateCredential("A@B.co", "12345678") {
		t.Fatal("ok")
	}
	if CreateCredential("a@b.co", "1234567") || CreateCredential("a@b.co", string(make([]byte, 73))) {
		t.Fatal("create length")
	}
	if PasswordReset("  short ") != "密码至少 8 位" {
		t.Fatal("short")
	}
	long := "  " + strings.Repeat("a", 73)
	if PasswordReset(long) != "密码过长（最多 72 字节）" {
		t.Fatal("long")
	}
	if PasswordReset("  12345678  ") != "" {
		t.Fatal("trim ok")
	}
}

func TestTierAndStatus(t *testing.T) {
	if TierKey(" free ") != "lite" || TierKey("PRO") != "pro" || PlanInEffect(" max ", "lite") != "max" {
		t.Fatal("tier")
	}
	if PlanInEffect("  ", "free") != "lite" {
		t.Fatal("account plan")
	}
	if AccountStatus(true) != "disabled" || MembershipStatus(false, true) != "suspended" || MembershipStatus(false, false) != "active" {
		t.Fatal("status")
	}
	if !Staff(" Admin ") || Staff("nope") || RankLabel("super_admin") != "超级管理员" {
		t.Fatal("staff")
	}
}
