package domain

import "testing"

func int64Ptr(value int64) *int64    { return &value }
func stringPtr(value string) *string { return &value }

// TestDecideSyncCheckOrder pins the order the kernel answers in. Each earlier
// answer makes every later one moot, so a reordering is a behaviour change
// even when every individual rule still fires.
func TestDecideSyncCheckOrder(t *testing.T) {
	const now = int64(1_760_000_000_000)
	due := now - 1

	t.Run("gone beats an open hold", func(t *testing.T) {
		got := DecideSync(SyncSnapshot{
			StoreGone: true, Hold: HoldCooldown, HoldUntilMS: int64Ptr(now + 60_000),
		}, PurposeReconcile, now)
		if got.Hold != HoldDisabled || got.Reason != ReasonStoreDisabled {
			t.Fatalf("%+v", got)
		}
	})

	t.Run("an open hold beats a void", func(t *testing.T) {
		got := DecideSync(SyncSnapshot{
			Hold: HoldBackoff, HoldUntilMS: int64Ptr(now + 60_000),
			HoldReason: stringPtr(ReasonSellerError),
			Pass:       PassDetail, GenerationStartMS: int64Ptr(now - GenerationMaxAgeMS - 1),
		}, PurposeReconcile, now)
		if got.Hold != HoldBackoff || got.Void {
			t.Fatalf("%+v", got)
		}
	})

	t.Run("an expired hold is history", func(t *testing.T) {
		got := DecideSync(SyncSnapshot{
			Hold: HoldBackoff, HoldUntilMS: int64Ptr(now - 1), HoldReason: stringPtr(ReasonSellerError),
			NextDueMS: int64Ptr(due),
		}, PurposeReconcile, now)
		if !got.Call || got.Unit != UnitListLive {
			t.Fatalf("%+v", got)
		}
	})

	t.Run("stale progress is void, not resumed", func(t *testing.T) {
		got := DecideSync(SyncSnapshot{
			Pass: PassDetail, GenerationStartMS: int64Ptr(now - GenerationMaxAgeMS - 1),
			NextDueMS: int64Ptr(due),
		}, PurposeReconcile, now)
		if !got.Void {
			t.Fatalf("%+v", got)
		}
		if got.NextDueMS <= now {
			t.Fatalf("void must wake in the future, got %d", got.NextDueMS)
		}
	})

	t.Run("breakers beat the ledger", func(t *testing.T) {
		got := DecideSync(SyncSnapshot{
			NextDueMS: int64Ptr(due), Breakers: Breakers{DeploymentOpen: true},
		}, PurposeReconcile, now)
		if got.Hold != HoldCooldown || got.Reason != ReasonDeploymentBreaker {
			t.Fatalf("%+v", got)
		}
	})

	t.Run("egress blocked names itself", func(t *testing.T) {
		got := DecideSync(SyncSnapshot{
			NextDueMS: int64Ptr(due),
			Breakers:  Breakers{DeploymentOpen: true, EgressBlocked: true},
		}, PurposeReconcile, now)
		if got.Reason != ReasonEgressBlocked {
			t.Fatalf("%+v", got)
		}
	})
}

func TestDecideSyncLedgerAndSchedule(t *testing.T) {
	const now = int64(1_760_000_000_000)

	t.Run("not due is a quiet skip", func(t *testing.T) {
		got := DecideSync(SyncSnapshot{NextDueMS: int64Ptr(now + 60_000)}, PurposeReconcile, now)
		if !got.Skip {
			t.Fatalf("%+v", got)
		}
	})

	t.Run("a spent ledger parks until Moscow midnight", func(t *testing.T) {
		got := DecideSync(SyncSnapshot{
			NextDueMS: int64Ptr(now), CallsDay: stringPtr(MoscowDayKey(now)),
			CallsReconcile: ReconcileCap(0, 0),
		}, PurposeReconcile, now)
		if got.Hold != HoldBudget || got.Reason != ReasonBudgetExhausted {
			t.Fatalf("%+v", got)
		}
		if got.HoldUntil == nil || *got.HoldUntil <= now {
			t.Fatalf("budget hold must lift in the future: %+v", got)
		}
	})

	t.Run("a new Moscow day rolls the ledger over", func(t *testing.T) {
		got := DecideSync(SyncSnapshot{
			NextDueMS: int64Ptr(now), CallsDay: stringPtr(MoscowDayKey(now - 48*60*60*1000)),
			CallsReconcile: 1000,
		}, PurposeReconcile, now)
		if !got.Call {
			t.Fatalf("%+v", got)
		}
	})

	t.Run("a manual press ignores the schedule and the cap", func(t *testing.T) {
		got := DecideSync(SyncSnapshot{
			NextDueMS: int64Ptr(now + 60_000), CallsDay: stringPtr(MoscowDayKey(now)),
			CallsManual: 1000,
		}, PurposeManual, now)
		if !got.Call {
			t.Fatalf("%+v", got)
		}
	})

	t.Run("a busy store yields its budget", func(t *testing.T) {
		got := DecideSync(SyncSnapshot{NextDueMS: int64Ptr(now), StoreBusy: true}, PurposeReconcile, now)
		if got.Hold != HoldYield || got.Reason != ReasonStoreBusy {
			t.Fatalf("%+v", got)
		}
	})
}

