package contract

import (
	"fmt"
	"strings"
	"time"
)

type CouponSpec struct {
	Code            string    `json:"code"`
	DiscountPercent int       `json:"discount_percent"`
	StartsAt        time.Time `json:"starts_at"`
	ExpiresAt       time.Time `json:"expires_at"`
	MaxUses         int       `json:"max_uses"` // Zero means unlimited.
}

func ValidateCouponSpec(spec CouponSpec, now time.Time) (CouponSpec, error) {
	code, ok := CanonicalCouponCode(spec.Code)
	if !ok {
		return spec, fmt.Errorf("优惠码须为 3–32 位字母、数字、短横线或下划线")
	}
	spec.Code = code
	if spec.DiscountPercent < 1 || spec.DiscountPercent > 99 {
		return spec, fmt.Errorf("减免比例须为 1–99%% 的整数")
	}
	if spec.StartsAt.IsZero() {
		return spec, fmt.Errorf("请指定开始时间")
	}
	if !spec.ExpiresAt.After(spec.StartsAt) {
		return spec, fmt.Errorf("结束时间须晚于开始时间")
	}
	if !spec.ExpiresAt.After(now) {
		return spec, fmt.Errorf("结束时间须晚于当前时间")
	}
	if spec.MaxUses < 0 || spec.MaxUses > 1000000 {
		return spec, fmt.Errorf("可用次数须为 1–1000000 的整数，或设为不限次数")
	}
	return spec, nil
}

type Coupon struct {
	CouponSpec
	UsedCount int64     `json:"used_count"`
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"created_at"`
}

func CanonicalCouponCode(value string) (string, bool) {
	value = strings.ToUpper(strings.TrimSpace(value))
	if len(value) < 3 || len(value) > 32 {
		return "", false
	}
	for _, ch := range value {
		if !(ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '-' || ch == '_') {
			return "", false
		}
	}
	return value, true
}
