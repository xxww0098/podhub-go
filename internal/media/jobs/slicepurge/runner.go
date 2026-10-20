package slicepurge

import (
	"context"
	"slices"
	"time"
)

const (
	maxAttempts    = 3
	requestTimeout = 30 * time.Second
	maxKeys        = 1000
)

// DeleteResult is one DeleteObjects receipt.
type DeleteResult struct {
	Deleted     int
	FailedKeys  []string
	FailedCodes []string
	Retryable   bool
}

// CallError is an origin failure. Code is the stable slice_* / s3_* name.
type CallError struct {
	Code      string
	Retryable bool
}

func (e *CallError) Error() string { return e.Code }

// Origin lists and deletes one bucket. The runner owns retries.
type Origin interface {
	List(ctx context.Context) ([]string, error)
	Delete(ctx context.Context, keys []string) (DeleteResult, error)
}

// Reservation is one prepaid API call.
type Reservation struct {
	CallNo    int32
	Remaining time.Duration
}

// Store is the durable budget. false means the claim or window ended.
type Store interface {
	Reserve(ctx context.Context) (Reservation, bool, error)
	Record(ctx context.Context, reservation Reservation, deleted, failed uint32) (bool, error)
	Finish(ctx context.Context) (bool, error)
	RetryLater(ctx context.Context, code string) (bool, error)
}

// Report matches the tracing fields Rust logs when a bucket finishes.
type Report struct {
	Completed     bool   `json:"completed"`
	APICalls      uint32 `json:"api_calls"`
	DeletedAck    uint64 `json:"deleted_ack"`
	FailedItems   uint64 `json:"failed_items"`
	StopCode      string `json:"stop_code"`
	StateRecorded bool   `json:"state_recorded"`
}

// Run clears one bucket. sleep is the retry delay; tests pass a no-op.
func Run(ctx context.Context, state Store, origin Origin, sleep func(time.Duration)) Report {
	if sleep == nil {
		sleep = time.Sleep
	}
	report := Report{}
	if err := clear(ctx, state, origin, &report, sleep); err != nil {
		report.StopCode = err.Error()
		recorded, recErr := state.RetryLater(ctx, report.StopCode)
		report.StateRecorded = recErr == nil && recorded
		return report
	}
	report.Completed = true
	report.StateRecorded = true
	report.StopCode = "empty_observed"
	return report
}

func clear(ctx context.Context, state Store, origin Origin, report *Report, sleep func(time.Duration)) error {
	for {
		if err := ctx.Err(); err != nil {
			return &CallError{Code: "slice_stopped", Retryable: false}
		}
		keys, err := list(ctx, state, origin, report, sleep)
		if err != nil {
			return err
		}
		if len(keys) == 0 {
			ok, err := state.Finish(ctx)
			if err != nil {
				return err
			}
			if !ok {
				return &CallError{Code: "slice_claim_lost", Retryable: false}
			}
			return nil
		}
		if len(keys) > maxKeys || !uniqueNonEmpty(keys) {
			return &CallError{Code: "slice_list_invalid", Retryable: false}
		}
		if err := deleteKeys(ctx, state, origin, keys, report, sleep); err != nil {
			return err
		}
	}
}

func list(ctx context.Context, state Store, origin Origin, report *Report, sleep func(time.Duration)) ([]string, error) {
	var last error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		reservation, err := reserve(ctx, state, report)
		if err != nil {
			return nil, err
		}
		callCtx, cancel := context.WithTimeout(ctx, minDuration(requestTimeout, reservation.Remaining))
		keys, callErr := origin.List(callCtx)
		cancel()
		if callErr == nil {
			if err := record(ctx, state, reservation, 0, 0, report); err != nil {
				return nil, err
			}
			return keys, nil
		}
		last = callErr
		coded, retryable := classify(callErr)
		if !retryable || attempt+1 == maxAttempts {
			if coded == "" {
				coded = "slice_request_timeout"
			}
			return nil, &CallError{Code: coded, Retryable: false}
		}
		sleep(time.Duration(100*(1<<attempt)) * time.Millisecond)
	}
	return nil, last
}

