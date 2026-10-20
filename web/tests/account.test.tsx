import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { AccountProfileSection, DeviceStorageCard } from "../src/features/account/account-screen"
import { accountNameProblem, RENAME_COOLDOWN_MS, renameCooldownLabel, renameLockedUntil } from "../src/features/account/name-rules"
import { overview, ownerWorkspace } from "./account-fixtures"

test("account settings renders session strip without secret values", () => {
  const html = renderToStaticMarkup(<AccountProfileSection overview={overview} />)
  // The sheet refreshes standing on open; the card carries no second 刷新.
  assert.doesNotMatch(html, /刷新/)
  // The avatar upload routes left the contract; the strip shows the session
  // identity only, with no upload entry.
  assert.doesNotMatch(html, /更换头像/)
  assert.match(html, /seller@example\.invalid/)
  // Default PlatformRole `user` is not an identity. Staff ranks chip without a
  // 角色 prefix; wire values never print.
  assert.doesNotMatch(html, /角色 用户/)
  assert.doesNotMatch(html, /角色 user/)
  assert.doesNotMatch(html, /超级管理员|平台管理员/)
  assert.doesNotMatch(html, /套餐 pro/)
  assert.doesNotMatch(html, /退出登录/)
  assert.doesNotMatch(html, /AI 账号|S3 账号|提示词|新增 AI|新增 S3/)
  for (const forbidden of ["canary-session", "seller-secret", "ai-secret", "Bearer"]) {
    assert.doesNotMatch(html, new RegExp(forbidden))
  }
})

test("account profile offers rename until the 24-hour stamp locks it", () => {
  const html = renderToStaticMarkup(<AccountProfileSection overview={overview} />)
  assert.match(html, /修改名字/)

  const locked = renderToStaticMarkup(
    <AccountProfileSection
      overview={{
        ...overview,
        session: { ...overview.session, name_changed_at_ms: Date.now() },
      }}
    />,
  )
  assert.doesNotMatch(locked, /修改名字/)
  assert.match(locked, /后可改名/)
})

test("name rules refuse empties, overshoot and a no-op", () => {
  assert.equal(accountNameProblem("   ", "Seller"), "请输入名字")
  assert.equal(accountNameProblem("Seller", "Seller"), "新名字与当前相同")
  assert.equal(
    accountNameProblem("名".repeat(25), "Seller"),
    "名字最长 24 个字符",
  )
  assert.equal(accountNameProblem("  新名字  ", "Seller"), undefined)
  assert.equal(renameLockedUntil(undefined), undefined)
  assert.equal(renameLockedUntil(1_000), 1_000 + RENAME_COOLDOWN_MS)
  assert.equal(renameCooldownLabel(90_000, 0), "约 2 分钟后可改名")
  assert.equal(
    renameCooldownLabel(RENAME_COOLDOWN_MS - 1, 0),
    "约 24 小时后可改名",
  )
})

test("account settings exposes clear only when an avatar exists", () => {
  assert.doesNotMatch(
    renderToStaticMarkup(<AccountProfileSection overview={overview} />),
    /清空头像/,
  )
  const html = renderToStaticMarkup(
    <AccountProfileSection
      overview={{
        ...overview,
        session: { ...overview.session, avatar_url: "/api/avatars/me?v=1" },
      }}
    />,
  )
  assert.match(html, /清空头像/)
})

test("Workspace owner with PlatformRole user never sees platform settings", () => {
  const html = renderToStaticMarkup(
    <AccountProfileSection overview={overview} />,
  )
  assert.doesNotMatch(html, /AI 账号|S3 账号|提示词|正在读取集成账号/)
})

test("PlatformRole admin still sees only personal controls on Settings", () => {
  const html = renderToStaticMarkup(
    <AccountProfileSection
      overview={{
        ...overview,
        session: { ...overview.session, role: "admin" },
        active_workspace: { ...ownerWorkspace, role: "member" },
      }}
    />,
  )
  assert.doesNotMatch(html, /AI 账号|S3 账号|提示词|正在读取集成账号/)
})

test("account settings chips staff rank without a 角色 prefix", () => {
  const html = renderToStaticMarkup(
    <AccountProfileSection
      overview={{
        ...overview,
        session: {
          ...overview.session,
          name: "李华",
          email: "li@pod.com",
          role: "super_admin",
        },
      }}
    />,
  )
  assert.match(html, /李华/)
  assert.match(html, /li@pod\.com/)
  assert.match(html, /超级管理员/)
  assert.doesNotMatch(html, /角色 超级管理员/)
  assert.doesNotMatch(html, /角色 user/)
})

