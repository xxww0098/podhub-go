import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { SupplierAccountsScreen } from "@/features/supplier/admin-supplier-accounts-screen"
import type { Factory } from "@/bindings/http-factories"
import { Toaster } from "@/components/ui/toast"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const factory = { factoryId: "test-factory", name: "测试厂家", country: "CN", icon: "" }
const member = { memberId: "test-member", accountUuid: "test-account", factory, email: "factory@example.invalid", name: "成员", status: "active", createdAtMs: 1 }
const makeFactory = (factory_id: string, name: string): Factory => ({ factory_id, name, country: "CN", contact: "", internal_note: "", icon: "", created_at_ms: 1, updated_at_ms: 1, libraries: [] })
const accountFactory = (item: Factory) => ({ factoryId: item.factory_id, name: item.name, country: item.country, icon: item.icon })
let accountGroups = [{ factory, members: [member] }]
let factories = [makeFactory(factory.factoryId, factory.name), makeFactory("no-member", "无成员工厂")]
let failFactories = false
const createdMembers: Array<{ factoryId: string; email: string }> = []
const factoryUpdates: Array<Record<string, unknown>> = []
const markerKey = `supplier-account-password-reset-pending:${member.memberId}`
type Scenario = "validation" | "lost" | "bad-json" | "empty-error" | "server-error"
let scenario: Scenario = "validation"
const sentPasswords: string[] = []
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href)
  const method = init?.method ?? (input instanceof Request ? input.method : "GET")
  if (method === "GET" && url.pathname === "/api/admin/supplier-accounts") return Response.json({ data: { groups: accountGroups } })
  if (method === "GET" && url.pathname === "/api/admin/factories") return failFactories
    ? Response.json({ code: "internal", error: "工厂列表读取失败" }, { status: 500 })
    : Response.json({ data: { factories } })
  if (method === "POST" && url.pathname === "/api/admin/factories") {
    const body = JSON.parse(String(init?.body))
    if (typeof body.account_email !== "string" || !("internal_note" in body) || "accountEmail" in body || "internalNote" in body) throw new Error("factory create did not use snake_case")
    const created = makeFactory("new-factory", body.name)
    factories.push(created)
    const ref = accountFactory(created)
    accountGroups.push({ factory: ref, members: [{ ...member, memberId: "first-new-member", factory: ref, email: body.account_email }] })
    return Response.json({ data: { factory: created, initial_password: "first-password" } })
  }
  if (method === "PUT" && url.pathname.startsWith("/api/admin/factories/")) {
    const body = JSON.parse(String(init?.body))
    factoryUpdates.push(body)
    const id = decodeURIComponent(url.pathname.split("/").at(-1)!)
    factories = factories.map((factory) => factory.factory_id === id ? { ...factory, ...body } : factory)
    return Response.json({ data: { factory: factories.find((factory) => factory.factory_id === id) } })
  }
  if (method === "POST" && url.pathname === "/api/admin/supplier-accounts") {
    const body = JSON.parse(String(init?.body))
    createdMembers.push({ factoryId: body.factoryId, email: body.email })
    const selected = accountFactory(factories.find((item) => item.factory_id === body.factoryId)!)
    const created = { memberId: "new-member", accountUuid: "new-account", factory: selected, email: body.email, name: "", status: "active", createdAtMs: 1 }
    const group = accountGroups.find((item) => item.factory.factoryId === body.factoryId)
    if (group) group.members.push(created)
    else accountGroups.push({ factory: selected, members: [created] })
    return Response.json({ data: { member: created, initialPassword: "new-password" } })
  }
  if (method === "GET" && url.pathname === "/api/admin/supplier-withdrawals") return Response.json({ data: { withdrawals: [] } })
  if (method === "PATCH" && url.pathname === "/api/admin/supplier-accounts/test-member") {
    sentPasswords.push(JSON.parse(String(init?.body)).password)
    if (scenario === "validation") return sentPasswords.length === 1
      ? Response.json({ code: "validation", error: "密码过长" }, { status: 400 })
      : Response.json({ data: { member } })
    if (scenario === "lost") throw new TypeError("模拟服务器已提交后响应丢失")
    if (scenario === "bad-json") return new Response("{invalid", { status: 200 })
    if (scenario === "empty-error") return new Response("", { status: 400 })
    return Response.json({ code: "internal", error: "模拟内部错误" }, { status: 500 })
  }
  throw new Error(`Fixture blocked ${method} ${url.pathname}`)
}

