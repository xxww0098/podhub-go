package identity

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	idservice "github.com/xxww0098/podhub-go/internal/identity/service"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
)

var (
	errInvitationInvalid   = errors.New("邀请无效、已处理或已过期，请联系创建者重新邀请")
	errInvitationRole      = errors.New("无权执行该邀请操作")
	errInvitationSeats     = errors.New("工作空间成员名额已满，请联系所有者释放名额后重试")
	errInvitationPending   = errors.New("待接受的邀请已达上限，请先撤销不再需要的邀请")
	errInvitationDuplicate = errors.New("该邮箱已有待接受的邀请，请先撤销原邀请")
	errInvitationMember    = errors.New("该邮箱已经是工作空间成员")
)

type createdInvitation struct {
	UUID         string `json:"uuid"`
	Token        string `json:"token"`
	Email        string `json:"email"`
	Role         string `json:"role"`
	ExpiresAtMS  int64  `json:"expires_at_ms"`
	PendingUsed  int64  `json:"pending_used"`
	PendingLimit int64  `json:"pending_limit"`
	Notified     bool   `json:"notified"`
}

// Take the email lock before user rows in registration, invitations and email changes.
func lockInvitationEmail(ctx context.Context, tx pgx.Tx, email string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('workspace-invitation-email:' || lower($1), 0))`, email)
	return err
}

func notifyPendingInvitations(ctx context.Context, tx pgx.Tx, userID int64) error {
	_, err := tx.Exec(ctx, `INSERT INTO notifications (user_id,kind,payload,invitation_id)
	 SELECT $1,'team_invitation',jsonb_build_object('teamName',o.name,'role',i.role,'invitedByEmail',i.invited_by_email),i.id
	 FROM org_invitations i JOIN organizations o ON o.id=i.org_id
	 WHERE i.invitee_user_id=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
	 AND i.declined_at IS NULL AND i.expires_at>clock_timestamp() AND o.dissolved_at IS NULL
	 ON CONFLICT (user_id,invitation_id) WHERE invitation_id IS NOT NULL DO NOTHING`, userID)
	return err
}

func decodeBoundedJSON(r *http.Request, value any) bool {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 8193))
	if err != nil || len(raw) > 8192 {
		return false
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	return dec.Decode(value) == nil && dec.Decode(new(any)) == io.EOF
}

func invitationResult(err error) Result {
	if errors.Is(err, errInvitationRole) {
		return authResult(http.StatusForbidden, err.Error(), "FORBIDDEN")
	}
	for _, expected := range []error{errInvitationInvalid, errInvitationSeats, errInvitationPending, errInvitationDuplicate, errInvitationMember} {
		if errors.Is(err, expected) {
			return authResult(http.StatusBadRequest, err.Error(), "VALIDATION")
		}
	}
	return dbResult(err)
}

func invitationJSON(value any) Result {
	raw, err := json.Marshal(value)
	if err != nil {
		return dbResult(err)
	}
	return Result{Status: http.StatusOK, Body: raw}
}

func invitationActor(ctx context.Context, tx pgx.Tx, acc account, orgID int64) (access.WorkspaceRole, string, error) {
	var name, stored string
	if err := tx.QueryRow(ctx, `SELECT name FROM organizations WHERE id=$1 AND dissolved_at IS NULL FOR UPDATE`, orgID).Scan(&name); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", errInvitationRole
		}
		return "", "", err
	}
	err := tx.QueryRow(ctx, `SELECT m.role FROM organization_members m JOIN account_users u ON u.id=m.user_id
	 WHERE m.org_id=$1 AND m.user_id=$2 AND m.status='active' AND NOT m.manual_disabled AND NOT m.quota_suspended
	 AND u.disabled_at IS NULL FOR UPDATE OF m`, orgID, acc.id).Scan(&stored)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", errInvitationRole
	}
	if err != nil {
		return "", "", err
	}
	role, ok := access.ParseWorkspace(stored)
	if !ok {
		return "", "", errInvitationRole
	}
	return role, name, nil
}

func invitationCapacity(ctx context.Context, tx pgx.Tx, orgID int64) error {
	var used, limit int64
	err := tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM organization_members WHERE org_id=$1 AND status='active' AND NOT manual_disabled),members
	 FROM public.subscription_capacity($1,clock_timestamp())`, orgID).Scan(&used, &limit)
	if err != nil {
		return err
	}
	if used >= limit {
		return errInvitationSeats
	}
	return nil
}

