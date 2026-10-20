import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { changelogJsonFromRoot } from "../../vite.changelog.ts"
import {
  CHANGELOG_SEEN_KEY,
  CHANGELOG_VISIBLE_LIMIT,
  changelogHasUnread,
  changelogReleasesFromJson,
  parseChangelog,
  readSeenChangelogVersion,
  writeSeenChangelogVersion,
  type ChangelogRelease,
} from "./changelog.ts"

const REAL_CHANGELOG = readFileSync(new URL("../../../CHANGELOG.md", import.meta.url), "utf8")

function summary(release: ChangelogRelease): string[] {
  return release.sections.flatMap((section) =>
    section.items.map((item) => item.spans.map((span) => span.text).join("")),
  )
}

test("仓库 CHANGELOG 解析出最近 3 个版本，并按新增优化修复分组", () => {
  const releases = parseChangelog(REAL_CHANGELOG)
  assert.equal(releases.length, CHANGELOG_VISIBLE_LIMIT)
  assert.deepEqual(
    releases.map((release) => release.version),
    ["0.0.107", "0.0.103", "0.0.102"],
  )
  assert.equal(releases[0]?.date, "2026-10-14")
  assert.equal(releases[0]?.note, "没有 git tag")
  assert.deepEqual(
    releases[0]?.sections.map((section) => section.title),
    ["新增", "优化", "修复"],
  )
  assert.equal(releases[0]?.sections[0]?.items.length, 3)
  assert.deepEqual(summary(releases[0]!), [
    "店铺商品页可以按规格整理商品：把同一个设计的几个尺寸合并成一个共同型号，也可以把其中一件拆出来，或把它移进已有的分组。每一步都先给预览，确认后才写到 Ozon；每个尺寸仍保留自己的图片、价格和库存",
    "工作台的「型号」成为独立一列，可以逐行填写；卡片默认值、识图结果和源图文件名都不会覆盖你写过的型号",
    "账户安全补齐：邮箱验证、自助重置密码和工作区邀请邮件改走新的外发通道（未配置 CLOUD_SMTP_URL 时只写 Cloud 日志）；超级管理员要在登录后绑定验证器，绑定前平台管理页会要求先绑定，绑定后登录还要一次验证码或恢复码",
    "分组之后系统只做只读核对（最多 10 趟、30 分钟、每趟最多 3 次读取）：确认组合真的生效，或者说明还需要人工核实；用完之后不会自动重发",
    "同一个 Ozon 账号登记成两个 Cloud 店铺（甚至两个工作区）时，两边的分组与同款发送会互相排队，不会把对方的改动盖掉",
    "识图计费护栏默认开启：先校验答案再结算，不合格的答案释放预占；同一个购买键重放不再调用上游、不再重复扣费。显式设置 CLOUD_OCR_BILLING_GUARD=0 可回到原来的先结算后校验",
    "类目字段缓存缺变体维度元数据时不再被当成「过期不可用」：普通读取、草稿与校验照常，只有分组判定会要求刷新材料，不会再出现「类目需要同步」却同步不掉的循环",
    "改价、改库存、促销、归档、恢复、删除商品，以及确认分组执行，不再因为写入账本回执编号读错类型或漂移比对读错字段而报「服务暂不可用」「商品属性已变化」",
    "识图写俄语时，会把词里能确定的拉丁形近字改成对应的西里尔字母，包括以前对不上的 г、ш 和 Ь。英文词里误写的西里尔形近字会改回拉丁字母。对不上的字母再识别一次时，会指出是哪几个词、哪几个字母；指不出来就不再扣第二次",
    "店铺名册显示期末余额，销售额按当日汇率从卢布换算成店铺币种（默认取俄罗斯央行公布的每日牌价）",
  ])
  const shown = releases.flatMap((release) => summary(release)).join("\n")
  for (const word of [
    "log-poll",
    "admin",
    "指纹",
    "迁移",
    "docker",
    "jsonl",
    "seaql",
    "pull-up",
    "rclone",
    "命令行",
    "数据库结构比对",
    "宿主机",
    "前端日志",
    "健康报告",
    "连接池",
    "媒体租约",
  ]) {
    assert.equal(shown.includes(word), false, word)
  }
  assert.equal(releases[1]?.note, "")
  assert.deepEqual(
    releases[1]?.sections.map((section) => section.title),
    ["优化", "修复"],
  )
  assert.equal(releases[2]?.note, "")
  assert.deepEqual(
    releases[2]?.sections.map((section) => section.title),
    ["优化", "修复"],
  )
  const older = parseChangelog(REAL_CHANGELOG, 20)
  assert.equal(older.find((release) => release.version === "0.0.85")?.sections[0]?.title, "修复")
})

