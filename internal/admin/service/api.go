package service

import (
	"context"
	"crypto/rand"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

const bcryptCost = 12

// Catalogue fetches one model list. The HTTP layer supplies a loopback client.
type Catalogue interface {
	Fetch(ctx context.Context, endpoint, format, apiKey string) (status int, body []byte, pinned bool, err error)
}

// API is the admin users and AI-auth behavior.
type API struct {
	DB             DB
	Now            func() time.Time
	TotpKey        string
	IntegrationKey string
	Loopback       bool
	Fetch          Catalogue
}

func (a *API) now() time.Time {
	if a == nil || a.Now == nil {
		return time.Now()
	}
	return a.Now()
}

// RequireStepUp is the enrolled-and-elevated half of require_super_admin.
func (a *API) RequireStepUp(ctx context.Context, actor domain.Actor) *contract.Fault {
	enrolled, elevated, fault := a.DB.Standing(ctx, actor.TokenHash, actor.ID)
	if fault != nil {
		return fault
	}
	if !enrolled {
		return contract.Forbidden("请先绑定验证器")
	}
	if !elevated {
		return contract.Forbidden("管理操作需要重新验证")
	}
	return nil
}

func (a *API) ListUsers(ctx context.Context, actor domain.Actor) (any, *contract.Fault) {
	dir, fault := a.DB.ListDirectory(ctx, actor)
	if fault != nil {
		return nil, fault
	}
	return directoryBody(actor, dir), nil
}

func (a *API) CreateUser(ctx context.Context, actor domain.Actor, email, password, name, role string) (int, any, *contract.Fault) {
	email = strings.ToLower(strings.TrimSpace(email))
	if !domain.CreateCredential(email, password) {
		return 0, nil, contract.Validation("邮箱或密码不符合要求")
	}
	rank := domain.RankUser
	if strings.TrimSpace(role) != "" {
		parsed, ok := domain.ParseRank(role)
		if !ok {
			return 0, nil, contract.Validation("角色无效")
		}
		rank = parsed
	}
	if msg, ok := domain.Authorize(actor.Role, domain.Change{Kind: "create", Role: rank}, domain.RankUser, false); !ok {
		return 0, nil, contract.Forbidden(msg)
	}
	display := email
	if strings.TrimSpace(name) != "" {
		display = strings.TrimSpace(name)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return 0, nil, contract.Internal("新增用户失败")
	}
	publicID, err := newPublicID()
	if err != nil {
		return 0, nil, contract.Internal("服务暂不可用")
	}
	account, _, fault := a.DB.CreateUser(ctx, actor, publicID, email, display, rank, string(hash))
	if fault != nil {
		return 0, nil, fault
	}
	return 201, mutationBody(actor, account), nil
}

func (a *API) SetStatus(ctx context.Context, actor domain.Actor, publicID string, enabled bool) (any, *contract.Fault) {
	account, fault := a.DB.SetStatus(ctx, actor, strings.TrimSpace(publicID), enabled, "/api/admin/users/"+strings.TrimSpace(publicID)+"/status")
	if fault != nil {
		return nil, fault
	}
	return mutationBody(actor, account), nil
}

func (a *API) SetRole(ctx context.Context, actor domain.Actor, publicID, role string) (any, *contract.Fault) {
	parsed, ok := domain.ParseRank(role)
	if !ok {
		return nil, contract.Validation("角色无效")
	}
	account, fault := a.DB.SetRole(ctx, actor, strings.TrimSpace(publicID), parsed, "/api/admin/users/"+strings.TrimSpace(publicID)+"/admin")
	if fault != nil {
		return nil, fault
	}
	return mutationBody(actor, account), nil
}

func (a *API) SetPassword(ctx context.Context, actor domain.Actor, publicID, password string) (any, *contract.Fault) {
	if msg := domain.PasswordReset(password); msg != "" {
		return nil, contract.Validation(msg)
	}
	password = strings.TrimSpace(password)
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return nil, contract.Internal("操作失败")
	}
	id := strings.TrimSpace(publicID)
	_, fault := a.DB.SetPassword(ctx, actor, id, string(hash), "/api/admin/users/"+id+"/password", actor.PublicID == id)
	if fault != nil {
		return nil, fault
	}
	return okBody(), nil
}

func (a *API) SetSeats(ctx context.Context, actor domain.Actor, publicID string, seats int64) (any, *contract.Fault) {
	if !domain.SeatRange(seats) {
		return nil, contract.Validation("成员名额需在 1-200 之间")
	}
	id := strings.TrimSpace(publicID)
	account, fault := a.DB.SetSeats(ctx, actor, id, "/api/admin/users/"+id+"/seats", seats)
	if fault != nil {
		return nil, fault
	}
	return mutationBody(actor, account), nil
}

func (a *API) PreviewSeats(ctx context.Context, actor domain.Actor, publicID string, intent domain.SeatIntent, workspaceID *int64) (any, *contract.Fault) {
	id := strings.TrimSpace(publicID)
	account, fault := a.DB.ReadAccount(ctx, id)
	if fault != nil {
		return nil, fault
	}
	if account.ID != actor.ID {
		if msg, ok := domain.Authorize(actor.Role, domain.Change{Kind: "edit"}, account.Role, false); !ok {
			return nil, contract.Forbidden(msg)
		}
	}
	_, load, fault := a.DB.PreviewSeats(ctx, id, workspaceID)
	if fault != nil {
		return nil, fault
	}
	target, msg := domain.ResolveSeats(load.State, intent)
	if msg != "" {
		return nil, contract.Validation(msg)
	}
	members := domain.PlanMembers(target.SeatLimit, load.Members)
	stores := domain.PlanStores(target.StoreLimit, load.Stores)
	return previewBody(load.State, target, members, stores), nil
}

func (a *API) ApplySeats(ctx context.Context, actor domain.Actor, publicID string, intent domain.SeatIntent, workspaceID *int64, revision, stores int64) (any, *contract.Fault) {
	id := strings.TrimSpace(publicID)
	account, fault := a.DB.ReadAccount(ctx, id)
	if fault != nil {
		return nil, fault
	}
	if account.ID != actor.ID {
		if msg, ok := domain.Authorize(actor.Role, domain.Change{Kind: "edit"}, account.Role, false); !ok {
			return nil, contract.Forbidden(msg)
		}
	}
	members, storePlan, target, next, fault := a.DB.ApplySeats(ctx, actor, id, "/api/admin/users/"+id+"/member-seats/apply", workspaceID, intent, revision, stores)
	if fault != nil {
		return nil, fault
	}
	return applyBody(target, members, storePlan, next), nil
}

func (a *API) Dissolve(ctx context.Context, actor domain.Actor, uuid, name string) (any, *contract.Fault) {
	uuid = strings.TrimSpace(uuid)
	if !domain.DissolveUUID(uuid) {
		return nil, contract.Validation("工作空间无效")
	}
	if !domain.DissolveName(name) {
		return nil, contract.Validation("请输入当前工作空间名称以确认解散")
	}
	if fault := a.DB.Dissolve(ctx, actor, uuid, strings.TrimSpace(name), "/api/admin/workspaces/"+uuid+"/dissolve"); fault != nil {
		return nil, fault
	}
	return okBody(), nil
}

func newPublicID() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	const hexdigits = "0123456789abcdef"
	out := make([]byte, 36)
	j := 0
	for i, b := range buf {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			out[j] = '-'
			j++
		}
		out[j] = hexdigits[b>>4]
		out[j+1] = hexdigits[b&0x0f]
		j += 2
	}
	return string(out), nil
}
