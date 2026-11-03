import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { DeviceStorageCard } from "./account-screen"

test("本机存储分别展示浏览器估算和缓存实测，并标明受保护的源图", () => {
  const html = renderToStaticMarkup(
    <DeviceStorageCard
      storage={{ usedBytes: 3 * 1024 * 1024, quotaBytes: 32 * 1024 * 1024, persisted: true }}
      families={[
        { family: "templates", bytes: 0, entries: 0 },
        { family: "sources", bytes: 4 * 1024 * 1024, entries: 2 },
      ]}
      pinned={{ count: 1, bytes: 1024 * 1024 }}
      onClearFamily={() => {}}
    />,
  )

  assert.match(html, /浏览器估算已用 3\.0 MB/)
  assert.match(html, /配额 32 MB/)
  assert.match(html, /4\.0 MB · 2 项/)
  assert.match(html, /已钉住 1 张 · 1\.0 MB，清理时不会被删除/)
  assert.match(html, /已持久化/)
  const templateButton = html.match(/<button[^>]*aria-label="清理PSD 模板"[^>]*>/)?.[0]
  const sourceButton = html.match(/<button[^>]*aria-label="清理源图"[^>]*>/)?.[0]
  assert.match(templateButton ?? "", /\sdisabled(?:=|[\s>])/)
  assert.ok(sourceButton)
  assert.doesNotMatch(sourceButton, /\sdisabled(?:=|[\s>])/)
})

test("无法读取用量时显示未知状态，不伪造空缓存", () => {
  const html = renderToStaticMarkup(<DeviceStorageCard storage={null} families={null} />)

  assert.match(html, /当前浏览器不提供存储用量/)
  assert.match(html, /无法读取本机缓存分类/)
  assert.doesNotMatch(html, /0 B|清理本机缓存/)
})