test("构建注入只打包最近 3 个版本的 JSON", () => {
  const webDir = new URL("../..", import.meta.url)
  const json = changelogJsonFromRoot(webDir.pathname)
  const releases = changelogReleasesFromJson(json)
  assert.deepEqual(
    releases.map((release) => release.version),
    ["0.0.107", "0.0.103", "0.0.102"],
  )
  assert.equal(changelogJsonFromRoot("/missing/podhub/web"), "[]")
})

test("分组说明优先于同版本的表格行，没有 tag 时带说明", () => {
  const releases = parseChangelog(`
## 已发布版本

### 0.0.2

- 日期：2026-05-02
- tag：无

#### 新增

- 草稿发布

#### 修复

- 旧卡片可以打开

### 更早的 tag

| 版本 tag | 日期 | tag 提交摘要 |
| --- | --- | --- |
| \`v0.0.2\` | 2026-05-01 | chore: 这行应被分组盖住 |
| \`v0.0.1\` | 2026-05-01 | fix: 表格里的旧修复 |
`)
  assert.deepEqual(
    releases.map((release) => [release.version, release.note, release.sections[0]?.title]),
    [
      ["0.0.2", "没有 git tag", "新增"],
      ["0.0.1", "", "修复"],
    ],
  )
  assert.deepEqual(summary(releases[0]!), ["草稿发布", "旧卡片可以打开"])
})

test("版本按 semver 取最新，而不是表格书写顺序", () => {
  const releases = parseChangelog(`
## 已发布版本
| 版本 tag | 日期 | tag 提交摘要 |
| --- | --- | --- |
| \`v0.0.1\` | 2026-01-01 | fix: 旧修复 |
| \`v1.0.0\` | 2026-03-01 | feat: 大版本 |
| \`v0.9.0\` | 2026-02-01 | perf: 变快了 |
| \`v0.2.0\` | 2026-01-02 | chore: 更旧 |
`)
  assert.deepEqual(
    releases.map((release) => [release.version, release.sections[0]?.title]),
    [
      ["1.0.0", "新增"],
      ["0.9.0", "优化"],
      ["0.2.0", "发布"],
    ],
  )
})

test("行内代码保留为 code span，未闭合反引号不当代码", () => {
  const [release] = parseChangelog(`
## 已发布版本
| 版本 tag | 日期 | tag 提交摘要 |
| --- | --- | --- |
| \`v0.1.0\` | 2026-01-01 | fix(web): 截断 \`offer_id\` 与 \`sku\` |
`)
  assert.deepEqual(release?.sections[0]?.items[0]?.spans, [
    { kind: "text", text: "截断 " },
    { kind: "code", text: "offer_id" },
    { kind: "text", text: " 与 " },
    { kind: "code", text: "sku" },
  ])

  const [broken] = parseChangelog(`
## 已发布版本
| 版本 tag | 日期 | tag 提交摘要 |
| --- | --- | --- |
| v0.1.1 | 2026-01-02 | fix: 未闭合 \`offer_id |
`)
  assert.deepEqual(broken?.sections[0]?.items[0]?.spans, [
    { kind: "text", text: "未闭合 `offer_id" },
  ])
})