if (new URLSearchParams(location.search).has("preview")) {
  createRoot(fixture).render(<Toaster><SupplierAccountsScreen overview={{
    session: { authenticated: true, email: "admin@example.invalid", role: "super_admin" },
    owned_count: 0, owned_limit: 3, workspaces: [],
  }} /></Toaster>)
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
async function waitFor(predicate: () => boolean, message: string) {
  for (let i = 0; i < 120; i++) { if (predicate()) return; await frame() }
  throw new Error(message)
}
function button(label: string): HTMLButtonElement {
  const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label && !item.closest('[hidden], [inert], [aria-hidden="true"]'))
  if (!node) throw new Error(`Missing button: ${label}`)
  return node
}
function setInput(value: string) {
  const input = document.querySelector<HTMLInputElement>("#supplier-reset-password")!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
  flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })))
}
async function openReset(label = "重置密码") {
  flushSync(() => button(label).click())
  await waitFor(() => Boolean(document.querySelector('[role="dialog"]')), "重置对话框未打开")
}
async function reconcile() {
  const unlock = button("解除限制")
  if (!unlock.disabled) throw new Error("未经核实即可解除重置限制")
  const checkbox = document.querySelector<HTMLElement>('[role="dialog"] [role="checkbox"]')
  if (!checkbox) throw new Error("缺少核实确认")
  flushSync(() => checkbox.click())
  if (button("解除限制").disabled) throw new Error("核实后仍无法解除限制")
  flushSync(() => button("解除限制").click())
  await waitFor(() => Boolean(document.querySelector("#supplier-reset-password")), "解除限制后未恢复编辑")
}

