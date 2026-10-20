package identity

import (
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// Absolute budgets copied from the Rust admission comments. Pool-derived
// ceilings (interactive, regular write, global, AI) are named here and listed
// as unproven in docs/parity/identity-parity.md.
const (
	BudgetMediaUploadPerUser  = 2
	BudgetPsdPerUser          = 6
	BudgetControlReserved     = 16
	BudgetControlPerUser      = 8
	BudgetWaitingRoomPerSlot  = 8
	BudgetInteractivePerUser  = 8
	BudgetRegularWritePerUser = 4
	BudgetMediaProbePerUser   = 4
	BudgetAIPerUser           = 2
	BudgetGlobal              = 64
	maxRetryAfterSecs         = 30
)

// Limits is one process admission configuration.
type Limits struct {
	Global              int
	InteractivePerUser  int
	RegularWritePerUser int
	MediaUploadPerUser  int
	PsdPerUser          int
	MediaProbePerUser   int
	AIPerUser           int
	ControlReserved     int
	ControlPerUser      int
	UserWait            time.Duration
	GlobalWait          time.Duration
}

// DefaultLimits uses the absolute Rust budgets and the unproven derived ones.
func DefaultLimits() Limits {
	return Limits{
		Global:              BudgetGlobal,
		InteractivePerUser:  BudgetInteractivePerUser,
		RegularWritePerUser: BudgetRegularWritePerUser,
		MediaUploadPerUser:  BudgetMediaUploadPerUser,
		PsdPerUser:          BudgetPsdPerUser,
		MediaProbePerUser:   BudgetMediaProbePerUser,
		AIPerUser:           BudgetAIPerUser,
		ControlReserved:     BudgetControlReserved,
		ControlPerUser:      BudgetControlPerUser,
		UserWait:            10 * time.Second,
		GlobalWait:          10 * time.Second,
	}
}

func (l Limits) perUser(class RouteClass) int {
	switch class {
	case ClassInteractiveRead:
		return l.InteractivePerUser
	case ClassRegularWrite:
		return l.RegularWritePerUser
	case ClassMediaUpload:
		return l.MediaUploadPerUser
	case ClassPsdUpload:
		return l.PsdPerUser
	case ClassMediaProbe:
		return l.MediaProbePerUser
	case ClassAI, ClassOCR:
		return l.AIPerUser
	default:
		return l.ControlPerUser
	}
}

type slotLimiter struct {
	slots   chan struct{}
	wait    time.Duration
	maxWait int
	waiting atomic.Int64
	holdMS  atomic.Uint64
}

func newSlotLimiter(permits int, wait time.Duration) *slotLimiter {
	if permits < 1 {
		permits = 1
	}
	room := permits * BudgetWaitingRoomPerSlot
	if room < BudgetWaitingRoomPerSlot {
		room = BudgetWaitingRoomPerSlot
	}
	lim := &slotLimiter{slots: make(chan struct{}, permits), wait: wait, maxWait: room}
	for i := 0; i < permits; i++ {
		lim.slots <- struct{}{}
	}
	return lim
}

func (l *slotLimiter) acquire() bool {
	select {
	case <-l.slots:
		return true
	default:
	}
	if int(l.waiting.Add(1)) > l.maxWait {
		l.waiting.Add(-1)
		return false
	}
	timer := time.NewTimer(l.wait)
	defer timer.Stop()
	select {
	case <-l.slots:
		l.waiting.Add(-1)
		return true
	case <-timer.C:
		l.waiting.Add(-1)
		return false
	}
}

func (l *slotLimiter) release(held time.Duration) {
	sample := uint64(held.Milliseconds())
	for {
		old := l.holdMS.Load()
		var next uint64
		if old == 0 {
			next = sample
		} else {
			next = old - old/8 + sample/8
		}
		if l.holdMS.CompareAndSwap(old, next) {
			break
		}
	}
	l.slots <- struct{}{}
}

func (l *slotLimiter) retryAfter() int {
	secs := int((l.holdMS.Load() + 999) / 1000)
	if secs < 1 {
		secs = 1
	}
	if secs > maxRetryAfterSecs {
		secs = maxRetryAfterSecs
	}
	return secs
}

// Admission is the per-user fairness gate. Anonymous requests skip it.
type Admission struct {
	limits Limits
	global *slotLimiter
	users  sync.Map
}

func NewAdmission(limits Limits) *Admission {
	global := limits.Global
	if global < 1 {
		global = 1
	}
	return &Admission{limits: limits, global: newSlotLimiter(global, limits.GlobalWait)}
}

type userKey struct {
	user  int64
	class RouteClass
}

func (a *Admission) userLimiter(user int64, class RouteClass) *slotLimiter {
	if class == ClassOCR {
		class = ClassAI
	}
	key := userKey{user: user, class: class}
	if existing, ok := a.users.Load(key); ok {
		return existing.(*slotLimiter)
	}
	created := newSlotLimiter(a.limits.perUser(class), a.limits.UserWait)
	actual, _ := a.users.LoadOrStore(key, created)
	return actual.(*slotLimiter)
}

// Admit waits for the user's slot, then the process slot. OCR and AI skip the process ceiling.
func (a *Admission) Admit(user int64, class RouteClass) (release func(), status int, message string, retry int) {
	userLim := a.userLimiter(user, class)
	started := time.Now()
	if !userLim.acquire() {
		return nil, http.StatusTooManyRequests, "当前用户的并发预算已用尽，请稍后重试", userLim.retryAfter()
	}
	var globalLim *slotLimiter
	if class != ClassAI && class != ClassOCR {
		globalLim = a.global
		if !globalLim.acquire() {
			userLim.release(time.Since(started))
			return nil, http.StatusServiceUnavailable, "服务繁忙，请稍后重试", globalLim.retryAfter()
		}
	}
	return func() {
		if globalLim != nil {
			globalLim.release(time.Since(started))
		}
		userLim.release(time.Since(started))
	}, 0, "", 0
}
