import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { changelogJsonFromRoot } from "../../vite.changelog.ts"
import {
  CHANGELOG_VISIBLE_LIMIT,
  changelogReleasesFromJson,
  parseChangelog,
  type ChangelogRelease,
} from "./changelog.ts"

const REAL_CHANGELOG = readFileSync(new URL("../../../CHANGELOG.md", import.meta.url), "utf8")

function summary(release: ChangelogRelease): string[] {
  return release.sections.flatMap((section) =>
    section.items.map((item) => item.spans.map((span) => span.text).join("")),
  )
}

test("仓库 CHANGELOG 从 0.0.1 开始，展示最近 3 个当前版本", () => {
  const releases = parseChangelog(REAL_CHANGELOG)
  const all = parseChangelog(REAL_CHANGELOG, 1000)
  assert.deepEqual(releases, all.slice(0, CHANGELOG_VISIBLE_LIMIT))
  assert.equal(all.at(-1)?.version, "0.0.1")
  assert.equal(all.find((release) => release.version === "0.0.1")?.date, "2026-11-03")
  assert.equal(all.find((release) => release.version === "0.0.2")?.date, "2026-11-03")
  assert.doesNotMatch(all.flatMap(summary).join("\n"), /账户安全补齐：邮箱验证|限制模型输出参数并发布 0\.0\.85/)
  assert.ok(all.every((release) => release.sections.length > 0))
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
})

test("构建注入只打包最近 3 个版本的 JSON", () => {
  const webDir = new URL("../..", import.meta.url)
  const json = changelogJsonFromRoot(webDir.pathname)
  const releases = changelogReleasesFromJson(json)
  assert.deepEqual(releases, parseChangelog(REAL_CHANGELOG))
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
