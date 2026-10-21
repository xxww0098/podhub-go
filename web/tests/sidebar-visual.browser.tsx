// Real shell with isolated, fictional identities; no business request reaches Cloud.
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { AppShell } from "@/app/app-shell"
import { accountHttp } from "@/bindings/http-account"
import { listingHttp } from "@/bindings/http-listing"
import { Button } from "@/components/ui/button"
import { Toaster } from "@/components/ui/toast"
import { rememberAccountOverview } from "@/features/account/account-overview-cache"
import { SCREEN_LABELS, type AppScreen } from "@/lib/app-screens"
import { initTheme } from "@/lib/theme"
import { noNotifications, overview as accountFixture } from "./account-fixtures"
import "../src/index.css"

function isolatedStorage(initial: [string, string][] = []): Storage {
  const values = new Map(initial)
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)) },
    removeItem: (key) => { values.delete(key) },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size },
  }
}
Object.defineProperty(window, "localStorage", { configurable: true, value: isolatedStorage([["podhub.theme", "system"]]) })
Object.defineProperty(window, "sessionStorage", { configurable: true, value: isolatedStorage() })
window.fetch = async (input) => { throw new Error(`Sidebar fixture blocked request: ${String(input)}`) }
initTheme()

const workspace = { ...accountFixture.active_workspace!, name: "我的工作区" }
const alternate = { ...workspace, id: 2, uuid: "fixture-workspace-2", name: "第二工作区" }
const demo = {
  ...accountFixture,
  entitlement: undefined,
  session: { ...accountFixture.session, name: "演示用户", email: "user@example.invalid" },
  active_workspace: workspace,
  workspaces: [workspace, alternate],
  accounts: [
    { uuid: "fixture-account-1", name: "演示用户", email: "user@example.invalid", active: true },
    { uuid: "fixture-account-2", name: "第二用户", email: "second@example.invalid", active: false },
  ],
}
let current = demo
accountHttp.accountGetOverview = async () => current
accountHttp.accountLogout = async () => {}
listingHttp.listingCardListSavedDrafts = async () => []
listingHttp.listingCardLoadCategoryTree = async () => []
rememberAccountOverview(current)

const products = [
  { name: "帆布袋", image: "/site/product-tote.jpg", category: "箱包配饰", price: "¥ 25.00" },
  { name: "纯棉 T 恤", image: "/site/product-shirt.jpg", category: "服饰内衣", price: "¥ 89.00" },
  { name: "陶瓷马克杯", image: "/site/product-mug.jpg", category: "家居生活", price: "¥ 39.00" },
]

function Preview() {
  const [screen, setScreen] = useState<AppScreen>("listing")
  const [overview, setOverview] = useState(demo)
  const [message, setMessage] = useState("")
  function update(next: typeof demo) {
    current = next
    rememberAccountOverview(next)
    setOverview(next)
  }
  return (
    <Toaster>
      <AppShell
        screen={screen}
        overview={overview}
        onScreenChange={setScreen}
        notifications={noNotifications}
        onSwitchWorkspace={(id) => update({ ...overview, active_workspace: overview.workspaces.find((item) => item.id === id)! })}
        onSwitchAccount={(uuid) => {
          const account = overview.accounts.find((item) => item.uuid === uuid)!
          update({ ...overview, session: { ...overview.session, name: account.name, email: account.email }, accounts: overview.accounts.map((item) => ({ ...item, active: item.uuid === uuid })) })
        }}
        onLogoutAccount={(uuid) => update({ ...overview, accounts: overview.accounts.filter((item) => item.uuid !== uuid) })}
        onAddAccount={() => setMessage("已打开添加账号")}
        onSignedOut={() => setMessage("已退出登录")}
      >
        <div className="flex items-center justify-between gap-4 pt-3">
          <div>
            <h1 className="text-2xl font-semibold">{SCREEN_LABELS[screen]}</h1>
            <p className="mt-2 text-sm text-muted-foreground">快速创建并发布多个商品到店铺，支持批量编辑与一键上架。</p>
          </div>
          <Button>新建任务</Button>
        </div>
        <div className="mt-6 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-128 text-left text-sm">
            <thead className="bg-muted/40 text-muted-foreground"><tr><th className="p-4 font-medium">商品信息</th><th className="p-4 font-medium">类目</th><th className="p-4 font-medium">状态</th><th className="p-4 font-medium">售价</th></tr></thead>
            <tbody>{products.map((product) => <tr key={product.name} className="border-t border-border"><td className="flex items-center gap-4 p-4"><img src={product.image} alt="" className="size-16 rounded-md object-cover" /><span>{product.name}</span></td><td className="p-4">{product.category}</td><td className="p-4">待上架</td><td className="p-4 tabular-nums">{product.price}</td></tr>)}</tbody>
          </table>
        </div>
        <p role="status">{message}</p>
      </AppShell>
    </Toaster>
  )
}
createRoot(document.querySelector("#root")!).render(<Preview />)
