import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type { AccountOverview, WorkspaceStandingView } from "../src/bindings/commands"
import {
  WorkspaceMenu,
  applyLocalWorkspaceSwitch,
} from "../src/components/workspace-switcher"
import { planTone } from "../src/components/workspace-display"
import { SidebarProvider } from "../src/components/ui/sidebar"
import { WorkspaceScreen } from "../src/features/workspace/workspace-screen"

const overview: AccountOverview = {
  session: {
    authenticated: true,
    email: "seller@example.invalid",
    name: "Seller",
    role: "owner",
  },
  entitlement: {
    plan: "pro",
    features: {
      ai_relay: true,
      ocr: true,
      batch_listing: true,
      field_package: false,
    },
    limits: {
      stores: 3,
      stores_used: 1,
      seats: 8,
      seats_used: 3,
      s3_upload_bytes_monthly: 21474836480,
      s3_upload_bytes_used: 1073741824,
      ai_tokens_monthly: 1000000,
      ai_tokens_used: 120000,
      ai_calls_per_day: 100,
    },
  },
  active_workspace: {
    id: 1,
    uuid: "550e8400-e29b-41d4-a716-446655440000",
    name: "演示 Workspace",
    plan: "pro",
    role: "owner",
    is_owned: true,
  },
  workspaces: [
    {
      id: 1,
      uuid: "550e8400-e29b-41d4-a716-446655440000",
      name: "演示 Workspace",
      plan: "pro",
      role: "owner",
      is_owned: true,
    },
    {
      id: 2,
      uuid: "11111111-1111-4111-8111-111111111111",
      name: "合作方 Ultra",
      plan: "ultra",
      role: "member",
      is_owned: false,
    },
  ],
  account_mode: "owner",
  owned_count: 1,
  owned_limit: 3,
}

test("workspace screen fails closed until the Cloud directory is loaded", () => {
  const html = renderToStaticMarkup(<WorkspaceScreen overview={overview} />)

  assert.match(html, /演示 Workspace/)
  assert.doesNotMatch(html, /更换工作空间头像/)
  assert.doesNotMatch(html, /修改名称/)
  assert.match(html, /aria-label="邀请成员：正在读取成员信息，请稍候。"/)
  // Members are the gate on inviting, so they sit against that button — and are
  // the only quota here. The rest is read on 用量.
  assert.match(html, /成员 3 \/ 8/)
  assert.match(html, /待接受的邀请/)
  assert.match(html, /搜索姓名或邮箱/)
  assert.doesNotMatch(html, /上行流量/)
  assert.doesNotMatch(html, /充值余额|累计消费金额|去充值/)
  assert.doesNotMatch(html, /AI Token/)
  assert.doesNotMatch(html, /演示数据/)
  assert.doesNotMatch(html, /本地演示/)
  assert.doesNotMatch(html, /管理视图/)
  assert.doesNotMatch(html, /按工作范围分组/)
  assert.doesNotMatch(html, /上架运营/)
  assert.doesNotMatch(html, /供应商/)
})

test("workspace screen keeps member actions fail-closed before the Cloud directory loads", () => {
  const memberOverview: AccountOverview = {
    ...overview,
    active_workspace: overview.active_workspace
      ? { ...overview.active_workspace, role: "member", is_owned: false }
      : undefined,
    workspaces: overview.workspaces.map((workspace) =>
      workspace.id === 1 ? { ...workspace, role: "member", is_owned: false } : workspace
    ),
  }
  const html = renderToStaticMarkup(<WorkspaceScreen overview={memberOverview} />)

  assert.match(html, /演示 Workspace/)
  assert.doesNotMatch(html, /修改名称/)
  assert.doesNotMatch(html, /更换工作空间头像/)
  assert.doesNotMatch(html, />解散工作空间<\/button>/)
  assert.doesNotMatch(html, /离开工作空间/)
  assert.match(html, /aria-label="邀请成员：正在读取成员信息，请稍候。"/)
})

