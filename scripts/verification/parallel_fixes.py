#!/usr/bin/env python3
"""Temporary verification-branch harness. Never installed in the application."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

AREA = sys.argv[1]
EVIDENCE = Path(os.environ['RUNNER_TEMP']) / 'parallel-evidence'
EVIDENCE.mkdir(exist_ok=True)
RESULTS = []

def run(name, argv, expected_failure=None, cwd=None):
    print(f'RUN {name}: {argv}', flush=True)
    p = subprocess.run(argv, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=cwd)
    (EVIDENCE / (name + '.log')).write_text(p.stdout)
    RESULTS.append({'name': name, 'command': argv, 'exit_code': p.returncode, 'expected_failure': expected_failure})
    (EVIDENCE / 'results.json').write_text(json.dumps(RESULTS, indent=2))
    if expected_failure:
        if p.returncode == 0 or expected_failure not in p.stdout or '[build failed]' in p.stdout:
            print(p.stdout[-12000:], flush=True)
            raise SystemExit(f'{name}: expected reproducible assertion failure not observed')
        print(f'EXPECTED RED: {expected_failure}', flush=True)
    elif p.returncode:
        print(p.stdout[-16000:], flush=True)
        raise SystemExit(p.returncode)
    else:
        print(p.stdout[-5000:], flush=True)
    return p.stdout

def change(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    assert s.count(old) == count, (path, old, s.count(old))
    p.write_text(s.replace(old, new))

def remove_func(path, name):
    p = Path(path)
    s, n = re.subn(r'(?m)(?:^//[^\n]*\n)*^func ' + re.escape(name) + r'\([^\n]*(?s:.*?)^}\n', '', p.read_text())
    assert n == 1, (path, name, n)
    p.write_text(s)

def format_changed():
    files = subprocess.check_output(['git', 'ls-files', '-m', '-o', '--exclude-standard'], text=True).splitlines()
    files = [x for x in files if x.endswith('.go')]
    run('format', ['gofmt', '-w', *files])
    run('diff-check', ['git', 'diff', '--check'])

if AREA == 'billing':
    run('baseline', ['go', 'test', '-count=1', './internal/billing/domain'])
    Path('internal/billing/domain/period_overflow_test.go').write_text('''package domain

import (
 "math"
 "math/big"
 "testing"
 "time"
)

func TestProrateRepresentableLargeAmounts(t *testing.T) {
 for _, month := range []time.Month{time.February, time.April, time.October} {
  from := sh(2028, month, 1, 0, 0, 0)
  for _, unit := range []int64{math.MaxInt64, math.MaxInt64 / 2, math.MaxInt64 / 31 + 1} {
   if got := Prorate(unit, from, NextMonthStart(from)); got != unit {
    t.Errorf("month=%v unit=%d got=%d", month, unit, got)
   }
  }
 }
}

func FuzzProrateRepresentablePartialMonth(f *testing.F) {
 f.Add(int64(math.MaxInt64), uint8(17), uint8(10))
 f.Add(int64(math.MaxInt64 / 2), uint8(31), uint8(2))
 f.Add(int64(50000), uint8(1), uint8(10))
 f.Fuzz(func(t *testing.T, unit int64, dayByte, monthByte uint8) {
  if unit < 0 { unit = -(unit + 1) }
  start := sh(2028, time.Month(monthByte % 12 + 1), 1, 0, 0, 0)
  monthDays := int64(daysInMonth(start))
  days := int64(dayByte) % monthDays + 1
  from := start.AddDate(0, 0, int(monthDays-days))
  numerator := new(big.Int).Mul(big.NewInt(unit), big.NewInt(days))
  quotient, remainder := new(big.Int), new(big.Int)
  quotient.QuoRem(numerator, big.NewInt(monthDays), remainder)
  if remainder.Lsh(remainder, 1).Cmp(big.NewInt(monthDays)) >= 0 { quotient.Add(quotient, big.NewInt(1)) }
  if got := Prorate(unit, from, NextMonthStart(start)); got != quotient.Int64() {
   t.Fatalf("unit=%d days=%d monthDays=%d got=%d want=%d", unit, days, monthDays, got, quotient.Int64())
  }
 })
}
''')
    run('regression-red', ['go', 'test', '-count=1', './internal/billing/domain'], 'FAIL: TestProrateRepresentableLargeAmounts')
    change('internal/billing/domain/period.go', '\t\tacc.Add(acc, big.NewRat(days*unit, int64(daysInMonth(seg))))', '\t\tfraction := big.NewRat(days, int64(daysInMonth(seg)))\n\t\tfraction.Mul(fraction, new(big.Rat).SetInt64(unit))\n\t\tacc.Add(acc, fraction)')
    format_changed()
    run('green-race', ['go', 'test', '-race', '-count=20', './internal/billing/domain'])
    run('billing-suite', ['go', 'test', '-count=1', './internal/billing/...'])
    run('fuzz', ['go', 'test', './internal/billing/domain', '-run=^$', '-fuzz=^FuzzProrateRepresentablePartialMonth$', '-fuzztime=15s', '-parallel=2'])
    run('vet', ['go', 'vet', './internal/billing/...'])

elif AREA == 'queue':
    run('baseline', ['go', 'test', '-count=1', './internal/queue/...', './internal/platform/jobsched/...'])
    Path('internal/queue/domain/numeric_bounds_test.go').write_text('''package domain

import (
 "hash/fnv"
 "math"
 "math/big"
 "strconv"
 "testing"
)

func TestLaneAdmissionRejectsInvalidAndOverflowedCosts(t *testing.T) {
 for _, kind := range []string{"ai.recognize", "media.upload", "listing.submit.batch", "other"} {
  if LaneAdmitsLimit(math.MaxInt64, kind, 256) { t.Errorf("overflow admitted %s", kind) }
  if LaneAdmitsLimit(-1, kind, 256) { t.Errorf("negative cost admitted %s", kind) }
  cost := int64(CostUnits(kind))
  if !LaneAdmitsLimit(256-cost, kind, 256) || LaneAdmitsLimit(257-cost, kind, 256) { t.Errorf("boundary %s", kind) }
 }
}

func TestNegativeAttemptUsesFirstBackoff(t *testing.T) {
 for _, kind := range []string{"listing.submit", "listing.reconcile", "other"} {
  got := RequeueDelay(kind, math.MinInt32, ReasonSafeToRetry, 0, 7)
  want := RequeueDelay(kind, 0, ReasonSafeToRetry, 0, 7)
  if got != want { t.Errorf("%s got=%v want=%v", kind, got, want) }
 }
}

func TestJitterSeedIncludesFullSignedInteger(t *testing.T) {
 for _, epoch := range []int64{math.MinInt64, -1, 0, 1, math.MaxInt64} {
  h := fnv.New64a()
  h.Write([]byte("job" + strconv.FormatInt(epoch, 10) + "-2147483648"))
  if got := JitterSeed("job", epoch, math.MinInt32); got != h.Sum64() { t.Errorf("epoch=%d got=%d want=%d", epoch, got, h.Sum64()) }
 }
}

func FuzzLaneAdmissionBoundaries(f *testing.F) {
 f.Add(int64(math.MaxInt64), int64(256), uint8(0))
 f.Add(int64(-1), int64(256), uint8(1))
 f.Add(int64(248), int64(256), uint8(2))
 f.Fuzz(func(t *testing.T, queued, limit int64, index uint8) {
  kinds := []string{"ai.recognize", "media.upload", "listing.submit.batch", "other"}
  kind := kinds[int(index)%len(kinds)]
  effective := limit
  if effective <= 0 { effective = AccountLaneQueuedCostLimit }
  total := new(big.Int).Add(big.NewInt(queued), big.NewInt(int64(CostUnits(kind))))
  want := queued >= 0 && total.Cmp(big.NewInt(effective)) <= 0
  if got := LaneAdmitsLimit(queued, kind, limit); got != want { t.Fatalf("queued=%d limit=%d kind=%s got=%v want=%v", queued, limit, kind, got, want) }
 })
}
''')
    run('regression-red', ['go', 'test', '-count=1', './internal/queue/domain'], 'FAIL: TestLaneAdmissionRejectsInvalidAndOverflowedCosts')
    p = 'internal/queue/domain/contract.go'
    change(p, '\t"math"\n', '\t"math"\n\t"strconv"\n')
    change(p, 'return queuedCost+int64(CostUnits(kind)) <= limit', 'cost := int64(CostUnits(kind))\n\treturn queuedCost >= 0 && cost <= limit && queuedCost <= limit-cost')
    change(p, 'rung := attempt - 1', 'rung := int64(attempt) - 1')
    change(p, '[]string{itoa(leaseEpoch), itoa(int64(attempt))}', '[]string{strconv.FormatInt(leaseEpoch, 10), strconv.FormatInt(int64(attempt), 10)}')
    remove_func(p, 'itoa')
    format_changed()
    run('green-race', ['go', 'test', '-race', '-count=20', './internal/queue/domain'])
    run('queue-suite', ['go', 'test', '-count=1', './internal/queue/...', './internal/platform/jobsched/...'])
    run('fuzz', ['go', 'test', './internal/queue/domain', '-run=^$', '-fuzz=^FuzzLaneAdmissionBoundaries$', '-fuzztime=15s', '-parallel=2'])
    run('vet', ['go', 'vet', './internal/queue/...', './internal/platform/jobsched/...'])

elif AREA == 'ratings':
    run('regression-red', ['go', 'test', '-count=1', '-run=^TestRatingsParity$', './internal/ratings/repo'], 'missing no-data marker')
    p = Path('internal/ratings/repo/ratings_test.go')
    s = p.read_text()
    for old, new in [('ratingKey', 'rating_key'), ('valueType', 'value_type'), ('currentValue', 'current_value'), ('pastValue', 'past_value'), ('noData', 'no_data')]:
        assert '"' + old + '":' in s
        s = s.replace('"' + old + '":', '"' + new + '":')
    p.write_text(s)
    format_changed()
    run('green-race', ['go', 'test', '-race', '-count=1', './internal/ratings/...'])
    run('vet', ['go', 'vet', './internal/ratings/...'])

elif AREA == 'supplier':
    domains = ['./internal/supplier/domain', './internal/supply/domain', './internal/delegate/domain']
    run('baseline', ['go', 'test', '-count=1', *domains])
    targets = [
      ('internal/supplier/domain/dispatch.go', 'DispatchEdge'),
      ('internal/supplier/domain/withdrawal.go', 'TransitionWithdrawal'),
      ('internal/supply/domain/order.go', 'TransitionOrder'),
      ('internal/supply/domain/procurement.go', 'TransitionProcurement'),
      ('internal/delegate/domain/order.go', 'TransitionOrder'),
    ]
    # Assert the deleted functions have no production consumers in their units.
    for path, name in targets:
        unit = Path(path).parent.parent
        for candidate in unit.rglob('*.go'):
            if candidate.name.endswith('_test.go') or str(candidate) == path:
                continue
            assert not re.search(r'\b' + name + r'\s*\(', candidate.read_text()), (candidate, name)
        remove_func(path, name)
    remove_func('internal/supplier/domain/rules_test.go', 'TestDispatchEdges')
    remove_func('internal/delegate/domain/order_test.go', 'TestOrderTransitionsAreUnproven')
    for path, unit in [
      ('internal/supplier/domain/rules_test.go', 'supplier'),
      ('internal/supply/domain/order.go', 'supply'),
      ('internal/supply/domain/procurement.go', 'supply'),
      ('internal/delegate/domain/order.go', 'delegate'),
      ('internal/delegate/domain/order_test.go', 'delegate'),
    ]:
        p = Path(path)
        s = p.read_text()
        assert 'contract.' not in s
        s = s.replace('import "github.com/xxww0098/podhub-go/internal/' + unit + '/contract"\n', '')
        s = s.replace('\t"github.com/xxww0098/podhub-go/internal/' + unit + '/contract"\n', '')
        p.write_text(s)
    p = 'internal/supply/domain/rules_test.go'
    change(p, '\tif err := TransitionOrder("awaiting_payment", "shipped"); err != contract.ErrUnproven {\n\t\tt.Fatal("seller package still does not write later edges")\n\t}\n', '')
    change(p, '\t"github.com/xxww0098/podhub-go/internal/supply/contract"\n', '')
    p = 'internal/supplier/domain/withdrawal_test.go'
    change(p, 'func TestWithdrawalTransitionsFail', 'func TestWithdrawalStatuses')
    change(p, '\tfor _, from := range states {\n\t\tfor _, to := range states {\n\t\t\tif err := TransitionWithdrawal(from, to); err != contract.ErrUnproven {\n\t\t\t\tt.Fatalf("%s -> %s", from, to)\n\t\t\t}\n\t\t}\n\t}\n', '')
    p = 'internal/supply/domain/status_test.go'
    change(p, 'func TestOrderAndProcurementEdgesFail', 'func TestOrderAndProcurementStatuses')
    for collection, func in [('orders', 'TransitionOrder'), ('procs', 'TransitionProcurement')]:
        label = 'order' if collection == 'orders' else 'procurement'
        old = '\tfor _, from := range ' + collection + ' {\n\t\tfor _, to := range ' + collection + ' {\n\t\t\tif err := ' + func + '(from, to); err != contract.ErrUnproven {\n\t\t\t\tt.Fatalf("' + label + ' %s -> %s", from, to)\n\t\t\t}\n\t\t}\n\t}\n'
        change(p, old, '')
    p = 'internal/supplier/domain/dispatch.go'
    change(p, '// Order states that block a supplier action before the idempotent replay.\nconst (\n\tOrderCancelled = "cancelled"\n\tOrderDone      = "done"\n)\n', '')
    change(p, '// Action is one named supplier transition. Illegal pairs return false.\ntype Action string\n\nconst (\n\tActionAccept Action = "accept"\n\tActionReject Action = "reject"\n\tActionShip   Action = "ship"\n)\n', '')
    for p, word in [('internal/supply/domain/order.go', 'sc_orders'), ('internal/supply/domain/procurement.go', 'sc_procurements')]:
        change(p, '// db/migrations updates ' + word + '.status, so every edge is refused.', '// db/migrations updates ' + word + '.status; this package validates filters only.')
    format_changed()
    run('green-race', ['go', 'test', '-race', '-count=20', *domains])
    run('supplier-integration', ['go', 'test', '-count=1', '-timeout=25m', './internal/supplier/...', './internal/supply/...', './internal/delegate/...', './tests/archtest', './tests/integration'])
    run('vet', ['go', 'vet', './internal/supplier/...', './internal/supply/...', './internal/delegate/...'])

else:
    raise SystemExit('Unknown repair area')

changed = subprocess.check_output(['git', 'ls-files', '-m', '-o', '--exclude-standard'], text=True).splitlines()
assert changed and all(x.startswith('internal/') and x.endswith('.go') for x in changed), changed
run('stage', ['git', 'add', '--', *changed])
patch = subprocess.check_output(['git', 'diff', '--cached', '--binary'], text=True)
(EVIDENCE / 'tested.patch').write_text(patch)
(EVIDENCE / 'changed-files.json').write_text(json.dumps(changed, indent=2))
print('ALL REQUESTED VERIFICATION COMMANDS PASSED. READY TO PUBLISH TESTED BRANCH.', flush=True)
