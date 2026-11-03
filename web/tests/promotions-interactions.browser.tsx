import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { ProductPromotionActionView, ProductPromotionOfferView } from "@/bindings/commands"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ProductsPromotions } from "@/features/products/products-promotions"
import type { StoreProductOverviewRow } from "@/features/products/products-api"
import "../src/index.css"

const store: StoreProductOverviewRow = { store_id: "00000000-0000-4000-8000-000000000001", name: "验收店铺", status: "active", freshness: "fresh", currency: "CNY" }
const action: ProductPromotionActionView = { action_id: 1977747, title: "弹性促销", action_type: "ELASTIC_BOOSTING", date_start: "2026-01-01T00:00:00Z", date_end: "2026-12-31T00:00:00Z", freeze_date: "", is_participating: true, eligible_selected: 0, participating_selected: 0, potential_products_total: 1, participating_products_total: 3 }
function offer(id: number): ProductPromotionOfferView { return { action_id: action.action_id, product_id: id, name: `商品 ${id}`, offer_id: `TEST-${id}`, sku: id === 1 ? "1234567890123456789" : String(id), participating: true, price: "60", price_currency_code: "CNY", action_price: "55", max_action_price: "58", currency_code: "CNY", add_mode: "SELLER", stock: 0, min_stock: 0, current_boost: null, min_boost: null, max_boost: null, price_min_elastic: "", price_max_elastic: "", price_quarantined: null } }
const writes: unknown[] = [], unexpected: string[] = []
const reads: unknown[] = []
let failPage = false
let largeBatch = false
let reconciles = 0
// Every request is intercepted, including writes; nothing can leave this fixture.
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href)
  const body = JSON.parse(String(init?.body ?? "{}"))
  if (url.origin !== location.origin) { unexpected.push(url.pathname); return Response.json({error: "blocked"}, {status:403}) }
  if (url.pathname === "/api/ops/products/promotions") {
    reads.push(body)
    if (!body.action_id) return Response.json({data:{actions:[action],offers:[]}})
    if (failPage) { failPage = false; return Response.json({error:"分页暂不可用",code:"ozon_products_failed"},{status:502}) }
    const rows = !body.participating ? [{...offer(4),participating:false}] : largeBatch ? body.cursor ? [offer(101)] : Array.from({length:100},(_,i)=>offer(i+1)) : body.cursor ? [offer(3)] : [offer(1),offer(2)]
    return Response.json({data:{actions:[action],offers:rows,total:body.participating?(largeBatch?101:3):1,next_cursor:body.participating&&!body.cursor?"second-page":null}})
  }
  if (url.pathname === "/api/ops/console/reconcile") {
    reconciles+=1
    const pending=writes.at(-1) as {operation_id:string}
    return Response.json({data:{skipped:0,entries:[{intent_id:"pending",run_id:"product_mutation:1",offer_id:`ozon.product-mutation:${store.store_id}:${pending.operation_id}`,outcome:reconciles===1?"still_unknown":"reconciled",reason:reconciles===1?"平台状态仍未确认":"已读回确认"}]}})
  }
  if (url.pathname === "/api/ops/products/mutate") {
    writes.push(body)
    if (largeBatch && body.request.items.length === 100) return Response.json({data:{operation_id:body.operation_id,items:body.request.items.map((item:{product_id:number})=>({identity:String(item.product_id),succeeded:true,message:""}))}})
    return Response.json({error:"Ozon 结果未确认",code:"seller_result_unknown"},{status:409})
  }
  unexpected.push(url.pathname)
  return Response.json({error:"blocked"},{status:403})
}
const fixture=document.querySelector<HTMLDivElement>("#fixture")!, results=document.querySelector<HTMLPreElement>("#results")!, run=document.querySelector<HTMLButtonElement>("#run")!
flushSync(()=>createRoot(fixture).render(<TooltipProvider><ProductsPromotions stores={[store]} initialStoreId={store.store_id} onBack={()=>{}} onApplied={()=>{}} /></TooltipProvider>))
function check(value: unknown,message:string): asserts value { if (!value) throw new Error(message) }
async function waitFor(predicate:()=>boolean,message:string) { const end=performance.now()+5000;while(!predicate()){check(performance.now()<end,message);await new Promise<void>((resolve)=>requestAnimationFrame(()=>resolve()))} }
function button(label:string){return [...document.querySelectorAll<HTMLButtonElement>('button')].find((item)=>item.textContent?.trim()===label)}
function type(value:string){const input=document.querySelector<HTMLInputElement>('[aria-label="目标活动价"]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))}
run.onclick=async()=>{
 run.disabled=true
 try {
  await waitFor(()=>!!fixture.textContent?.includes('已加载 2 / 3 件'),'first page missing')
  check(fixture.textContent?.includes('1234567890123456789'),'SKU was rounded')
  button('加载更多')!.click()
  await waitFor(()=>!!fixture.textContent?.includes('已加载 3 / 3 件'),'pagination missing')
  check(!button('加载更多'),'load more stayed after total reached')
  document.querySelector<HTMLButtonElement>('[aria-label="选择已加载的全部活动商品"]')!.click()
  await waitFor(()=>!!button('批量调整促销'),'batch action missing')
  button('批量调整促销')!.click()
  await waitFor(()=>!!document.querySelector('[aria-label="目标活动价"]'),'change dialog missing')
  type('59')
  await waitFor(()=>!!document.body.textContent?.includes('超过商品'),'over-limit preview did not block')
  check(button('确认加入 / 改价')?.disabled,'over-limit confirmation allowed')
  type('54.99')
  await waitFor(()=>!button('确认加入 / 改价')?.disabled,'valid amount stayed disabled')
  button('确认加入 / 改价')!.click()
  await waitFor(()=>!!button('核实并重新读取'),'unknown result did not latch')
  check(writes.length===1,'unexpected write count')
  const request=(writes[0] as {request:{action_type:string;items:{action_price:string;currency_code:string;stock:number}[]}}).request
  check(request.action_type==='ELASTIC_BOOSTING'&&request.items.length===3&&request.items.every((item)=>item.action_price==='54.99'&&item.currency_code==='CNY'&&item.stock===0),'wire contract lost currency/decimal/type')
  check(!button('确认加入 / 改价'),'unknown result offered an unsafe resend')
  button('核实并重新读取')!.click()
  await waitFor(()=>!!document.body.textContent?.includes('平台状态仍未确认'),'HTTP 200 still_unknown was treated as confirmed')
  check(!!document.querySelector('[role="dialog"]'),'still_unknown closed the form')
  await waitFor(()=>!!button('核实并重新读取')&&!button('核实并重新读取')?.disabled,'reconcile remained busy')
  button('核实并重新读取')!.click()
  await waitFor(()=>!document.querySelector('[role="dialog"]')&&!!fixture.textContent?.includes('已加载 2 / 3 件'),'read-back did not close and refresh')
  failPage=true
  const candidate=[...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((item)=>item.textContent?.includes('可参加'))!;candidate.click()
  await waitFor(()=>!!fixture.textContent?.includes('分页暂不可用'),'page failure appeared as empty')
  button('重试')!.click()
  await waitFor(()=>!!fixture.textContent?.includes('TEST-4'),'retry did not restore candidates')
  check(writes.length===1&&unexpected.length===0,'request escaped fixture or was repeated')
  check(reads.length>=5,'expected reads missing')
  largeBatch=true
  ;([...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((item)=>item.textContent?.includes('已参加')))!.click()
  await waitFor(()=>!!fixture.textContent?.includes('已加载 100 / 101 件'),'large batch first page missing')
  button('加载更多')!.click()
  await waitFor(()=>!!fixture.textContent?.includes('已加载 101 / 101 件'),'large batch final page missing')
  document.querySelector<HTMLButtonElement>('[aria-label="选择已加载的全部活动商品"]')!.click()
  await waitFor(()=>!!button('批量调整促销'),'large batch selection missing')
  button('批量调整促销')!.click()
  await waitFor(()=>!!document.querySelector('[aria-label="目标活动价"]'),'large batch form missing')
  type('54.98')
  await waitFor(()=>!button('确认加入 / 改价')?.disabled,'large batch amount invalid')
  button('确认加入 / 改价')!.click()
  await waitFor(()=>!!button('核实并重新读取'),'partial success unmounted the unknown-result form')
  check(Number(writes.length)===3,'chunk dispatch did not stop at the unknown result')
  check(!!document.querySelector('[role="dialog"]')&&!!document.body.textContent?.includes('勿重复提交'),'partial unknown warning disappeared')
  check(unexpected.length===0,'request escaped fixture')
  results.textContent='PASS：分页、精确 SKU、价格上限、金额币种、分块部分成功/未知保留、核实、失败重试';results.dataset.result='pass';results.dataset.writeCount=String(writes.length);results.dataset.reconcileCount=String(reconciles)
 }catch(reason){results.textContent='FAIL: '+String(reason);results.dataset.result='fail'}finally{run.disabled=false}
}