test("workspace screen offers dissolve only to the owner", () => {
  const html = renderToStaticMarkup(<WorkspaceScreen overview={overview} />)
  assert.match(html, /解散工作空间/)
  // 解散 and 离开 are the same door for one account; never both at once.
  assert.doesNotMatch(html, /离开工作空间/)
})

test("workspace screen keeps identity management fail-closed before the Cloud directory loads", () => {
  const html = renderToStaticMarkup(<WorkspaceScreen overview={overview} />)

  assert.match(html, /演示 Workspace/)
  assert.match(html, /所有者/)
  assert.match(html, /邀请成员/)
  assert.doesNotMatch(html, /修改名称/)
  assert.doesNotMatch(html, />解散工作空间<\/button>/)
  assert.match(html, /aria-label="邀请成员：正在读取成员信息，请稍候。"/)
  // The other Workspace is reachable from the sidebar switcher, not from this page.
  assert.doesNotMatch(html, /合作方 Ultra/)
  assert.doesNotMatch(html, /role="radiogroup"/)
  // 「自建」said the same thing as「所有者」.
  assert.doesNotMatch(html, /自建/)
})

const standing: WorkspaceStandingView = {
  workspaces: overview.workspaces,
  active_workspace: overview.active_workspace,
  account_mode: overview.account_mode ?? "owner",
  owned_count: overview.owned_count,
  owned_limit: overview.owned_limit,
}

test("workspace menu names the active Workspace on the trigger and subtitles the owner role", () => {
  const html = renderToStaticMarkup(
    <SidebarProvider>
      <WorkspaceMenu
        overview={overview}
        standing={standing}
        onOpenSpace={() => {}}
        onSwitchWorkspace={() => {}}
        onSignedOut={() => {}}
      />
    </SidebarProvider>
  )

  assert.match(html, /aria-label="账户与 Workspace 演示 Workspace，Plus 版，owner"/)
  assert.match(html, /data-plan="pro"/)
  // The membership role is the only subtitle, owner included — the crown is
  // gone, so ownership reads as measured text, not as an ornament.
  assert.match(html, /所有者/)
  assert.doesNotMatch(html, /data-slot="owner-crown"/)
  assert.match(
    readFileSync(new URL("../src/components/workspace-switcher.tsx", import.meta.url), "utf8"),
    /flex-col justify-center/,
  )
  assert.doesNotMatch(html, /成员席位/)
  assert.doesNotMatch(html, /PodHub/)
  assert.doesNotMatch(html, /供应商/)
})