test("括号里的顿号拆成条目，发布套话和单条括号不拆", () => {
  const [split] = parseChangelog(`
## 已发布版本
| 版本 tag | 日期 | tag 提交摘要 |
| --- | --- | --- |
| v0.3.0 | 2026-04-01 | chore(release): 发布 v0.3.0（甲、乙） |
`)
  assert.deepEqual(summary(split!), ["甲", "乙"])

  const [kept] = parseChangelog(`
## 已发布版本
| 版本 tag | 日期 | tag 提交摘要 |
| --- | --- | --- |
| v0.3.1 | 2026-04-02 | fix: 调整了参数（甲、乙）并记录 |
`)
  assert.deepEqual(summary(kept!), ["调整了参数", "甲", "乙", "并记录"])

  const [whole] = parseChangelog(`
## 已发布版本
| 版本 tag | 日期 | tag 提交摘要 |
| --- | --- | --- |
| v0.3.2 | 2026-04-03 | fix: 只修了一处（超时） |
`)
  assert.deepEqual(summary(whole!), ["只修了一处（超时）"])
})

test("未知类型、坏行和空文档都得到空结果或「更新」，不抛错", () => {
  assert.deepEqual(parseChangelog(""), [])
  assert.deepEqual(parseChangelog("没有表格"), [])
  assert.deepEqual(parseChangelog("# 版本记录\n\n| 别的表 | 列 |\n| --- | --- |\n| a | b |"), [])
  assert.deepEqual(parseChangelog("## 已发布版本\n| 版本 tag | 日期 | tag 提交摘要 |\n| --- | --- | --- |\n| 不是版本 | 昨天 | 跳过 |\n| v0.1.0 | 坏日期 | wip: 还在做 |\n", 0), [])

  const releases = parseChangelog(`
## 已发布版本
| 版本 tag | 日期 | tag 提交摘要 |
| --- | --- | --- |
| 不是版本 | 2026-01-01 | fix: 跳过 |
| \`v0.1.0\` | 昨天 | wip: 还在做 |
| v0.1.0 | 2026-01-03 | fix: 重复行被丢掉 |
| | | |
`)
  assert.equal(releases.length, 1)
  assert.equal(releases[0]?.date, "")
  assert.equal(releases[0]?.sections[0]?.title, "更新")
  assert.deepEqual(summary(releases[0]!), ["还在做"])
})

test("JSON 往返保留代码，垃圾输入变成空列表", () => {
  const releases = parseChangelog(`
## 已发布版本
| 版本 tag | 日期 | tag 提交摘要 |
| --- | --- | --- |
| v0.4.0 | 2026-05-01 | fix: 看 \`sku\` |
`)
  assert.deepEqual(changelogReleasesFromJson(JSON.stringify(releases)), releases)
  assert.deepEqual(changelogReleasesFromJson("[]"), [])
  assert.deepEqual(changelogReleasesFromJson(""), [])
  assert.deepEqual(changelogReleasesFromJson("{"), [])
  assert.deepEqual(changelogReleasesFromJson("不是 json"), [])
  assert.deepEqual(changelogReleasesFromJson(null), [])
  assert.deepEqual(changelogReleasesFromJson([{ version: "nope" }, { version: "1.2.3", sections: "x" }]), [
    { version: "1.2.3", date: "", note: "", sections: [] },
  ])
})

test("已读版本存在 localStorage，读写失败时当成没看过", () => {
  assert.equal(changelogHasUnread("0.0.93", ""), true)
  assert.equal(changelogHasUnread("0.0.93", "0.0.92"), true)
  assert.equal(changelogHasUnread("0.0.93", "0.0.93"), false)
  assert.equal(changelogHasUnread("", ""), false)
  assert.equal(changelogHasUnread("  ", "0.0.93"), false)

  const saved = new Map<string, string>()
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value)
    },
  }
  assert.equal(readSeenChangelogVersion(storage), "")
  writeSeenChangelogVersion(" 0.0.93 ", storage)
  assert.equal(saved.get(CHANGELOG_SEEN_KEY), "0.0.93")
  assert.equal(readSeenChangelogVersion(storage), "0.0.93")

  const broken = {
    getItem: () => {
      throw new Error("denied")
    },
    setItem: () => {
      throw new Error("quota")
    },
  }
  assert.equal(readSeenChangelogVersion(broken), "")
  assert.doesNotThrow(() => writeSeenChangelogVersion("0.0.93", broken))
  assert.equal(readSeenChangelogVersion(null), "")
  assert.doesNotThrow(() => writeSeenChangelogVersion("0.0.93", null))
})