func (s *Service) CreateInvitation(r *http.Request) Result {
	_, _, acc, res, ok := s.requireAccount(r)
	if !ok {
		return res
	}
	if acc.orgID <= 0 || IsSupplierAccount(acc.accountKind) {
		return invitationResult(errInvitationRole)
	}
	var body struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if !decodeBoundedJSON(r, &body) {
		return authResult(http.StatusBadRequest, msgBadJSON, "VALIDATION")
	}
	email := strings.ToLower(strings.TrimSpace(body.Email))
	if len(email) > 320 || !EmailShaped(email) || strings.IndexFunc(email, unicode.IsControl) >= 0 || strings.EqualFold(email, acc.email) {
		return authResult(http.StatusBadRequest, "请输入其他成员的有效邮箱", "VALIDATION")
	}
	target, valid := access.ParseWorkspace(body.Role)
	if !valid || (body.Role != "manager" && body.Role != "member") {
		return authResult(http.StatusBadRequest, "只能邀请主管或运营", "VALIDATION")
	}
	token, err := randomToken()
	if err != nil {
		return dbResult(err)
	}
	created := createdInvitation{Token: token, Email: email, Role: string(target), PendingLimit: idservice.PendingInviteLimit}
	err = s.inTx(r.Context(), func(tx pgx.Tx, q *sqlc.Queries) (bool, error) {
		ctx := r.Context()
		if err := lockInvitationEmail(ctx, tx, email); err != nil {
			return false, err
		}
		if _, err := q.LockAccount(ctx, acc.id); err != nil {
			return false, err
		}
		actor, _, err := invitationActor(ctx, tx, acc, acc.orgID)
		if err != nil {
			return false, err
		}
		if !actor.MayInvite(target) {
			return false, errInvitationRole
		}
		if err := invitationCapacity(ctx, tx, acc.orgID); err != nil {
			return false, err
		}
		var member bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM organization_members m JOIN account_users u ON u.id=m.user_id WHERE m.org_id=$1 AND lower(u.email)=$2)`, acc.orgID, email).Scan(&member); err != nil {
			return false, err
		}
		if member {
			return false, errInvitationMember
		}
		if _, err := tx.Exec(ctx, `UPDATE org_invitations SET revoked_at=clock_timestamp(),updated_at=clock_timestamp()
		 WHERE org_id=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL AND expires_at<=clock_timestamp()`, acc.orgID, email); err != nil {
			return false, err
		}
		var duplicate bool
		if err := tx.QueryRow(ctx, `SELECT count(*),COALESCE(bool_or(lower(email)=$2),false) FROM org_invitations
		 WHERE org_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL AND expires_at>clock_timestamp()`, acc.orgID, email).Scan(&created.PendingUsed, &duplicate); err != nil {
			return false, err
		}
		if duplicate {
			return false, errInvitationDuplicate
		}
		if created.PendingUsed >= idservice.PendingInviteLimit {
			return false, errInvitationPending
		}
		var invitee *int64
		err = tx.QueryRow(ctx, `SELECT id FROM account_users WHERE lower(email)=$1 AND account_kind='platform' AND disabled_at IS NULL`, email).Scan(&invitee)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return false, err
		}
		var expires time.Time
		if err := tx.QueryRow(ctx, `INSERT INTO org_invitations (org_id,email,role,token_hash,invited_by_user_id,invited_by_email,invitee_user_id,expires_at,created_at,updated_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '7 days',clock_timestamp(),clock_timestamp()) RETURNING uuid::text,expires_at`, acc.orgID, email, created.Role, hashToken(token), acc.id, acc.email, invitee).Scan(&created.UUID, &expires); err != nil {
			return false, err
		}
		created.ExpiresAtMS = expires.UnixMilli()
		created.PendingUsed++
		if invitee != nil {
			if err := notifyPendingInvitations(ctx, tx, *invitee); err != nil {
				return false, err
			}
		}
		return true, invitationAudit(ctx, q, acc, acc.orgID, created.UUID, r, "workspace_invitation_created")
	})
	if err != nil {
		return invitationResult(err)
	}
	return invitationJSON(created)
}

type invitationRow struct {
	id, orgID, inviter                   int64
	role                                 string
	accepted, declined, revoked, expired bool
	acceptedUser                         *int64
}

func (s *Service) RespondInvitation(r *http.Request, id string, accept bool) Result {
	_, _, acc, res, ok := s.requireAccount(r)
	if !ok {
		return res
	}
	if IsSupplierAccount(acc.accountKind) {
		return invitationResult(errInvitationRole)
	}
	parsed, err := uuid.Parse(id)
	if err != nil || !strings.EqualFold(parsed.String(), id) {
		return invitationResult(errInvitationInvalid)
	}
	var proof struct {
		Token string `json:"token"`
	}
	if !decodeBoundedJSON(r, &proof) || !IsSessionToken(proof.Token) {
		return invitationResult(errInvitationInvalid)
	}
	var invite invitationRow
	err = s.inTx(r.Context(), func(tx pgx.Tx, q *sqlc.Queries) (bool, error) {
		ctx := r.Context()
		current, err := q.LockUserState(ctx, acc.id)
		if err != nil {
			return false, err
		}
		if current.Disabled || !strings.EqualFold(current.Email, acc.email) {
			return false, errInvitationInvalid
		}
		if err := tx.QueryRow(ctx, `SELECT org_id FROM org_invitations WHERE uuid=$1::uuid AND lower(email)=lower($2) AND token_hash=$3 AND (invitee_user_id IS NULL OR invitee_user_id=$4)`, parsed.String(), acc.email, hashToken(proof.Token), acc.id).Scan(&invite.orgID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return false, errInvitationInvalid
			}
			return false, err
		}
		var workspace int64
		if err := tx.QueryRow(ctx, `SELECT id FROM organizations WHERE id=$1 AND dissolved_at IS NULL FOR UPDATE`, invite.orgID).Scan(&workspace); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return false, errInvitationInvalid
			}
			return false, err
		}
		if err := tx.QueryRow(ctx, `SELECT id,role,invited_by_user_id,accepted_at IS NOT NULL,accepted_user_id,declined_at IS NOT NULL,revoked_at IS NOT NULL,expires_at<=clock_timestamp()
		 FROM org_invitations WHERE uuid=$1::uuid AND org_id=$2 AND lower(email)=lower($3) AND token_hash=$4 AND (invitee_user_id IS NULL OR invitee_user_id=$5) FOR UPDATE`, parsed.String(), invite.orgID, acc.email, hashToken(proof.Token), acc.id).Scan(&invite.id, &invite.role, &invite.inviter, &invite.accepted, &invite.acceptedUser, &invite.declined, &invite.revoked, &invite.expired); err != nil {
			return false, err
		}
		if accept && invite.accepted && invite.acceptedUser != nil && *invite.acceptedUser == acc.id {
			return true, nil
		}
		if !accept && invite.declined {
			return true, nil
		}
		if invite.accepted || invite.declined || invite.revoked || invite.expired {
			return false, errInvitationInvalid
		}
		if accept {
			var inviterRole string
			err := tx.QueryRow(ctx, `SELECT m.role FROM organization_members m JOIN account_users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.user_id=$2 AND m.status='active' AND NOT m.manual_disabled AND NOT m.quota_suspended AND u.disabled_at IS NULL`, invite.orgID, invite.inviter).Scan(&inviterRole)
			inviter, valid := access.ParseWorkspace(inviterRole)
			target, targetValid := access.ParseWorkspace(invite.role)
			if errors.Is(err, pgx.ErrNoRows) || err == nil && (!valid || !targetValid || !inviter.MayInvite(target)) {
				return false, errInvitationInvalid
			}
			if err != nil {
				return false, err
			}
			var exists bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM organization_members WHERE org_id=$1 AND user_id=$2)`, invite.orgID, acc.id).Scan(&exists); err != nil {
				return false, err
			}
			if exists {
				return false, errInvitationMember
			}
			if err := invitationCapacity(ctx, tx, invite.orgID); err != nil {
				return false, err
			}
			order, err := q.NextJoinOrder(ctx, invite.orgID)
			if err != nil {
				return false, err
			}
			if _, err := tx.Exec(ctx, `INSERT INTO organization_members (org_id,user_id,role,status,display_name,join_order,created_at,updated_at) VALUES ($1,$2,$3,'active',$4,$5,clock_timestamp(),clock_timestamp())`, invite.orgID, acc.id, invite.role, acc.name, order); err != nil {
				return false, err
			}
			if _, err := tx.Exec(ctx, `UPDATE org_invitations SET accepted_at=clock_timestamp(),accepted_user_id=$2,invitee_user_id=$2,updated_at=clock_timestamp() WHERE id=$1`, invite.id, acc.id); err != nil {
				return false, err
			}
			if err := q.SetActiveOrg(ctx, sqlc.SetActiveOrgParams{ID: acc.id, ActiveOrgID: pgtype.Int8{Int64: invite.orgID, Valid: true}}); err != nil {
				return false, err
			}
		} else {
			if _, err := tx.Exec(ctx, `UPDATE org_invitations SET declined_at=clock_timestamp(),invitee_user_id=$2,updated_at=clock_timestamp() WHERE id=$1`, invite.id, acc.id); err != nil {
				return false, err
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE notifications SET read_at=COALESCE(read_at,clock_timestamp()) WHERE invitation_id=$1 AND user_id=$2`, invite.id, acc.id); err != nil {
			return false, err
		}
		action := "workspace_invitation_declined"
		if accept {
			action = "workspace_invitation_accepted"
		}
		return true, invitationAudit(ctx, q, acc, invite.orgID, parsed.String(), r, action)
	})
	if err != nil {
		return invitationResult(err)
	}
	if accept {
		return invitationJSON(struct {
			OK    bool   `json:"ok"`
			OrgID int64  `json:"org_id"`
			Role  string `json:"role"`
		}{true, invite.orgID, invite.role})
	}
	return invitationJSON(struct {
		OK       bool `json:"ok"`
		Declined bool `json:"declined"`
	}{true, true})
}

func (s *Service) RevokeInvitation(r *http.Request, id string) Result {
	_, _, acc, res, ok := s.requireAccount(r)
	if !ok {
		return res
	}
	if acc.orgID <= 0 || IsSupplierAccount(acc.accountKind) {
		return invitationResult(errInvitationRole)
	}
	parsed, err := uuid.Parse(id)
	if err != nil || !strings.EqualFold(parsed.String(), id) {
		return invitationResult(errInvitationInvalid)
	}
	err = s.inTx(r.Context(), func(tx pgx.Tx, q *sqlc.Queries) (bool, error) {
		ctx := r.Context()
		if _, err := q.LockAccount(ctx, acc.id); err != nil {
			return false, err
		}
		actor, _, err := invitationActor(ctx, tx, acc, acc.orgID)
		if err != nil {
			return false, err
		}
		var invite invitationRow
		if err := tx.QueryRow(ctx, `SELECT id,role,accepted_at IS NOT NULL,declined_at IS NOT NULL,revoked_at IS NOT NULL FROM org_invitations WHERE uuid=$1::uuid AND org_id=$2 FOR UPDATE`, parsed.String(), acc.orgID).Scan(&invite.id, &invite.role, &invite.accepted, &invite.declined, &invite.revoked); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return false, errInvitationInvalid
			}
			return false, err
		}
		target, valid := access.ParseWorkspace(invite.role)
		if !valid || !actor.MayInvite(target) {
			return false, errInvitationRole
		}
		if invite.revoked {
			return true, nil
		}
		if invite.accepted || invite.declined {
			return false, errInvitationInvalid
		}
		if _, err := tx.Exec(ctx, `UPDATE org_invitations SET revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`, invite.id); err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, `UPDATE notifications SET dismissed_at=COALESCE(dismissed_at,clock_timestamp()) WHERE invitation_id=$1`, invite.id); err != nil {
			return false, err
		}
		return true, invitationAudit(ctx, q, acc, acc.orgID, parsed.String(), r, "workspace_invitation_revoked")
	})
	if err != nil {
		return invitationResult(err)
	}
	return invitationJSON(struct {
		OK      bool `json:"ok"`
		Revoked bool `json:"revoked"`
	}{true, true})
}

func invitationAudit(ctx context.Context, q *sqlc.Queries, acc account, orgID int64, id string, r *http.Request, action string) error {
	return q.InsertAudit(ctx, sqlc.InsertAuditParams{OrgID: orgID, UserID: acc.id, Module: "auth", EntityType: "workspace_invitation", EntityID: id, ApiMethod: r.Method, ApiPath: r.URL.Path, Action: action, Message: `{"summary":"更新工作空间邀请"}`})
}
