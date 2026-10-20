package integration

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
	agentrepo "github.com/xxww0098/podhub-go/internal/agent/repo"
	"github.com/xxww0098/podhub-go/internal/agent/service"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func TestAgentTenantAndLedger(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	seedMatchingLease(t, ctx, pool, "auth", "agent tenant")
	userA, orgA := insertWorkspace(t, ctx, pool, "agent-a-"+strconv.FormatInt(time.Now().UnixNano(), 10)+"@t.invalid", "A")
	userB, orgB := insertWorkspace(t, ctx, pool, "agent-b-"+strconv.FormatInt(time.Now().UnixNano(), 10)+"@t.invalid", "B")
	if orgA == orgB || userA == userB {
		t.Fatal("two orgs")
	}
	stamp := time.Now().UnixNano()
	codeA := inviteCode(stamp)
	codeB := inviteCode(stamp + 1)
	publicA := "w" + codeA
	if len(publicA) > 32 {
		publicA = publicA[:32]
	}
	for _, row := range []struct {
		user int64
		code string
	}{{userA, codeA}, {userB, codeB}} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO public.agents (user_id, invite_code, status, created_by_user_id, created_at, updated_at)
			VALUES ($1, $2, 'active', $1, clock_timestamp(), clock_timestamp())`, row.user, row.code); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO public.agent_commission_ledger (
			user_id, entry_type, idempotency_key, amount_cents, held_delta_cents,
			balance_before_cents, balance_after_cents, held_before_cents, held_after_cents
		) VALUES
			($1, 'commission', 'a', 100, 0, 0, 100, 0, 0),
			($2, 'commission', 'b', 250, 0, 0, 250, 0, 0)`, userA, userB); err != nil {
		t.Fatal(err)
	}

	repo := agentrepo.New(pool)
	svc := service.New(repo)

	t.Run("tables have no tenant rls", func(t *testing.T) {
		for _, name := range []string{
			"agents", "agent_commissions", "agent_commission_wallets",
			"agent_commission_ledger", "agent_withdrawals", "agent_rebate_policy",
		} {
			var rls, force bool
			err := pool.QueryRow(ctx, `
				SELECT c.relrowsecurity, c.relforcerowsecurity
				FROM pg_class c
				JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE n.nspname = 'public' AND c.relname = $1`, name).Scan(&rls, &force)
			if err != nil {
				t.Fatal(name, err)
			}
			if rls || force {
				t.Fatalf("%s has rls %v force %v; the schema does not", name, rls, force)
			}
		}
	})

	t.Run("app role still sees both rows", func(t *testing.T) {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if err := tenant.EnterApp(ctx, tx, orgA); err != nil {
			t.Fatal(err)
		}
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM public.agent_commission_ledger`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n < 2 {
			t.Fatalf("org A guc saw %d ledger rows", n)
		}
	})

	t.Run("missing guc does not hide agent rows", func(t *testing.T) {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `SELECT set_config('role', $1, true)`, tenant.RoleApp); err != nil {
			t.Fatal(err)
		}
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM public.agent_commission_ledger WHERE user_id = $1`, userA).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("missing guc saw %d", n)
		}
	})

	t.Run("service scopes by session user and allows org 0", func(t *testing.T) {
		rows, err := svc.Ledger(ctx, contract.Actor{UserID: userA, OrgID: orgA})
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) != 1 || rows[0].AmountCents != 100 || rows[0].EntryType != "commission" {
			t.Fatalf("A %+v", rows)
		}
		rows, err = svc.Ledger(ctx, contract.Actor{UserID: userB, OrgID: orgB})
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) != 1 || rows[0].AmountCents != 250 {
			t.Fatalf("B %+v", rows)
		}
		rows, err = svc.Ledger(ctx, contract.Actor{UserID: userA})
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) != 1 || rows[0].AmountCents != 100 {
			t.Fatalf("org 0 %+v", rows)
		}
		view, err := svc.Workbench(ctx, contract.Actor{UserID: userA})
		if err != nil {
			t.Fatal(err)
		}
		if view.Agent == nil || view.Agent.InviteCode != codeA || view.Agent.Status != "active" {
			t.Fatalf("%+v", view.Agent)
		}
		if view.Policy.DefaultRebateBps != 1000 || view.Policy.MinOrderCents != 10000 ||
			view.Policy.AttributionValidityDays != 365 || view.Policy.MinWithdrawCents != 10000 {
			t.Fatalf("policy %+v", view.Policy)
		}
		if view.Wallet.BalanceCents != 0 || view.AvailableCents != 0 || !view.TransferAvailable {
			t.Fatalf("wallet %+v available %d transfer %v", view.Wallet, view.AvailableCents, view.TransferAvailable)
		}
	})

	t.Run("payout update does not cross users", func(t *testing.T) {
		channel, account, name := "alipay", "a@pay", "甲乙"
		saved, cleared, err := svc.SavePayout(ctx, contract.Actor{UserID: userA, OrgID: orgA}, &channel, &account, &name)
		if err != nil || cleared || saved.Channel != "alipay" || saved.Account != "a@pay" || saved.RealName != "甲乙" {
			t.Fatalf("%+v cleared %v err %v", saved, cleared, err)
		}
		view, err := svc.Workbench(ctx, contract.Actor{UserID: userB, OrgID: orgB})
		if err != nil {
			t.Fatal(err)
		}
		if !view.Agent.Payout.Empty() {
			t.Fatalf("B payout changed %+v", view.Agent.Payout)
		}
		view, err = svc.Workbench(ctx, contract.Actor{UserID: userA, OrgID: orgA})
		if err != nil {
			t.Fatal(err)
		}
		if view.Agent.Payout.Channel != "alipay" || view.Agent.Payout.Account != "a@pay" {
			t.Fatalf("%+v", view.Agent.Payout)
		}
		if _, err := pool.Exec(ctx, `UPDATE public.agents SET payout_channel = 'alipay' WHERE user_id = $1`, userB); err == nil {
			t.Fatal("partial payout passed the check")
		}
	})

	t.Run("ledger trigger rejects rewrite", func(t *testing.T) {
		_, err := pool.Exec(ctx, `UPDATE public.agent_commission_ledger SET note = 'x' WHERE user_id = $1`, userA)
		if err == nil || !strings.Contains(err.Error(), "agent_commission_ledger rows are immutable") {
			t.Fatal(err)
		}
		_, err = pool.Exec(ctx, `DELETE FROM public.agent_commission_ledger WHERE user_id = $1`, userA)
		if err == nil || !strings.Contains(err.Error(), "agent_commission_ledger rows are immutable") {
			t.Fatal(err)
		}
	})

	t.Run("withdrawal check and one pending", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `
			INSERT INTO public.agent_withdrawals (public_id, user_id, amount_cents, channel, account, real_name, status)
			VALUES ($2, $1, 100, 'alipay', 'a', '甲', 'pending')`, userA, publicA); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO public.agent_withdrawals (public_id, user_id, amount_cents, channel, account, real_name, status)
			VALUES ($2, $1, 100, 'alipay', 'a', '甲', 'pending')`, userA, publicA+"x"); err == nil {
			t.Fatal("second pending")
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO public.agent_withdrawals (public_id, user_id, amount_cents, channel, account, real_name, status)
			VALUES ($2, $1, 100, 'alipay', 'a', '甲', 'paid')`, userB, "p"+publicA); err == nil {
			t.Fatal("paid without decider")
		}
		rows, err := svc.Withdrawals(ctx, contract.Actor{UserID: userA, OrgID: orgA})
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) != 1 || rows[0].Status != "pending" || rows[0].PublicID != publicA {
			t.Fatalf("%+v", rows)
		}
		rows, err = svc.Withdrawals(ctx, contract.Actor{UserID: userB, OrgID: orgB})
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) != 0 {
			t.Fatalf("B saw %+v", rows)
		}
	})

	t.Run("attribution is write-once", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `
			UPDATE public.account_users
			SET invited_by_agent_user_id = $2, agent_attribution_source = 'claim'
			WHERE id = $1`, userB, userA); err != nil {
			t.Fatal(err)
		}
		_, err := pool.Exec(ctx, `
			UPDATE public.account_users SET invited_by_agent_user_id = $2 WHERE id = $1`, userB, userB)
		if err == nil || !strings.Contains(err.Error(), "write-once") {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `
			UPDATE public.account_users SET invited_by_agent_user_id = id WHERE id = $1`, userA); err == nil {
			t.Fatal("self invite")
		}
	})

	t.Run("invalid claim does not add a ledger row", func(t *testing.T) {
		if _, err := svc.Claim(ctx, contract.Actor{UserID: userA, OrgID: orgA}, "nope"); failureMsg(err) != "邀请码无效" {
			t.Fatal(err)
		}
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM public.agent_commission_ledger WHERE user_id = $1`, userA).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("ledger rows %d", n)
		}
	})

	t.Run("ledger hides withdrawal holds", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `
			INSERT INTO public.agent_commission_ledger (
				user_id, entry_type, idempotency_key, amount_cents, held_delta_cents,
				balance_before_cents, balance_after_cents, held_before_cents, held_after_cents
			) VALUES ($1, 'withdrawal_hold', 'hold-a', 0, 10, 100, 100, 0, 10)`, userA); err != nil {
			t.Fatal(err)
		}
		rows, err := svc.Ledger(ctx, contract.Actor{UserID: userA})
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) != 1 || rows[0].EntryType != "commission" {
			t.Fatalf("%+v", rows)
		}
	})
}

func failureMsg(err error) string {
	f, ok := err.(*contract.Failure)
	if !ok {
		return ""
	}
	return f.Msg
}

func inviteCode(n int64) string {
	s := strings.ToUpper(strconv.FormatInt(n, 36))
	if len(s) < 4 {
		s = "CODE" + s
	}
	if len(s) > 32 {
		s = s[len(s)-32:]
	}
	return s
}
