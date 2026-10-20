import assert from "node:assert/strict"
import test from "node:test"

import type {
  AdminDirectoryPersonView,
  AdminDirectoryWorkspaceView,
} from "@/bindings/commands"
import {
  filterDirectoryMembers,
  flattenDirectoryMembers,
} from "./directory-members"

function person(
  patch: Partial<AdminDirectoryPersonView> & Pick<AdminDirectoryPersonView, "name" | "email" | "uuid">,
): AdminDirectoryPersonView {
  return {
    kind: "user",
    role_label: "成员",
    role: "user",
    is_admin: false,
    created_at: "2026-01-01",
    status: "active",
    disabled: false,
    manageable: true,
    editable: true,
    ...patch,
  }
}

function workspace(
  patch: Partial<AdminDirectoryWorkspaceView> &
    Pick<AdminDirectoryWorkspaceView, "name" | "uuid" | "members">,
): AdminDirectoryWorkspaceView {
  return {
    id: 1,
    plan: "pro",
    seat_limit: 3,
    seats_used: patch.members.length,
    ai_tokens_used: 0,
    ai_tokens_monthly: 0,
    wallet_available_microfen: 1_000,
    wallet_held_microfen: 0,
    created_at: "2026-01-01",
    owner_uuid: "owner",
    ...patch,
  }
}

const alice = person({ name: "Alice", email: "alice@pod.test", uuid: "u-alice" })
const bob = person({
  name: "Bob",
  email: "bob@pod.test",
  uuid: "u-bob",
  status: "disabled",
  disabled: true,
})
const cara = person({ name: "Cara", email: "cara@pod.test", uuid: "u-cara" })

test("flattenDirectoryMembers emits one member row per seat, including unaffiliated", () => {
  const rows = flattenDirectoryMembers({
    workspaces: [
      workspace({
        id: 1,
        name: "北区",
        uuid: "t-north",
        members: [alice, bob],
      }),
    ],
    unaffiliated: [cara],
  })
  assert.equal(rows.length, 3)
  assert.equal(rows[0]?.workspace?.name, "北区")
  assert.equal(rows[2]?.workspace, null)
  assert.equal(rows[2]?.person.name, "Cara")
})

test("账号 search still filters by name, email, and workspace", () => {
  const rows = flattenDirectoryMembers({
    workspaces: [
      workspace({
        id: 1,
        name: "北区工坊",
        uuid: "t-north",
        members: [alice, bob],
      }),
    ],
    unaffiliated: [cara],
  })

  const byName = filterDirectoryMembers(rows, "alice", "all")
  assert.equal(byName.length, 1)
  assert.equal(byName[0]?.person.email, "alice@pod.test")

  const byEmail = filterDirectoryMembers(rows, "bob@pod", "all")
  assert.equal(byEmail.length, 1)
  assert.equal(byEmail[0]?.person.name, "Bob")

  const byWorkspace = filterDirectoryMembers(rows, "工坊", "all")
  assert.equal(byWorkspace.length, 2)

  const disabled = filterDirectoryMembers(rows, "", "disabled")
  assert.equal(disabled.length, 1)
  assert.equal(disabled[0]?.person.uuid, "u-bob")

  const unaffiliated = filterDirectoryMembers(rows, "", "unaffiliated")
  assert.equal(unaffiliated.length, 1)
  assert.equal(unaffiliated[0]?.person.uuid, "u-cara")
})
