package domain

import "time"

// PeakSeats is the highest concurrent seat count across the intervals.
// The new lot is included. This is the reduction of max_seats_in_window's rows.
func PeakSeats(starts, ends []time.Time, seats []int64) int64 {
	type event struct {
		at    time.Time
		delta int64
	}
	ev := make([]event, 0, len(seats)*2)
	for i := range seats {
		ev = append(ev, event{starts[i], seats[i]}, event{ends[i], -seats[i]})
	}
	for i := 0; i < len(ev); i++ {
		for j := i + 1; j < len(ev); j++ {
			if ev[j].at.Before(ev[i].at) || (ev[j].at.Equal(ev[i].at) && ev[j].delta < ev[i].delta) {
				ev[i], ev[j] = ev[j], ev[i]
			}
		}
	}
	var cur, peak int64
	for _, item := range ev {
		cur += item.delta
		if cur > peak {
			peak = cur
		}
	}
	return peak
}
