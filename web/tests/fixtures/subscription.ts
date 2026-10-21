import type { AccountOverview } from "../../src/bindings/commands"
import type { SubscriptionView } from "../../src/bindings/http-subscription"

export const subscriptionOverview: AccountOverview = {
  session: { authenticated: true, email: "test@example.invalid", role: "owner", name: "Test" },
  active_workspace: { id: 1, uuid: "550e8400-e29b-41d4-a716-446655440000", name: "测试 Workspace", plan: "lite", role: "owner", is_owned: true },
  workspaces: [], account_mode: "owner", owned_count: 1, owned_limit: 3,
}
export const subscriptionFixture: SubscriptionView = {
  revision: 1, plan_key: "lite", status: "active", extra_stores: 3, extra_members: 0,
  term_start: "2026-10-21T02:00:00Z", current_end: "2026-11-21T02:00:00Z", term_end: "2026-12-21T02:00:00Z",
  stores: { used: 7, limit: 8 }, members: { used: 1, limit: 1 },
  next: { plan_key: "lite", stores: 6, members: 1, extra_stores: 1, extra_members: 0, keep_member_ids: null, keep_store_ids: ["s1", "s2", "s3", "s4", "s5", "s6"], effective_at: "2026-12-21T02:00:00Z" },
  next_renewal: { months: 1, amount_cents: 12000 },
  periods: [{ id: 2, plan_key: "lite", stores: 6, members: 1, extra_stores: 1, extra_members: 0, starts_at: "2026-11-21T02:00:00Z", ends_at: "2026-12-21T02:00:00Z", keep_member_ids: null, keep_store_ids: ["s1", "s2", "s3", "s4", "s5", "s6"] }],
  member_choices: [{ id: 1, name: "Owner", owner: true }],
  store_choices: Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, name: `店铺 ${String.fromCharCode(65 + i)}`, manual_disabled: false, allowed: true })),
  plans: [{ key: "free", monthly_cents: 0, stores: 1, members: 1 }, { key: "lite", monthly_cents: 10000, stores: 5, members: 1 }, { key: "pro", monthly_cents: 60000, stores: 30, members: 6 }, { key: "max", monthly_cents: 100000, stores: 50, members: 11 }],
  store_monthly_cents: 2000, member_monthly_cents: 3000, draining: false, pending_order: false,
  purchase_agreement: { version: "test-v1", title: "订阅购买确认", effective_at: "2026-10-21", content: "已付权益继续用满，提前续费不改变原定容量切换日期。" },
}
