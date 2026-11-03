import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { ChangelogNotes } from "@/components/changelog-notes"
import { parseChangelog } from "@/lib/changelog"

const FIXTURE = `
## 已发布版本
| 版本 tag | 日期 | tag 提交摘要 |
| --- | --- | --- |
| \`v1.2.0\` | 2026-03-01 | perf: 降低 JPEG 码率 |
| \`v1.2.3\` | 2026-03-03 | fix(web): 截断 \`offer_id\` |
| \`v1.2.2\` | 2026-03-02 | feat: 新增批量填充 |
| \`v1.0.0\` | 2026-01-04 | fix: 注入 <img src=x onerror=alert(1)> |
`

test("更新说明按版本、小节和圆点渲染，行内代码用灰底等宽", () => {
  const html = renderToStaticMarkup(<ChangelogNotes releases={parseChangelog(FIXTURE, 3)} />)
  assert.match(html, /id="changelog-1\.2\.3"/)
  assert.match(html, /dateTime="2026-03-03"/)
  assert.equal((html.match(/最新版本/g) ?? []).length, 1)
  assert.match(html, /<ul[^>]*class="[^"]*list-disc/)
  assert.match(html, />修复</)
  assert.match(html, /<code[^>]*class="[^"]*bg-muted[^"]*font-mono[^"]*"[^>]*>offer_id<\/code>/)
  assert.match(html, />新增批量填充</)
  assert.match(html, />降低 JPEG 码率</)
  assert.doesNotMatch(html, /v1\.0\.0/)
})

test("解析不到版本时留下说明，不把原文当 HTML", () => {
  const empty = renderToStaticMarkup(<ChangelogNotes releases={[]} />)
  assert.match(empty, /暂时没有可显示的更新记录/)
  assert.doesNotMatch(empty, /role="alert"/)

  const hostile = renderToStaticMarkup(
    <ChangelogNotes releases={parseChangelog(FIXTURE, 5).filter((release) => release.version === "1.0.0")} />,
  )
  assert.match(hostile, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(hostile, /<img/)
})

test("版本没有 git tag 时保留真实记录中的说明", () => {
  const releases = parseChangelog(`
## 已发布版本
### 0.0.1
- 日期：2026-10-14
- tag：无
#### 修复
- 更新说明
`)
  const html = renderToStaticMarkup(<ChangelogNotes releases={releases} />)
  assert.match(html, /没有 git tag/)
})
