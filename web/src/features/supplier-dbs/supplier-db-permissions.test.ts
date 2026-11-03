import assert from "node:assert/strict"
import test from "node:test"
import { accountOptionLabel } from "./supplier-db-permissions"

test("商品负责人选项不会把名称和邮箱重复显示", () => {
  assert.equal(accountOptionLabel({ name: "商品负责人", email: "manager@example.com" }), "商品负责人 · manager@example.com")
  assert.equal(accountOptionLabel({ name: "manager@example.com", email: "manager@example.com" }), "manager@example.com")
  assert.equal(accountOptionLabel({ name: "MANAGER@EXAMPLE.COM", email: "manager@example.com" }), "manager@example.com")
  assert.equal(accountOptionLabel({ name: "  ", email: " user@example.com " }), "user@example.com")
  assert.equal(accountOptionLabel({ name: null, email: "user@example.com" }), "user@example.com")
})
