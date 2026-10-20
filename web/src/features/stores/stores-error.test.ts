import assert from "node:assert/strict"
import test from "node:test"
import { cloudRefusal } from "@/api/client"
import { shouldOpenAccount } from "./stores-error"

test("HTTP 401 opens Account after the Cloud boundary maps the auth code", () => {
  const reason = cloudRefusal(Response.json({}, { status: 401 }), {
    code: "AUTH_INVALID", error: "登录已失效",
  }, "POST")
  assert.equal(shouldOpenAccount(reason), true)
})
