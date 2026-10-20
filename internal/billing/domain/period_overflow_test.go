package domain

import (
	"math"
	"math/big"
	"testing"
	"time"
)

func TestProrateRepresentableLargeAmounts(t *testing.T) {
	for _, month := range []time.Month{time.February, time.April, time.October} {
		from := sh(2028, month, 1, 0, 0, 0)
		for _, unit := range []int64{math.MaxInt64, math.MaxInt64 / 2, math.MaxInt64/31 + 1} {
			if got := Prorate(unit, from, NextMonthStart(from)); got != unit {
				t.Errorf("month=%v unit=%d got=%d", month, unit, got)
			}
		}
	}
}

func FuzzProrateRepresentablePartialMonth(f *testing.F) {
	f.Add(int64(math.MaxInt64), uint8(17), uint8(10))
	f.Add(int64(math.MaxInt64/2), uint8(31), uint8(2))
	f.Add(int64(50000), uint8(1), uint8(10))
	f.Fuzz(func(t *testing.T, unit int64, dayByte, monthByte uint8) {
		if unit < 0 {
			unit = -(unit + 1)
		}
		start := sh(2028, time.Month(monthByte%12+1), 1, 0, 0, 0)
		monthDays := int64(daysInMonth(start))
		days := int64(dayByte)%monthDays + 1
		from := start.AddDate(0, 0, int(monthDays-days))
		numerator := new(big.Int).Mul(big.NewInt(unit), big.NewInt(days))
		quotient, remainder := new(big.Int), new(big.Int)
		quotient.QuoRem(numerator, big.NewInt(monthDays), remainder)
		if remainder.Lsh(remainder, 1).Cmp(big.NewInt(monthDays)) >= 0 {
			quotient.Add(quotient, big.NewInt(1))
		}
		if got := Prorate(unit, from, NextMonthStart(start)); got != quotient.Int64() {
			t.Fatalf("unit=%d days=%d monthDays=%d got=%d want=%d", unit, days, monthDays, got, quotient.Int64())
		}
	})
}
