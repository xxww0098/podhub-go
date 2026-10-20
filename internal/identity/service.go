package identity

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"runtime"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
)

const (
	msgUnavailable     = "服务暂不可用"
	msgBadJSON         = "请求格式无效"
	msgBadLogin        = "邮箱或密码错误"
	msgDisabled        = "账号已禁用"
	msgRegistered      = "邮箱已注册"
	msgBadCredential   = "邮箱或密码不符合要求"
	msgNotInitialized  = "平台尚未初始化，请先完成管理员初始化"
	msgBusyHash        = "请求过于频繁，请稍后重试"
	msgThrottle        = "登录失败次数过多，请稍后再试"
	msgBadLink         = "链接无效或已过期"
	msgBadCurrent      = "当前密码不正确"
	msgPasswordBounds  = "密码至少 8 位，且不超过 72 字节"
	msgSamePassword    = "新密码不能与当前密码相同"
	msgCredentialDrift = "凭证已变更，请重新登录"
	msgBadAccount      = "账号标识无效"
	msgNotInStack      = "该账号不在此设备的登录列表"
	msgLoggedOut       = "未登录"
	msgBadWorkspace    = "无效的 Workspace"
	msgNoSwitch        = "无权切换到该 Workspace"
	msgInvite          = "邀请码无效"
	msgTotp            = "需要验证器代码"
	msgNoWorkspace     = "当前账号尚未加入任何工作空间，请先创建工作空间，或等待他人邀请后在通知中接受"
	msgBadRole         = "工作空间角色无效"
	msgBusy            = "资源正在更新，请稍后重试"
	msgMediaGone       = "媒体对象已进入回收，请重新上传"
)

// Result is one HTTP reply. Cookies are raw Set-Cookie values.
type Result struct {
	Status     int
	Body       []byte
	Cookies    []string
	RetryAfter string
}

// Service is the identity write and read path.
type Service struct {
	pool      *pgxpool.Pool
	slots     chan struct{}
	admission *Admission
	handoff   *handoffStore
}

func New(pool *pgxpool.Pool) *Service {
	n := runtime.GOMAXPROCS(0) * 2
	if n < 4 {
		n = 4
	}
	slots := make(chan struct{}, n)
	for i := 0; i < n; i++ {
		slots <- struct{}{}
	}
	return &Service{
		pool:      pool,
		slots:     slots,
		admission: NewAdmission(DefaultLimits()),
		handoff:   newHandoffStore(),
	}
}

func (s *Service) acquirePassword() bool {
	select {
	case <-s.slots:
		return true
	default:
		return false
	}
}

func (s *Service) releasePassword() { s.slots <- struct{}{} }

func (s *Service) q(ctx context.Context) *sqlc.Queries {
	return sqlc.New(s.pool)
}

func authResult(status int, message, code string) Result {
	raw, _ := json.Marshal(struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}{Error: message, Code: code})
	return Result{Status: status, Body: raw}
}

func dbResult(err error) Result {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "55P03":
			res := authResult(http.StatusServiceUnavailable, msgBusy, "INTERNAL")
			res.RetryAfter = "1"
			return res
		case "P0M01":
			return authResult(http.StatusConflict, msgMediaGone, "INTERNAL")
		}
	}
	return authResult(http.StatusInternalServerError, msgUnavailable, "INTERNAL")
}

func (s *Service) inTx(ctx context.Context, fn func(q *sqlc.Queries) (bool, error)) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	audited, err := fn(sqlc.New(tx))
	if err != nil {
		return err
	}
	if !audited {
		return errors.New("audit sink empty")
	}
	return tx.Commit(ctx)
}

type account struct {
	id            int64
	publicID      string
	email         string
	role          string
	name          string
	supplierID    string
	orgID         int64
	workspaceRole string
	target        string
}

var (
	errNotReady   = errors.New("platform not initialized")
	errRegistered = errors.New("email registered")
)

var errDrift = errors.New("credential changed")

var (
	errBadLink  = errors.New("bad link")
	errDisabled = errors.New("disabled")
)

type handoffStore struct {
	mu    chan struct{}
	items map[string]time.Time
}
