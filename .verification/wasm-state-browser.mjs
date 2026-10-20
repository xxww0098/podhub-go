import { chromium } from 'playwright-core';
import { createServer } from 'vite';
const server = await createServer({ server: { port: 14923, strictPort: true } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:14923' ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on('pageerror', error => console.error(error));
  await page.goto('http://127.0.0.1:14923/tests/threaded-render.html');
  await page.waitForFunction(() => typeof window.verifyThreadedRenderer === 'function', null, { timeout: 30000 });
  const baseline = await page.evaluate(() => window.verifyThreadedRenderer());
  if (!baseline.passed) throw new Error(JSON.stringify(baseline));
  console.log('threaded-render ' + JSON.stringify(baseline));
  if (process.env.VERIFY_PART === 'web-cancel') {
    const cancelled = await page.evaluate(async () => {
      const { createRuntimeHost } = await import('/src/render/threaded-client.ts');
      let start;
      let spawned = 0;
      const host = createRuntimeHost({ maxLanes: 2, budgetBytes: 512 * 2 ** 20, requestTimeoutMs: 10000,
        spawn() {
          spawned++;
          const worker = new Worker(new URL('/src/render/threaded-worker.ts', location.origin), { type: 'module' });
          const post = worker.postMessage.bind(worker);
          worker.postMessage = (message, transfer = []) => {
            if (message.op === 'init') start = () => post(message, transfer);
            else post(message, transfer);
          };
          return worker;
        },
      });
      const a = host.createBatch(), b = host.createBatch();
      let cancelledCode, enteredA = false;
      const stopped = a.withLane('gate', async () => { enteredA = true; return 1; }).then(() => { throw new Error('cancelled owner succeeded'); }, error => { cancelledCode = error.code; });
      const survivor = b.withLane('gate', async () => 7);
      void survivor.catch(() => {});
      try {
        a.dispose();
        for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));
        if (cancelledCode !== 'RENDER_CANCELLED' || enteredA) throw new Error('init cancellation was not immediate');
        start();
        if (await survivor !== 7 || spawned !== 1) throw new Error('shared runtime did not survive');
        await stopped;
        return { passed: true, cancelledCode, enteredA, spawned };
      } finally {
        a.dispose(); b.dispose();
        await Promise.allSettled([stopped, survivor]);
      }
    });
    console.log('shared-init-cancellation ' + JSON.stringify(cancelled));
  }
} finally {
  await browser?.close();
  await server.close();
}