// The 额度 badge reads the wallet itself and renders nothing until that read
// lands, so its markup is asserted in tests/header-wallet-balance.test.tsx. What
// belongs here is the sidebar footer around it: quota facts stay off the
// operator rail, and collapse stays last.
test("overview refresh publishes upward without signing out", () => {
  const accountSource = readFileSync(
    new URL("../src/features/account/account-screen.tsx", import.meta.url),
    "utf8",
  )
  const appSource = readFileSync(
    new URL("../src/app/App.tsx", import.meta.url),
    "utf8",
  )

  assert.match(accountSource, /onOverviewChange\?\.\(next\)/)
  assert.match(appSource, /onOverviewChange=\{overviewChanged\}/)
  assert.match(appSource, /setAuth\(publishAuthOverview\(overview\)\)/)
  assert.match(appSource, /rememberAccountOverview/)
})

test("本机存储 reports the measured footprint and warns when the origin is evictable", () => {
  const reported = renderToStaticMarkup(
    <DeviceStorageCard
      storage={{ usedBytes: 734003200, quotaBytes: 10737418240, persisted: true }}
    />,
  )
  // The pane header names 本机存储; the card leads with the measured total.
  assert.match(reported, /已用 700 MB/)
  assert.match(reported, /配额 10 GB/)
  assert.match(reported, /已持久化/)

  const evictable = renderToStaticMarkup(
    <DeviceStorageCard
      storage={{ usedBytes: 1024, quotaBytes: 2048, persisted: false }}
    />,
  )
  assert.match(evictable, /磁盘紧张时可能被清理/)

  // The escape hatch for a quota under the cache ceiling, and for a use log a
  // cleared localStorage left behind bytes it can no longer see.
  const clearable = renderToStaticMarkup(
    <DeviceStorageCard
      storage={{ usedBytes: 1024, quotaBytes: 2048, persisted: true }}
      onClear={() => {}}
    />,
  )
  assert.match(clearable, /清理本机缓存/)
  assert.equal(reported.includes("清理本机缓存"), false)
})

test("本机存储 dashboard breaks usage down per cache family with a quota bar", () => {
  const html = renderToStaticMarkup(
    <DeviceStorageCard
      storage={{ usedBytes: 734003200, quotaBytes: 10737418240, persisted: true }}
      families={[
        { family: "templates", entries: 1, bytes: 268435456 },
        { family: "sources", entries: 3, bytes: 1048576 },
        { family: "renders", entries: 2, bytes: 4194304 },
        { family: "static-slices", entries: 0, bytes: 0 },
      ]}
      onClearFamily={() => {}}
      onClear={() => {}}
    />,
  )
  for (const label of ["PSD 模板", "源图", "切片产物", "静态切片缓存"]) {
    assert.match(html, new RegExp(label))
  }
  assert.match(html, /256 MB/, "a family row reports its measured bytes")
  assert.match(html, /3 项/, "a family row reports its entry count")
  assert.match(html, /其他浏览器数据/, "origin usage outside the render cache is still reported")
  assert.match(html, /role="img"[^>]*本机存储用量/, "the segmented bar names what it measures")
  // No pinned-sources provider is wired in this render, so the 源图 row must
  // not claim a pinned count it never asked for (browser-owned-listing 10).
  assert.doesNotMatch(html, /已钉住/)
})

test("本机存储 shows how many source images are pinned, distinct from the family's gross total", () => {
  const props = {
    storage: { usedBytes: 734003200, quotaBytes: 10737418240, persisted: true },
    families: [
      { family: "templates", entries: 1, bytes: 268435456 },
      { family: "sources", entries: 3, bytes: 1048576 },
      { family: "renders", entries: 2, bytes: 4194304 },
      { family: "static-slices", entries: 0, bytes: 0 },
    ],
  }

  const zero = renderToStaticMarkup(<DeviceStorageCard {...props} pinned={{ count: 0, bytes: 0 }} />)
  assert.match(zero, /已钉住 0 张/, "0 pinned is the honest state before a row store is wired (slice 17)")

  const some = renderToStaticMarkup(<DeviceStorageCard {...props} pinned={{ count: 3, bytes: 131072 }} />)
  assert.match(some, /已钉住 3 张/)
  assert.match(some, /128 KB/)
  assert.doesNotMatch(some, /已钉住 3 张.*已钉住/s, "the pinned line appears once, under 源图 only")
})

test("account-screen's clear-cache copy tells the operator pinned sources survive", () => {
  const source = readFileSync(
    new URL("../src/features/account/account-screen.tsx", import.meta.url),
    "utf8",
  )
  // Both the whole-cache and the per-family escape hatch route through
  // opfs.ts's pinning now (browser-owned-listing slice 10), so both dialogs
  // must say so rather than implying every source is dropped.
  const wholeClear = source.match(/title: "清理本机缓存"[\s\S]{0,400}/)?.[0] ?? ""
  assert.match(wholeClear, /在制品的源图不会被清理，删除方案里的行才会释放它们/)
  assert.match(source, /sourceCaveat/, "the per-family dialog reuses the same pinned-source caveat")
})

test("an engine that cannot report storage says so instead of painting a zero", () => {
  const html = renderToStaticMarkup(<DeviceStorageCard storage={null} />)
  assert.match(html, /当前浏览器不提供存储用量/)
  assert.equal(html.includes("已持久化"), false)
  assert.equal(html.includes("0 B"), false)
})
