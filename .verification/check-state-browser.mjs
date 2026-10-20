import { chromium } from 'playwright-core';
import { createServer } from 'vite';
const server = await createServer({server:{port:14922,strictPort:true}});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({channel:'chrome',headless:true});
  const context = await browser.newContext({serviceWorkers:'block'});
  await context.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:14922' ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:14922/tests/threaded-render.html');
  await page.waitForFunction(() => typeof window.verifyThreadedRenderer === 'function', null, {timeout:30000});
  const result = await page.evaluate(() => window.verifyThreadedRenderer());
  if (!result.passed) throw new Error(JSON.stringify(result));
  console.log('threaded',JSON.stringify(result));
  const cancellation = await page.evaluate(async () => {
    const {createRuntimeHost} = await import('/src/render/threaded-client.ts');
    const host = createRuntimeHost({spawn:()=>new Worker('/src/render/threaded-worker.ts',{type:'module'}),maxLanes:2,budgetBytes:512*2**20});
    const a=host.createBatch(), b=host.createBatch();
    let entered=false, code, timer;
    try {
      const wait=a.withLane('init-cancel-fixture',async()=>{entered=true}).then(()=>{throw new Error('cancelled caller succeeded')},e=>{code=e.code});
      a.dispose();
      await Promise.race([wait,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('owner cancellation stalled')),1000)})]);
      clearTimeout(timer);
      if(code!=='RENDER_CANCELLED'||entered) throw new Error('invalid cancelled-owner result');
      await b.withLane('init-cancel-fixture',async()=>{});
      const c=host.createBatch();
      try {
        let lateCode;
        await c.withLane('continuation-fixture',async()=>{
          queueMicrotask(()=>queueMicrotask(()=>c.dispose()));
          return 'stale result';
        }).then(()=>{throw new Error('cancelled continuation delivered')},e=>{lateCode=e.code});
        if(lateCode!=='RENDER_CANCELLED') throw new Error('wrong continuation cancellation');
      } finally {c.dispose()}
      await b.withLane('still-live',async()=>{});
      return {passed:true,code,entered,continuationCancelled:true,otherOwnerAlive:true};
    } finally {clearTimeout(timer);a.dispose();b.dispose()}
  });
  console.log('cancellation',JSON.stringify(cancellation));
} finally {await browser?.close();await server.close()}
