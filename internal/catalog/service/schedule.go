package service

import (
	"crypto/rand"
	"errors"
	"math/big"
	"time"
)

// NextFixed is the next clock time at atMinute in the offset zone, strictly
// after now. atMinute is minutes after local midnight, 0..1439. offsetMin is
// the zone's minutes east of UTC. This is the fixed schedule only. Random
// mode is handled by NextRandom.
func NextFixed(atMinute, offsetMin int, now time.Time) time.Time {
	if atMinute < 0 {
		atMinute = 0
	}
	if atMinute > 1439 {
		atMinute = 1439
	}
	loc := time.FixedZone("catalog", offsetMin*60)
	local := now.In(loc)
	candidate := time.Date(local.Year(), local.Month(), local.Day(), atMinute/60, atMinute%60, 0, 0, loc)
	if !candidate.After(now) {
		candidate = candidate.Add(24 * time.Hour)
	}
	return candidate
}

// NextRandom pins one future minute in the configured local window.
func NextRandom(start, end, offsetMin int, now time.Time, tomorrow bool) (time.Time, error) {
	if start < 0 || end > 1440 || end <= start || offsetMin < -720 || offsetMin > 840 {
		return time.Time{}, errors.New("invalid catalog schedule window")
	}
	loc := time.FixedZone("catalog", offsetMin*60)
	local := now.In(loc)
	day := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
	low := start
	if tomorrow {
		day = day.AddDate(0, 0, 1)
	} else {
		minute := local.Hour()*60 + local.Minute() + 1
		if minute > low {
			low = minute
		}
		if low >= end {
			day = day.AddDate(0, 0, 1)
			low = start
		}
	}
	n, err := rand.Int(rand.Reader, big.NewInt(int64(end-low)))
	if err != nil {
		return time.Time{}, err
	}
	return day.Add(time.Duration(low+int(n.Int64())) * time.Minute), nil
}
