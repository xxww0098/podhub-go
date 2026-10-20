import { chromium } from 'playwright-core'
import { createServer } from 'vite'
const server = await createServer({ server: { host: '127.0.0.1', port: 14923, strictPort: true } })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ serviceWorkers: 'block' })
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    return url.origin === 'http://127.0.0.1:14923' ? route.continue() : route.abort()
  })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(String(error)))
  await page.goto('http://127.0.0.1:14923/tests/threaded-render.html')
  await page.waitForFunction(() => typeof window.verifyThreadedRenderer === 'function', null, { timeout: 30000 })
  const result = await page.evaluate(() => window.verifyThreadedRenderer())
  if (!result.passed || pageErrors.length) throw new Error(JSON.stringify({ result, pageErrors }))
  console.log(JSON.stringify(result))
} finally {
  await browser?.close()
  await server.close()
}
