// Dev-only 视觉检查页：对象存储屏。?tab=assets / ?tab=private 切换分区。
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"

import type { IntegrationCredentialsOverview } from "@/bindings/commands"
import { Toaster } from "@/components/ui/toast"
import { NotificationsProvider } from "@/features/notifications/notifications"
import { PlatformMediaScreen } from "@/features/platform/media-screen"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!

const MEDIA_ITEMS = [
  { kind: "directory", path: "ws-chen-studio", bytes: 0 },
  { kind: "directory", path: "ws-liu-shop", bytes: 0 },
  {
    kind: "file",
    path: "banner-01.png",
    bytes: 1_843_210,
    lastModified: "2026-09-10T08:24:00Z",
    publicUrl: "https://cdn-slice.example.test/banner-01.png",
  },
  {
    kind: "file",
    path: "render-042.webp",
    bytes: 642_111,
    lastModified: "2026-09-09T15:02:00Z",
    publicUrl: "https://cdn-slice.example.test/render-042.webp",
  },
  {
    kind: "file",
    path: "hero-video.mp4",
    bytes: 24_592_001,
    lastModified: "2026-09-08T11:40:00Z",
  },
]

const SUPPLIER_ITEMS = [
  { kind: "directory", path: "2026-q3-catalog", bytes: 0 },
  {
    kind: "file",
    path: "atlas-cover.psd",
    bytes: 88_120_400,
    lastModified: "2026-09-11T02:12:00Z",
  },
  {
    kind: "file",
    path: "intro.mp4",
    bytes: 15_008_882,
    lastModified: "2026-09-07T09:30:00Z",
  },
]

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

window.fetch = async (input) => {
  const url = typeof input === "string" ? input : String(input)
  if (url.startsWith("/api/admin/media/objects")) {
    return json({
      data: { accountId: "m1", items: MEDIA_ITEMS, prefix: "", nextCursor: null },
    })
  }
  if (url.startsWith("/api/admin/supplier-db-storage/objects")) {
    return json({ data: { items: SUPPLIER_ITEMS, prefix: "", nextCursor: null } })
  }
  if (url.startsWith("/api/notifications")) {
    return json({ data: { items: [], total: 0, unread: 0 } })
  }
  return json({ data: null })
}

const overview: IntegrationCredentialsOverview = {
  ai_default_model: "",
  ai_accounts: [],
  media_accounts: [
    {
      id: "s3_transit",
      label: "中转桶",
      role: "transit",
      provider: "cloudflare",
      ref_id: "s3_transit",
      configured: true,
      active: true,
      endpoint: "https://r2.example.test",
      region: "auto",
      bucket: "podhub-transit",
      key_prefix: "",
      public_base_url: "https://transit.podhub.si",
      force_path_style: true,
    },
    {
      id: "s3_assets",
      label: "素材库桶",
      role: "assets",
      provider: "cloudflare",
      ref_id: "s3_assets",
      configured: true,
      active: true,
      endpoint: "https://r2.example.test",
      region: "auto",
      bucket: "podhub-assets",
      key_prefix: "",
      public_base_url: "https://assets.podhub.si",
      force_path_style: true,
    },
  ],
}

const tab = new URLSearchParams(location.search).get("tab")

const root = createRoot(fixture)
flushSync(() =>
  root.render(
    <NotificationsProvider>
      <Toaster />
      <PlatformMediaScreen
        initialOverview={overview}
        defaultTab={tab === "assets" || tab === "private" ? tab : "transit"}
      />
    </NotificationsProvider>,
  ),
)