func deleteKeys(ctx context.Context, state Store, origin Origin, keys []string, report *Report, sleep func(time.Duration)) error {
	for attempt := 0; attempt < maxAttempts; attempt++ {
		reservation, err := reserve(ctx, state, report)
		if err != nil {
			return err
		}
		callCtx, cancel := context.WithTimeout(ctx, minDuration(requestTimeout, reservation.Remaining))
		result, callErr := origin.Delete(callCtx, keys)
		cancel()
		if callErr == nil {
			if !receiptValid(keys, result) {
				return &CallError{Code: "slice_delete_receipt_invalid", Retryable: false}
			}
			if err := record(ctx, state, reservation, uint32(result.Deleted), uint32(len(result.FailedKeys)), report); err != nil {
				return err
			}
			if len(result.FailedKeys) == 0 {
				return nil
			}
			code := "slice_partial_delete"
			if len(result.FailedCodes) > 0 && result.FailedCodes[0] != "" {
				code = result.FailedCodes[0]
			}
			if !result.Retryable || attempt+1 == maxAttempts {
				return &CallError{Code: code, Retryable: false}
			}
			keys = append([]string(nil), result.FailedKeys...)
		} else {
			coded, retryable := classify(callErr)
			if !retryable || attempt+1 == maxAttempts {
				if coded == "" {
					coded = "slice_request_timeout"
				}
				return &CallError{Code: coded, Retryable: false}
			}
		}
		sleep(time.Duration(100*(1<<attempt)) * time.Millisecond)
	}
	return &CallError{Code: "slice_request_timeout", Retryable: false}
}

func reserve(ctx context.Context, state Store, report *Report) (Reservation, error) {
	started := time.Now()
	reservation, ok, err := state.Reserve(ctx)
	if err != nil {
		return Reservation{}, err
	}
	if !ok {
		return Reservation{}, &CallError{Code: "slice_window_budget_or_claim_ended", Retryable: false}
	}
	report.APICalls++
	reservation.Remaining -= time.Since(started)
	if reservation.Remaining <= 0 {
		return Reservation{}, &CallError{Code: "slice_window_ended", Retryable: false}
	}
	return reservation, nil
}

func record(ctx context.Context, state Store, reservation Reservation, deleted, failed uint32, report *Report) error {
	ok, err := state.Record(ctx, reservation, deleted, failed)
	if err != nil {
		return err
	}
	if !ok {
		return &CallError{Code: "slice_claim_lost", Retryable: false}
	}
	report.DeletedAck += uint64(deleted)
	report.FailedItems += uint64(failed)
	return nil
}

func receiptValid(keys []string, result DeleteResult) bool {
	failed := append([]string(nil), result.FailedKeys...)
	slices.Sort(failed)
	failed = slices.Compact(failed)
	if result.Deleted+len(failed) != len(keys) || len(failed) != len(result.FailedKeys) || len(result.FailedCodes) != len(failed) {
		return false
	}
	for _, key := range result.FailedKeys {
		if !slices.Contains(keys, key) {
			return false
		}
	}
	return true
}

func uniqueNonEmpty(keys []string) bool {
	seen := map[string]struct{}{}
	for _, key := range keys {
		if key == "" {
			return false
		}
		if _, ok := seen[key]; ok {
			return false
		}
		seen[key] = struct{}{}
	}
	return true
}

func classify(err error) (string, bool) {
	if err == nil {
		return "", false
	}
	if coded, ok := err.(*CallError); ok {
		return coded.Code, coded.Retryable
	}
	if err == context.DeadlineExceeded || err == context.Canceled {
		return "slice_request_timeout", true
	}
	return "s3_network", true
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
