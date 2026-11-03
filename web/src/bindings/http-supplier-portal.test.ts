import assert from "node:assert/strict"
import test from "node:test"
import { createSupplierAccount, deleteSupplierAccount, listSupplierAccounts, patchSupplierAccount } from "./http-supplier-portal"

test("manufacturer account responses expose member identity, timestamps and the one-time password", async () => {
  const previous = globalThis.fetch
  const factory = { factoryId: "source", name: "Factory", country: "CN", icon: "" }
  const member = { memberId: "member", accountUuid: "account", factory, email: "factory@example.invalid", status: "active", createdAtMs: 123 }
  globalThis.fetch = (async (_, init) => Response.json({ data: init?.method === "DELETE"
    ? { memberId: "member", unbound: true }
    : init?.method === "POST" || init?.method === "PATCH"
      ? { member, initialPassword: "one-time-test-password" }
      : { groups: [{ factory, members: [member] }] },
  })) as typeof fetch
  try {
    const row = (await listSupplierAccounts()).groups[0]!.members[0]!
    assert.equal(row.member_id, "member")
    assert.equal(row.account_uuid, "account")
    assert.equal(row.factory.factory_id, "source")
    assert.equal(row.created_at_ms, 123)
    for (const mutation of [await createSupplierAccount({ factoryId: "source", email: member.email }), await patchSupplierAccount("member", { status: "active" })]) {
      assert.equal(mutation.member.member_id, "member")
      assert.equal(mutation.initial_password, "one-time-test-password")
    }
    assert.deepEqual(await deleteSupplierAccount("member"), { member_id: "member", unbound: true })
  } finally {
    globalThis.fetch = previous
  }
})
