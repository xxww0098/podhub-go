import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { ChangelogButton, ChangelogDialogPanel, ChangelogNotes } from "@/components/changelog-dialog"
import { Dialog } from "@/components/ui/dialog"
import {
  CHANGELOG_SEEN_KEY,
  parseChangelog,
  type ChangelogRelease,
} from "@/lib/changelog"

const FIXTURE = `
## 已发布版本
| 版本 tag | 日期 | tag 提交摘要 |
| --- | --- | --- |
| \`v1.2.0\` | 2026-03-01 | perf: 降低 JPEG 码率 |
| \`v1.2.3\` | 2026-03-03 | fix(web): 截断 \`offer_id\` |
| \`v1.2.2\` | 2026-03-02 | feat: 新增批量填充 |
| \`v1.1.0\` | 2026-01-01 | chore: 旧版本不应出现 |
| \`v1.0.0\` | 2026-01-04 | fix: 注入 <img src=x onerror=alert(1)> |
`

function notes(limit = 3): ChangelogRelease[] {
  return parseChangelog(FIXTURE, limit)
}

function withStorage(value: string | null, run: () => void) {
  const previous = globalThis.localStorage
  const saved = new Map<string, string>()
  if (value !== null) saved.set(CHANGELOG_SEEN_KEY, value)
  globalThis.localStorage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, next: string) => {
      saved.set(key, next)
    },
    removeItem: (key: string) => {
      saved.delete(key)
    },
    clear: () => {
      saved.clear()
    },
    key: (index: number) => [...saved.keys()][index] ?? null,
    get length() {
      return saved.size
    },
  } as Storage
  try {
    run()
  } finally {
    if (previous === undefined) {
      delete (globalThis as { localStorage?: Storage }).localStorage
    } else {
      globalThis.localStorage = previous
    }
  }
}

test("更新说明按版本、小节和圆点渲染，行内代码用灰底等宽", () => {
  const html = renderToStaticMarkup(<ChangelogNotes releases={notes()} />)
  assert.match(html, /id="changelog-1\.2\.3"/)
  assert.match(html, />v1\.2\.3</)
  assert.match(html, /dateTime="2026-03-03"/)
  assert.match(html, />修复</)
  assert.match(html, /<code[^>]*class="[^"]*bg-muted[^"]*font-mono[^"]*"[^>]*>offer_id<\/code>/)
  assert.match(html, />新增</)
  assert.match(html, />新增批量填充</)
  assert.match(html, />优化</)
  assert.match(html, />降低 JPEG 码率</)
  assert.doesNotMatch(html, /v1\.1\.0/)
  assert.doesNotMatch(html, /v1\.0\.0/)
  const rules = html.match(/data-slot="separator"/g) ?? []
  assert.equal(rules.length, 2)
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

test("弹窗标题是当前版本，底部和说明都在", () => {
  const html = renderToStaticMarkup(
    <Dialog open>
      <ChangelogDialogPanel title="v0.0.93 更新内容" releases={notes()} />
    </Dialog>,
  )
  assert.match(html, /v0\.0\.93 更新内容/)
  assert.match(html, /最近 3 个已发布版本的更新说明/)
  assert.match(html, /aria-label="版本更新列表"/)
  assert.match(html, />关闭</)
  assert.match(html, /v1\.2\.3/)
})

test("没看过当前版本时按钮带小红点，看过则没有", () => {
  withStorage(null, () => {
    const html = renderToStaticMarkup(
      <ChangelogButton version="0.0.93" releases={notes()} />,
    )
    assert.match(html, />更新日志</)
    assert.match(html, /有新版本/)
    assert.match(html, /data-changelog-unread/)
    assert.match(html, /bg-destructive/)
  })
  withStorage("0.0.93", () => {
    const html = renderToStaticMarkup(
      <ChangelogButton version="0.0.93" releases={notes()} />,
    )
    assert.match(html, />更新日志</)
    assert.doesNotMatch(html, /data-changelog-unread/)
    assert.doesNotMatch(html, /有新版本/)
  })
  withStorage(null, () => {
    const html = renderToStaticMarkup(<ChangelogButton version="" releases={[]} />)
    assert.match(html, />更新日志</)
    assert.doesNotMatch(html, /data-changelog-unread/)
  })
})

test("弹窗交给对话框原语处理 Esc、遮罩和焦点", () => {
  const source = readFileSync(new URL("./changelog-dialog.tsx", import.meta.url), "utf8")
  assert.match(source, /<Dialog open=\{open\} onOpenChange=\{onOpenChange\}>/)
  assert.match(source, /<DialogContent/)
  assert.match(source, /<DialogTitle>/)
  assert.match(source, /<DialogClose/)
  assert.doesNotMatch(source, /disablePointerDismissal/)
  assert.doesNotMatch(source, /role="alert"/)

  const shell = readFileSync(new URL("../app/app-shell.tsx", import.meta.url), "utf8")
  assert.match(shell, /<ChangelogButton \/>/)
})
