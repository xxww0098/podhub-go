package billingrepo

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
)

func couponInvalid() error {
	return &domain.QuoteError{Status: 400, Code: "COUPON_UNAVAILABLE", Message: "优惠码无效、未开始、已结束、已停用或次数已用完"}
}

func couponOffer(ctx context.Context, tx pgx.Tx, code string, now time.Time) (string, int, error) {
	if code == "" {
		return "", 0, nil
	}
	canonical, ok := contract.CanonicalCouponCode(code)
	if !ok {
		return "", 0, couponInvalid()
	}
	var percent int
	err := tx.QueryRow(ctx, `SELECT discount_percent FROM public.billing_coupon_offer($1,$2)`, canonical, now).Scan(&percent)
	if errors.Is(err, pgx.ErrNoRows) {
		err = couponInvalid()
	}
	return canonical, percent, err
}
