import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { accountHttp } from "./http-account"
import { createWorkspaceInvitation } from "./http-workspace-invitations"

test("invitation writes read their raw DTOs without reporting committed writes as failed", async (t) => {
  const previous = globalThis.fetch
  const calls: { path: string; method?: string; body: unknown }[] = []
  const invitation = {
    uuid: "550e8400-e29b-41d4-a716-446655440000",
    email: "recipient@example.invalid", role: "member", expires_at_ms: 1_900_000_000_000,
    pending_used: 1, pending_limit: 10,
  }
  globalThis.fetch = async (input, init) => {
    const path = String(input)
    calls.push({ path, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify(path.endsWith("/accept") ? { ok: true, org_id: 19, role: "member" }
      : path.endsWith("/decline") ? { ok: true, declined: true }
      : init?.method === "DELETE" ? { ok: true, revoked: true } : invitation), {
      status: 200, headers: { "Content-Type": "application/json" },
    })
  }
  t.after(() => { globalThis.fetch = previous })

  assert.deepEqual(await createWorkspaceInvitation(invitation.email, invitation.role), invitation)
  await accountHttp.accountAcceptWorkspaceInvitation(invitation.uuid)
  await accountHttp.accountDeclineWorkspaceInvitation(invitation.uuid)
  await accountHttp.accountRevokeWorkspaceInvitation(invitation.uuid)
  assert.deepEqual(calls, [
    { path: route("invitations"), method: "POST", body: { email: invitation.email, role: "member" } },
    { path: route("invitationsByUuidAccept", { uuid: invitation.uuid }), method: "POST", body: undefined },
    { path: route("invitationsByUuidDecline", { uuid: invitation.uuid }), method: "POST", body: undefined },
    { path: route("invitationsByUuid", { uuid: invitation.uuid }), method: "DELETE", body: undefined },
  ])
})