func TestDecideSyncUnitsFollowThePass(t *testing.T) {
	const now = int64(1_760_000_000_000)
	cases := []struct {
		pass string
		want SyncUnit
	}{
		{PassNone, UnitListLive},
		{PassListLive, UnitListLive},
		{PassListArchived, UnitListArchived},
		{PassDetail, UnitDetail},
		{PassCommit, UnitFinalize},
	}
	for _, tc := range cases {
		dueAt := now
		got := DecideSync(SyncSnapshot{
			Pass: tc.pass, NextDueMS: &dueAt,
			GenerationStartMS: int64Ptr(now),
		}, PurposeReconcile, now)
		if !got.Call || got.Unit != tc.want {
			t.Fatalf("%s: %+v", tc.pass, got)
		}
	}
}

func TestReconcileCap(t *testing.T) {
	// An unknown cabinet still gets the probe allowance: a zero floor would
	// budget-hold a fresh store before its first probe.
	if got := ReconcileCap(0, 0); got != 9 {
		t.Fatalf("empty cabinet = %d, want 9", got)
	}
	// 1000 live: (2 + 0 + 1) * 6 * 3 / 2 = 27.
	if got := ReconcileCap(1000, 0); got != 27 {
		t.Fatalf("1000 live = %d, want 27", got)
	}
	// 1000 live + 1000 archived: (2 + 1 + 1) * 6 * 3 / 2 = 36.
	if got := ReconcileCap(1000, 1000); got != 36 {
		t.Fatalf("1000/1000 = %d, want 36", got)
	}
}

func TestNextReconcileSlotIsStrictlyFutureAndStable(t *testing.T) {
	const now = int64(1_760_000_000_000)
	const uuid = "00000000-0000-4000-8000-000000000001"
	first := NextReconcileSlot(now, uuid)
	if first <= now {
		t.Fatalf("slot %d is not after %d", first, now)
	}
	if first-now > ReconcileIntervalMS {
		t.Fatalf("slot %d is more than one interval away", first-now)
	}
	// The phase repeats every interval, and asking again after the slot moves
	// to the next one: one store, one slot.
	second := NextReconcileSlot(first, uuid)
	if second-first != ReconcileIntervalMS {
		t.Fatalf("cycle = %d, want %d", second-first, ReconcileIntervalMS)
	}
}

func TestMoscowDayAndMidnight(t *testing.T) {
	// 2026-09-30T22:00:00Z is 2026-10-01 01:00 in Moscow.
	const at = int64(1_790_805_600_000)
	if got := MoscowDayKey(at); got != "2026-10-01" {
		t.Fatalf("day key = %q", got)
	}
	midnight := NextMoscowMidnight(at)
	if midnight <= at {
		t.Fatalf("midnight %d is not after %d", midnight, at)
	}
	if got := MoscowDayKey(midnight - 1); got != "2026-10-01" {
		t.Fatalf("one ms before midnight = %q", got)
	}
	if got := MoscowDayKey(midnight); got != "2026-10-02" {
		t.Fatalf("midnight itself = %q", got)
	}
}

