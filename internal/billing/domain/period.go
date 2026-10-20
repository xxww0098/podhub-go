package domain

import (
	"math/big"
	"time"
)

// Shanghai is the billing zone. China has observed UTC+8 without daylight
// saving since 1991, so a fixed offset is exact for every billing date and
// does not depend on tzdata being present in the image. Using a fixed zone is
// also deliberate: a tzdata update must not silently move a month boundary in
// the middle of a paid term.
var Shanghai = time.FixedZone("Asia/Shanghai", 8*60*60)

// MonthStart returns the first instant of t's Shanghai calendar month.
func MonthStart(t time.Time) time.Time {
	y, m, _ := t.In(Shanghai).Date()
	return time.Date(y, m, 1, 0, 0, 0, 0, Shanghai)
}

// NextMonthStart returns the first instant of the month after t's.
func NextMonthStart(t time.Time) time.Time {
	return MonthStart(t).AddDate(0, 1, 0)
}

// TermEnd returns start shifted by whole months. start must already be a
// month boundary; every caller builds it from MonthStart or NextMonthStart, so
// AddDate never lands on a short month's tail.
func TermEnd(start time.Time, months int) time.Time {
	return start.AddDate(0, months, 0)
}

// OnMonthStart reports whether t is exactly a Shanghai month boundary. Every
// term_end written to the database must satisfy it; the quote path checks it
// before returning and the schema enforces it with a trigger.
func OnMonthStart(t time.Time) bool {
	l := t.In(Shanghai)
	return l.Day() == 1 && l.Hour() == 0 && l.Minute() == 0 &&
		l.Second() == 0 && l.Nanosecond() == 0
}

// Prorate charges unit for the part of each calendar month that [from, to)
// covers, with unit meaning the price of a whole month:
//
//	unit × Σ (days covered in that month / days in that month)
//
// Days are counted on Shanghai dates, left-closed right-open, so a partial
// first day counts as a full one. The exact rational sum is rounded half-up
// once at the end; rounding each month separately would overcharge (25 stores
// on 10-31: 500/31 = 16.13 exact, 16.25 rounded per item).
func Prorate(unit int64, from, to time.Time) int64 {
	if unit <= 0 || !to.After(from) {
		return 0
	}
	acc := new(big.Rat)
	for seg := MonthStart(from); seg.Before(to); seg = NextMonthStart(seg) {
		start := seg
		if from.After(start) {
			start = from
		}
		end := NextMonthStart(seg)
		if to.Before(end) {
			end = to
		}
		days := dateDays(start, end)
		if days <= 0 {
			continue
		}
		acc.Add(acc, big.NewRat(days*unit, int64(daysInMonth(seg))))
	}
	return roundHalfUp(acc)
}

// dateDays counts whole Shanghai dates between two instants. 10-15 14:30 to
// 11-01 00:00 is 17 days.
func dateDays(from, to time.Time) int64 {
	return daysBetweenDates(from.In(Shanghai), to.In(Shanghai))
}

func daysBetweenDates(from, to time.Time) int64 {
	a := time.Date(from.Year(), from.Month(), from.Day(), 0, 0, 0, 0, time.UTC)
	b := time.Date(to.Year(), to.Month(), to.Day(), 0, 0, 0, 0, time.UTC)
	return int64(b.Sub(a) / (24 * time.Hour))
}

func daysInMonth(t time.Time) int {
	return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, 1, -1).Day()
}

// prorateSum is Prorate over several monthly units priced over the same
// stretch, with the sum rounded once. Change quotes use it so an upgrade and
// an add-on bought together round like a single line, not like two.
func prorateSum(units []int64, from, to time.Time) int64 {
	if !to.After(from) {
		return 0
	}
	var total int64
	for _, u := range units {
		if u > 0 {
			total += u
		}
	}
	return Prorate(total, from, to)
}

// roundHalfUp converts a non-negative rational to integer with half-up
// rounding: floor(r + 1/2).
func roundHalfUp(r *big.Rat) int64 {
	num := new(big.Int).Lsh(r.Num(), 1)
	num.Add(num, r.Denom())
	den := new(big.Int).Lsh(r.Denom(), 1)
	num.Quo(num, den)
	return num.Int64()
}
