import assert from "node:assert/strict"
import test from "node:test"

import { factoryLoginMissing, handleFactorySignInError } from "./factory-login-screen"

test("工厂登录区分缺少的邮箱和密码", () => {
  assert.deepEqual(factoryLoginMissing(" ", ""), {
    emailMissing: true,
    passwordMissing: true,
    message: "请输入邮箱与密码",
  })
  assert.equal(factoryLoginMissing("factory@example.com", "").message, "请输入密码")
  assert.equal(factoryLoginMissing("factory@example.com", "secret").message, undefined)
})

test("初始密码已登录时进入修改密码，而不报登录失败", () => {
  let handedOver = false
  const notices: string[] = []
  handleFactorySignInError(
    { code: "cloud_password_change_required" },
    () => { handedOver = true },
    (_, fallback) => notices.push(fallback),
  )
  assert.equal(handedOver, true)
  assert.deepEqual(notices, [])
})

test("普通登录错误和缺少修改密码入口时提示对应原因", () => {
  const notices: string[] = []
  const notify = (_: unknown, fallback: string) => notices.push(fallback)
  handleFactorySignInError(new Error("offline"), undefined, notify)
  handleFactorySignInError({ code: "cloud_password_change_required" }, undefined, notify)
  assert.deepEqual(notices, ["登录失败。请检查邮箱和密码。", "请先修改初始密码。"])
})