func TestOnSyncFailureClassification(t *testing.T) {
	const now = int64(1_760_000_000_000)

	t.Run("401 with a JSON body is a dead key, not a streak", func(t *testing.T) {
		got := OnSyncFailure(SyncSnapshot{ConsecutiveFailure: 2}, RefusalShape{
			Status: 401, JSONBody: true, Message: "Unauthorized",
		}, now)
		if got.Hold != HoldCredential || got.Reason != ReasonCredentialRevoked {
			t.Fatalf("%+v", got)
		}
		if got.Failure || got.Incident {
			t.Fatalf("a credential verdict must not count: %+v", got)
		}
		if got.UntilMS != now+FailureCooldownMS {
			t.Fatalf("recheck = %d", got.UntilMS-now)
		}
	})

	t.Run("the IP restriction sentence is its own code", func(t *testing.T) {
		got := OnSyncFailure(SyncSnapshot{}, RefusalShape{
			Status: 403, JSONBody: true, Message: "Key is restricted to specific IP: 1.2.3.4",
		}, now)
		if got.Reason != ReasonIPRestricted {
			t.Fatalf("%+v", got)
		}
	})

	t.Run("a 403 HTML page blames the egress", func(t *testing.T) {
		got := OnSyncFailure(SyncSnapshot{}, RefusalShape{Status: 403}, now)
		if !got.EgressShape || got.Reason != ReasonEgressBlocked {
			t.Fatalf("%+v", got)
		}
	})

	t.Run("pressure feeds the ledger and the streak", func(t *testing.T) {
		got := OnSyncFailure(SyncSnapshot{ConsecutiveFailure: 2}, RefusalShape{
			Status: 429, JSONBody: true, RetryAfterMS: int64Ptr(5_000),
		}, now)
		if got.Hold != HoldCooldown || got.Reason != ReasonRateLimited {
			t.Fatalf("%+v", got)
		}
		if !got.Incident || !got.Failure || got.Pressure != 429 {
			t.Fatalf("%+v", got)
		}
		if got.UntilMS != now+FailureCooldownMS {
			t.Fatalf("third failure must cool down for a day: %d", got.UntilMS-now)
		}
	})

	t.Run("pressure below the limit honors Retry-After", func(t *testing.T) {
		got := OnSyncFailure(SyncSnapshot{}, RefusalShape{
			Status: 429, JSONBody: true, RetryAfterMS: int64Ptr(5_000),
		}, now)
		if got.Hold != HoldBackoff || got.UntilMS != now+5_000 {
			t.Fatalf("%+v", got)
		}
	})

	t.Run("Retry-After is capped", func(t *testing.T) {
		got := OnSyncFailure(SyncSnapshot{}, RefusalShape{
			Status: 429, JSONBody: true, RetryAfterMS: int64Ptr(MaxRetryAfterMS * 4),
		}, now)
		if got.UntilMS != now+MaxRetryAfterMS {
			t.Fatalf("%+v", got)
		}
	})

	t.Run("a transport fault is an egress shape at the backoff pace", func(t *testing.T) {
		got := OnSyncFailure(SyncSnapshot{}, RefusalShape{}, now)
		if !got.EgressShape || got.UntilMS != now+BackoffMS(1) {
			t.Fatalf("%+v", got)
		}
	})
}

func TestBackoffDoublesAndCaps(t *testing.T) {
	cases := map[int]int64{
		0: 60_000, 1: 60_000, 2: 120_000, 3: 240_000,
		// The sixth failure would double to 1,920,000 and is capped at 30 min.
		4: 480_000, 5: 960_000, 6: 1_800_000, 99: 1_800_000,
	}
	for failures, want := range cases {
		if got := BackoffMS(failures); got != want {
			t.Fatalf("BackoffMS(%d) = %d, want %d", failures, got, want)
		}
	}
}

func TestListPageDone(t *testing.T) {
	page := func(lastID string, items int) SyncListPage {
		out := SyncListPage{LastID: lastID, Items: make([]SyncListItem, items)}
		return out
	}
	cases := []struct {
		name   string
		page   SyncListPage
		prior  string
		count  int64
		expect bool
	}{
		{"a short page ends the pass", page("c-2", 3), "c-1", 3, true},
		{"a full page continues", page("c-2", 3), "c-1", ListPageLimit, false},
		{"an empty page ends the pass", page("", 0), "c-1", 0, true},
		{"an empty cursor ends the pass", page("  ", 3), "c-1", ListPageLimit, true},
		{"an unchanged cursor ends the pass", page("c-1", 3), "c-1", ListPageLimit, true},
	}
	for _, tc := range cases {
		if got := ListPageDone(tc.page, tc.prior, tc.count); got != tc.expect {
			t.Fatalf("%s: got %v", tc.name, got)
		}
	}
}

