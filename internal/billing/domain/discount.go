package domain

import "math/big"

const AnnualDiscountPercent = 20

// Discounts round the payable amount in fen after each sequential discount.
func percentOff(amount int64, percent int) int64 {
	value := new(big.Int).Mul(big.NewInt(amount), big.NewInt(int64(100-percent)))
	return roundHalfUp(new(big.Rat).SetFrac(value, big.NewInt(100)))
}

func applyDiscounts(q Quotation, in QuoteInput) (Quotation, error) {
	if in.CouponPercent < 0 || in.CouponPercent > 99 || in.CouponPercent > 0 && in.CouponCode == "" {
		return Quotation{}, invalid("优惠码减免比例无效")
	}
	if q.Action != ActionSubscribe && q.Action != ActionRenew {
		if in.CouponPercent > 0 {
			return Quotation{}, invalid("优惠码仅用于购买或续费订阅")
		}
		return q, nil
	}
	if q.Months == 12 {
		before := q.AmountCents
		q.AmountCents = percentOff(before, AnnualDiscountPercent)
		q.Breakdown = append(q.Breakdown, Line{Label: "年付 8 折", Cents: q.AmountCents - before})
	}
	if in.CouponPercent > 0 {
		before := q.AmountCents
		q.AmountCents = percentOff(before, in.CouponPercent)
		if q.AmountCents < 1 {
			return Quotation{}, invalid("优惠后应付金额不得低于 1 分")
		}
		q.CouponCode, q.CouponPercent = in.CouponCode, in.CouponPercent
		q.CouponDiscountCents = before - q.AmountCents
		q.Breakdown = append(q.Breakdown, Line{Label: "优惠码 " + in.CouponCode, Cents: -q.CouponDiscountCents})
	}
	return q, nil
}