document.querySelector<HTMLButtonElement>("#run")!.addEventListener("click", async () => {
  localStorage.removeItem(markerKey)
  sentPasswords.length = 0
  scenario = "validation"
  let root = createRoot(fixture)
  const peer = document.createElement("iframe")
  peer.hidden = true
  document.body.append(peer)
  let releasePeerLock: (() => void) | undefined
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks")
  const originalSetItem = Object.getOwnPropertyDescriptor(Storage.prototype, "setItem")!
  const restoreLocks = () => originalLocks ? Object.defineProperty(navigator, "locks", originalLocks) : Reflect.deleteProperty(navigator, "locks")
  const restoreStorage = () => Object.defineProperty(Storage.prototype, "setItem", originalSetItem)
  try {
    const render = (role: "admin" | "super_admin") => flushSync(() => root.render(<Toaster><SupplierAccountsScreen overview={{
      session: { authenticated: true, email: "admin@example.invalid", role },
      owned_count: 0, owned_limit: 3, workspaces: [],
    }} /></Toaster>))
    render("admin")
    await waitFor(() => fixture.textContent?.includes("factory@example.invalid") === true, "厂家成员未加载")
    if (fixture.querySelector('[aria-label^="开通厂家成员 "], [aria-label^="解绑 "]') || fixture.textContent?.includes("重置密码")) throw new Error("普通管理员看到超级管理员操作")
    if (!fixture.querySelector('[role="switch"]')?.hasAttribute("data-disabled")) throw new Error("普通管理员可以修改工厂成员")

    render("super_admin")
    const createTrigger = fixture.querySelector<HTMLButtonElement>('[aria-label="开通厂家成员 测试厂家"]')!
    flushSync(() => { createTrigger.focus(); createTrigger.click() })
    await waitFor(() => Boolean(document.querySelector('[role="dialog"]')), "开通对话框未打开")
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await waitFor(() => document.activeElement === createTrigger, "关闭开通对话框后未回到入口")

    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined })
    await openReset()
    setInput("no-lock")
    flushSync(() => button("重置").click())
    await waitFor(() => document.body.textContent?.includes("当前浏览器不支持安全重置锁") === true, "缺少安全锁时没有提示")
    await waitFor(() => !button("取消").disabled, "安全锁检查未结束")
    if (Number(sentPasswords.length) !== 0) throw new Error("缺少安全锁时仍发送了重置")
    restoreLocks()
    flushSync(() => button("取消").click())
    await waitFor(() => !document.querySelector("#supplier-reset-password"), "安全锁测试对话框未关闭")

    Object.defineProperty(Storage.prototype, "setItem", { configurable: true, value(key: string, value: string) {
      if (key === markerKey) throw new DOMException("模拟存储不可用", "SecurityError")
      originalSetItem.value.call(this, key, value)
    } })
    await openReset()
    setInput("no-storage")
    flushSync(() => button("重置").click())
    await waitFor(() => document.body.textContent?.includes("无法保存重置核实标记") === true, "本地存储不可用时没有提示")
    await waitFor(() => !button("取消").disabled, "本地存储检查未结束")
    if (Number(sentPasswords.length) !== 0) throw new Error("本地存储不可用时仍发送了重置")
    restoreStorage()
    flushSync(() => button("取消").click())
    await waitFor(() => !document.querySelector("#supplier-reset-password"), "本地存储测试对话框未关闭")

    peer.contentWindow!.localStorage.setItem(markerKey, "1")
    await waitFor(() => fixture.textContent?.includes("查看重置结果") === true, "其他标签页的待核实标记未同步")
    await openReset("查看重置结果")
    if (!document.body.textContent?.includes("本页面没有上次提交的密码") || sentPasswords.length !== 0) throw new Error("其他标签页的重置未受限制")
    flushSync(() => button("关闭").click())
    await waitFor(() => !document.body.textContent?.includes("重置结果待核实"), "跨标签提示未关闭")
    peer.contentWindow!.localStorage.removeItem(markerKey)
    await waitFor(() => fixture.textContent?.includes("重置密码") === true, "其他标签页清除标记未同步")

    let lockHeld!: () => void
    const acquired = new Promise<void>((resolve) => { lockHeld = resolve })
    const peerLock = peer.contentWindow!.navigator.locks.request(markerKey, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error("无法建立并发测试锁")
      await new Promise<void>((resolve) => { releasePeerLock = resolve; lockHeld() })
    })
    await acquired
    await openReset()
    setInput("not-submitted-concurrently")
    flushSync(() => button("重置").click())
    await waitFor(() => !button("重置").disabled, "并发请求没有结束")
    if (Number(sentPasswords.length) !== 0) throw new Error("其他标签页持锁时仍提交了重置")
    releasePeerLock!()
    await peerLock
    releasePeerLock = undefined
    flushSync(() => button("取消").click())
    await waitFor(() => !document.querySelector("#supplier-reset-password"), "并发测试对话框未关闭")

    // A marker may arrive between opening the dialog and receiving a storage event.
    localStorage.setItem(markerKey, "1")
    await openReset()
    setInput("not-submitted")
    flushSync(() => button("重置").click())
    await waitFor(() => document.body.textContent?.includes("本页面没有上次提交的密码") === true, "提交前没有检查其他标签页的标记")
    if (sentPasswords.length !== 0) throw new Error("已有待核实标记时仍发送了重置请求")
    await reconcile()
    flushSync(() => button("取消").click())
    await waitFor(() => !document.querySelector("#supplier-reset-password"), "核实后对话框未关闭")

    await openReset()
    setInput("fixture-passphrase")
    flushSync(() => button("重置").click())
    await waitFor(() => sentPasswords.length === 1 && !button("重置").disabled, "明确拒绝后重置没有结束")
    if (document.querySelector<HTMLInputElement>("#supplier-reset-password")?.value !== "fixture-passphrase") throw new Error("明确拒绝后输入丢失")
    flushSync(() => button("重置").click())
    await waitFor(() => document.body.textContent?.includes("一次性初始密码") === true, "成功后未显示一次性密码")
    if (Number(sentPasswords.length) !== 2 || sentPasswords.some((value) => value !== "fixture-passphrase")) throw new Error("拒绝后重试没有保留输入")
    flushSync(() => button("我已保存").click())
    await waitFor(() => !document.querySelector("#supplier-reset-password"), "成功后重置对话框未关闭")

    scenario = "lost"
    await openReset()
    flushSync(() => button("重置").click())
    await waitFor(() => document.body.textContent?.includes("本次重置结果未确认") === true, "响应丢失后未显示未知结果")
    const generated = sentPasswords.at(-1)!
    if (!generated.startsWith("dzp-") || document.querySelector<HTMLInputElement>("#supplier-reset-password")?.value !== generated) throw new Error("自动生成的密码未保留")
    if (button("解除限制").disabled !== true || document.querySelector<HTMLInputElement>("#supplier-reset-password")?.readOnly !== true) throw new Error("未知结果仍可直接重置")
    if (localStorage.getItem(markerKey) !== "1" || JSON.stringify(localStorage).includes(generated)) throw new Error("待核实标记不正确或泄露了密码")
    flushSync(() => button("关闭").click())
    await waitFor(() => !document.querySelector("#supplier-reset-password"), "待核实对话框未关闭")
    await openReset("查看重置结果")
    if (document.querySelector<HTMLInputElement>("#supplier-reset-password")?.value !== generated || Number(sentPasswords.length) !== 3) throw new Error("重新打开后密码丢失或发生重复提交")

    flushSync(() => root.unmount())
    root = createRoot(fixture)
    render("super_admin")
    await waitFor(() => fixture.textContent?.includes("查看重置结果") === true, "重新加载后未保留待核实标记")
    await openReset("查看重置结果")
    if (!document.body.textContent?.includes("本页面没有上次提交的密码") || document.querySelector("#supplier-reset-password")) throw new Error("重新加载后的恢复提示错误")
    await reconcile()
    if (Number(sentPasswords.length) !== 3) throw new Error("解除限制时意外提交")
    flushSync(() => button("取消").click())
    await waitFor(() => !document.querySelector("#supplier-reset-password"), "重置对话框未关闭")

    for (const next of ["bad-json", "empty-error", "server-error"] as const) {
      scenario = next
      await openReset()
      setInput(`fixture-${next}`)
      const previousCount: number = sentPasswords.length
      flushSync(() => button("重置").click())
      await waitFor(() => document.body.textContent?.includes("本次重置结果未确认") === true, `${next} 未显示未知结果`)
      if (sentPasswords.length !== previousCount + 1 || document.querySelector<HTMLInputElement>("#supplier-reset-password")?.value !== `fixture-${next}`) throw new Error(`${next} 未保留提交密码`)
      await reconcile()
      if (sentPasswords.length !== previousCount + 1) throw new Error(`${next} 自动重复提交`)
      flushSync(() => button("取消").click())
      await waitFor(() => !document.querySelector("#supplier-reset-password"), `${next} 对话框未关闭`)
    }
    if (!fixture.textContent?.includes("无成员工厂") || !fixture.textContent?.includes("尚未开通工厂成员")) throw new Error("没有成员的工厂未显示")
    flushSync(() => button("新增工厂").click())
    await waitFor(() => Boolean(document.querySelector("#factory-name")), "新增工厂对话框未打开")
    const factoryName = document.querySelector<HTMLInputElement>("#factory-name")!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(factoryName, "新工厂")
    flushSync(() => factoryName.dispatchEvent(new Event("input", { bubbles: true })))
    const firstEmail = document.querySelector<HTMLInputElement>("#factory-email")!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(firstEmail, "first@example.invalid")
    flushSync(() => firstEmail.dispatchEvent(new Event("input", { bubbles: true })))
    flushSync(() => button("创建工厂").click())
    await waitFor(() => fixture.textContent?.includes("新工厂") === true && !document.querySelector("#factory-name"), "工厂未创建并回读")
    await waitFor(() => ![...document.querySelectorAll('[role="dialog"]')].some((dialog) => /填写工厂资料和初始登录账号|编辑工厂资料/.test(dialog.textContent ?? "")), "工厂设置对话框未关闭")
    await waitFor(() => document.body.textContent?.includes("一次性初始密码") === true, "首个成员密码未显示")
    flushSync(() => button("我已保存").click())
    await waitFor(() => !document.body.textContent?.includes("一次性初始密码"), "首个密码对话框未关闭")
    const addMember = fixture.querySelector<HTMLButtonElement>('[aria-label="开通厂家成员 新工厂"]')!
    await waitFor(() => !addMember.disabled, "工厂回读未完成")
    flushSync(() => addMember.click())
    await waitFor(() => Boolean(document.querySelector("#supplier-member-email")), "开通成员对话框未打开")
    if (document.querySelector("#supplier-member-source") || !document.body.textContent?.includes("新工厂")) throw new Error("开通成员没有绑定当前工厂")
    const memberEmail = document.querySelector<HTMLInputElement>("#supplier-member-email")!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(memberEmail, "new@example.invalid")
    flushSync(() => memberEmail.dispatchEvent(new Event("input", { bubbles: true })))
    flushSync(() => button("开通").click())
    await waitFor(() => document.body.textContent?.includes("一次性初始密码") === true, "新成员的一次性密码未显示")
    if (createdMembers.at(-1)?.factoryId !== "new-factory") throw new Error("成员开通到错误工厂")
    flushSync(() => button("我已保存").click())
    await waitFor(() => fixture.textContent?.includes("new@example.invalid") === true, "新成员未回读")
    const configure = fixture.querySelector<HTMLButtonElement>('[aria-label="配置工厂 新工厂"]')!
    await waitFor(() => !configure.disabled, "成员回读未完成")
    flushSync(() => configure.click())
    await waitFor(() => Boolean(document.querySelector("#factory-name")), "工厂配置未打开")
    if (document.querySelector("#factory-email")) throw new Error("编辑资料仍可换绑并移除其他成员")
    flushSync(() => button("保存").click())
    await waitFor(() => factoryUpdates.length > 0 && !document.querySelector("#factory-name"), "工厂资料未保存")
    if ("account_email" in factoryUpdates.at(-1)!) throw new Error("保存工厂资料提交了成员换绑")
    await waitFor(() => Boolean(fixture.querySelector('[aria-label="刷新工厂管理"]')), "工厂资料回读未完成")

    failFactories = true
    flushSync(() => fixture.querySelector<HTMLButtonElement>('[aria-label="刷新工厂管理"]')!.click())
    await waitFor(() => fixture.textContent?.includes("工厂管理刷新失败") === true, "工厂列表失败被当成空列表")
    if (!fixture.querySelector<HTMLButtonElement>('[aria-label="新增工厂"]')?.disabled) throw new Error("读取失败后仍可创建工厂")
    failFactories = false
    flushSync(() => fixture.querySelector<HTMLButtonElement>('[aria-label="刷新工厂管理"]')!.click())
    await waitFor(() => !fixture.textContent?.includes("工厂管理刷新失败"), "工厂列表重试未恢复")

    const secondMember = { ...member, memberId: "second-member", email: "second@example.invalid" }
    accountGroups = [
      { factory, members: [member, secondMember] },
      ...[2, 3, 4].map((number) => {
        const nextFactory = { ...factory, factoryId: `factory-${number}`, name: `厂家${number}` }
        return { factory: nextFactory, members: [{ ...member, factory: nextFactory, memberId: `member-${number}`, email: `member${number}@example.invalid` }] }
      }),
    ]
    factories = accountGroups.map((group) => makeFactory(group.factory.factoryId, group.factory.name))
    const refresh = fixture.querySelector<HTMLButtonElement>('[aria-label="刷新工厂管理"]')!
    flushSync(() => refresh.click())
    await waitFor(() => fixture.textContent?.includes("厂家3") === true, "多厂家列表未刷新")
    if (fixture.textContent?.includes("厂家4")) throw new Error("第一页显示了下一页厂家")
    const groupSelect = fixture.querySelector<HTMLElement>('[aria-label="选择测试厂家全部成员"]')!
    flushSync(() => groupSelect.click())
    if (!fixture.textContent?.includes("复制邮箱（2）")) throw new Error("分组全选未选择全部成员")
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")
    let copied = ""
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied = text } } })
    try {
      flushSync(() => button("复制邮箱（2）").click())
      await waitFor(() => copied.length > 0, "未复制所选邮箱")
      if (copied !== "factory@example.invalid\nsecond@example.invalid") throw new Error("复制的邮箱不匹配所选成员")
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard)
      else Reflect.deleteProperty(navigator, "clipboard")
    }
    flushSync(() => fixture.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!.click())
    if (!fixture.textContent?.includes("厂家4") || fixture.textContent?.includes("复制邮箱（2）")) throw new Error("换页未展示下页或清除选择")
    const search = fixture.querySelector<HTMLInputElement>('[aria-label="搜索工厂或成员"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "测试厂家")
    flushSync(() => search.dispatchEvent(new Event("input", { bubbles: true })))
    if (!fixture.textContent?.includes("测试厂家") || fixture.textContent?.includes("厂家4")) throw new Error("搜索未重置分页")
    results.textContent = "PASS：工厂创建、定向开通成员、失败回读；密码重置保护、分组选择、分页与搜索"
  } catch (error) {
    results.textContent = `FAIL：${error instanceof Error ? error.message : String(error)}`
  } finally {
    releasePeerLock?.()
    restoreLocks()
    restoreStorage()
    flushSync(() => root.unmount())
    peer.remove()
    localStorage.removeItem(markerKey)
    accountGroups = [{ factory, members: [member] }]
    factories = [makeFactory(factory.factoryId, factory.name), makeFactory("no-member", "无成员工厂")]
    failFactories = false
    createdMembers.length = 0
    factoryUpdates.length = 0
  }
})