func TestProjectFunnelValidatesThePage(t *testing.T) {
	const now = int64(1_760_000_000_000)
	funnel, code := ProjectFunnel([]byte(`{"result":{"data":[
		{"dimensions":[{"id":"7"}],"metrics":[120,45,9,7.5,3,5400]}
	]}}`), 0, now)
	if code != "" {
		t.Fatalf("code = %q", code)
	}
	if len(funnel.Rows) != 1 || funnel.Rows[0].SKU != 7 || funnel.Rows[0].Revenue != 5400 {
		t.Fatalf("%+v", funnel)
	}
	if funnel.NextOffset != 0 {
		t.Fatalf("a short page wraps the cursor: %d", funnel.NextOffset)
	}
	if funnel.ThroughDay != "2025-10-09" {
		t.Fatalf("through day = %q", funnel.ThroughDay)
	}

	refused := []string{
		`{"result":{"data":[{"dimensions":[{"id":"7"}],"metrics":[1,1,1,1,1,1]},{"dimensions":[{"id":"7"}],"metrics":[1,1,1,1,1,1]}]}}`,
		`{"result":{"data":[{"dimensions":[{"id":"7"}],"metrics":[1,1,1,1,-1,1]}]}}`,
		`{"result":{"data":[{"dimensions":[{"id":"7"}],"metrics":[1,1]}]}}`,
		`{"result":{"data":[{"dimensions":[{"id":"abc"}],"metrics":[1,1,1,1,1,1]}]}}`,
		`{"result":{}}`,
		`not json`,
	}
	for _, body := range refused {
		if _, code := ProjectFunnel([]byte(body), 0, now); code != "invalid" {
			t.Fatalf("%s: code = %q", body, code)
		}
	}
}

func TestMetricsRefusalCode(t *testing.T) {
	// The analytics endpoint may be Premium-restricted: a 403 is "restricted",
	// never a dead credential.
	cases := map[int]string{
		401: "restricted", 403: "restricted", 429: "rate_limited",
		400: "refused", 404: "refused", 500: "unavailable", 503: "unavailable",
	}
	for status, want := range cases {
		if got := MetricsRefusalCode(status); got != want {
			t.Fatalf("%d = %q, want %q", status, got, want)
		}
	}
}

func TestSlotCoveredByManual(t *testing.T) {
	const now = int64(1_760_000_000_000)
	pressed := now - 60_000

	t.Run("the press itself is never skipped", func(t *testing.T) {
		due := pressed
		if SlotCoveredByManual(PassNone, due, &pressed, int64Ptr(pressed-1), now) {
			t.Fatal("a press must enqueue")
		}
	})

	t.Run("a committed generation covers a different slot", func(t *testing.T) {
		if !SlotCoveredByManual(PassNone, now, &pressed, int64Ptr(pressed+1), now) {
			t.Fatal("the slot should be covered")
		}
	})

	t.Run("an open pass is not covered", func(t *testing.T) {
		if SlotCoveredByManual(PassDetail, now, &pressed, int64Ptr(pressed+1), now) {
			t.Fatal("a walking generation is not covered")
		}
	})

	t.Run("the window closes", func(t *testing.T) {
		old := now - ManualAutoSkipMS
		if SlotCoveredByManual(PassNone, now, &old, int64Ptr(old+1), now) {
			t.Fatal("an old press must not cover a slot")
		}
	})
}

func TestIsJSONErrorBody(t *testing.T) {
	if !IsJSONErrorBody([]byte(`{"code":16,"message":"Unauthorized"}`)) {
		t.Fatal("a JSON error envelope must match")
	}
	for _, body := range []string{`<html>403</html>`, `{}`, `[]`, `not json`} {
		if IsJSONErrorBody([]byte(body)) {
			t.Fatalf("%s must not read as an Ozon refusal", body)
		}
	}
}