test("workspace menu heads with the active Workspace, keeps the account a muted row, and anchors 退出登录 last", () => {
  const source = readFileSync(new URL("../src/components/workspace-switcher.tsx", import.meta.url), "utf8")
  const menuStart = source.indexOf("<DropdownMenuContent")
  const menuEnd = source.indexOf("</DropdownMenuContent>", menuStart)
  const menu = source.slice(menuStart, menuEnd)

  /* 用量 and 平台 left the menu: the header wallet badge opens 用量, and the
     settings sheet owns platform administration. 店铺 stays — a Workspace
     destination belongs to the Workspace menu — but folded into the actions
     group, no dedicated section. */
  assert.doesNotMatch(menu, /用量|平台/)
  assert.match(menu, /onOpenSpace\("stores"\)/)

  const order = [
    menu.indexOf("<WorkspaceMark"),
    menu.indexOf("SCREEN_LABELS.stores"),
    menu.indexOf("升级"),
    menu.indexOf("兑换码"),
    menu.indexOf("邀请成员"),
    menu.indexOf("添加账号"),
    menu.indexOf("<AccountActionsSubmenu"),
    menu.indexOf("可切换的 Workspace"),
    menu.indexOf("创建工作空间"),
    menu.indexOf("其他已登录账号"),
    menu.lastIndexOf("退出登录"),
  ]
  assert.ok(order.every((index) => index >= 0), "every region is present")
  assert.deepEqual([...order].sort((left, right) => left - right), order)
  /* The head is the Workspace the trigger already names; the account is the
     muted email row under the actions — its own user mark sits there, never
     leading the menu. */
  assert.ok(menu.indexOf("<WorkspaceMark") < menu.indexOf('kind="user"'))
  /* 邀请成员 loads the directory when opened and hands the same dialog the
     团队协作区 pane uses; the row itself only renders for owner/manager. */
  assert.match(source, /accountGetWorkspaceDirectory\(\)/)
  assert.match(source, /canInvite/)
  assert.match(source, /<WorkspaceInviteDialog/)
  assert.match(menu, /className="sr-only"/)
  /* When Cloud refuses the create, the entry is one muted note, not a dead
     item plus an orphaned paragraph. */
  assert.match(menu, /role="note"/)
  assert.doesNotMatch(menu, /disabled=\{refusal/)
  assert.match(source, /w-64/)
  assert.match(menu, /className=\{SHELL\}/)
  assert.match(menu, /DropdownMenuSeparator/)
  /* The merged menu owns the account row: sign-out. Settings lives on the
     footer gear — duplicating it inside the menu is the website habit this
     console dropped. */
  assert.doesNotMatch(menu, /onOpenSettings|>\s*设置\s*</)
  assert.match(menu, /onClick=\{\(\) => void signOut\(\)\}/)
  assert.doesNotMatch(source, /const WELL|bg-muted p-0\.5/)
  assert.doesNotMatch(menu, /<DropdownMenuLabel>Workspace</)
  assert.doesNotMatch(menu, /aria-label="本机设备"/)
  assert.doesNotMatch(menu, /<DropdownMenuLabel>本机设备</)
})

test("each workspace row carries a hover tooltip with plan and member count", () => {
  // Notion's row hover card: the plan badge and roster size restated as text.
  // The popup only renders on hover, so the wiring is asserted at its source.
  const source = readFileSync(new URL("../src/components/workspace-switcher.tsx", import.meta.url), "utf8")

  assert.match(source, /<Tooltip key=\{workspace\.id\}>/)
  assert.match(source, /<TooltipTrigger[\s\S]*DropdownMenuItem/)
  assert.match(source, /TooltipContent side="right"/)
  assert.match(source, /formatPlan\(workspace\.plan\)/)
  assert.match(source, /workspace\.member_count\} 名成员/)
})

test("each stacked account row carries the per-account … submenu (创建工作空间 / 登出)", () => {
  // Notion's account card: the row's "…" holds the account-level actions —
  // create under that account (加入只能走邀请，见创建弹窗指引), and signing
  // that account out — so the bare LogOut icon is gone in favour of the flyout.
  const source = readFileSync(new URL("../src/components/workspace-switcher.tsx", import.meta.url), "utf8")

  assert.match(source, /function AccountActionsSubmenu/)
  assert.match(source, /DropdownMenuSubTrigger/)
  assert.match(source, /创建工作空间/)
  assert.match(source, /退出该账号/)
  /* The non-active handoff survives the account switch's reload: the menu
     re-opens the create dialog for the account it was picked on. */
  assert.match(source, /markPendingWorkspaceCreate\(account\.uuid\)/)
  assert.match(source, /readPendingWorkspaceCreate\(\)/)
})

test("each plan grade has its own corner-mark tone", () => {
  const tones = ["lite", "pro", "max", "ultra"].map((key) => planTone(key)?.tone)
  assert.equal(new Set(tones).size, 4)
  assert.equal(planTone("free")?.tone, planTone("lite")?.tone)
  assert.equal(planTone(), undefined)
  assert.equal(planTone("enterprise")?.tone, planTone("lite")?.tone)
})

test("applyLocalWorkspaceSwitch updates active_workspace from overview.workspaces", () => {
  const next = applyLocalWorkspaceSwitch(overview, 2)
  assert.equal(next.active_workspace?.id, 2)
  assert.equal(next.active_workspace?.name, "合作方 Ultra")
  assert.equal(next.active_workspace?.role, "member")
  assert.equal(next.entitlement?.plan, "ultra")
  assert.equal(overview.workspaces.length, 2)
  assert.equal(applyLocalWorkspaceSwitch(overview, 1), overview)
})
