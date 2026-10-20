import { chromium } from 'playwright-core'
import { createServer } from 'vite'
const server = await createServer({ server: { host: '127.0.0.1', port: 14924, strictPort: true } })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ serviceWorkers: 'block' })
  await context.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:14924' ? route.continue() : route.abort())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto('http://127.0.0.1:14924/tests/threaded-render.html')
  await page.waitForFunction(() => typeof window.verifyThreadedRenderer === 'function', null, { timeout: 30000 })
  const result = await page.evaluate(() => window.verifyThreadedRenderer())
  if (!result.passed || errors.length) throw new Error(JSON.stringify({ result, errors }))
  console.log(JSON.stringify(result))
} finally {
  await browser?.close()
  await server.close()
}
