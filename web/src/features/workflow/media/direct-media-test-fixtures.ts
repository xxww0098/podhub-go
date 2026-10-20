import { route } from "@/api/routes"
import type { AccountOverview } from "@/bindings/commands"
import { invalidateAccountOverview, rememberAccountOverview } from "@/features/account/account-overview-cache"
import { forgetMediaObjects } from "./media-objects"
import type { DeliverMediaObjectRequest } from "./direct-media-types"
export const WORKSPACE = "550e8400-e29b-41d4-a716-446655440000"
export const DIGEST = "a12871fee210fb8619291eaea194581cbd2531e4b23759d225f6806923f63222"
export const OTHER = "0ce3940bebf2b22a5d2108ecf0c368a0541c7e3c45703f8540921b4eafc82947"
export const THIRD = "e77b9a9ae9e30b0dbdb6f510a264ef9de781501d7b6b92ae89eb059c5ab743db"
export const PUBLIC = "https://media.example.com"
export function activeWorkspace(uuid: string): AccountOverview {
  const workspace = { id: 7, uuid, name: "运营", plan: "pro", role: "owner", is_owned: true }
  return {
    session: { authenticated: true, email: "op@example.invalid", role: "user" },
    entitlement: {
      plan: "pro",
      features: { ai_relay: true, ocr: true, batch_listing: true, field_package: true },
      limits: {
        stores: 1, stores_used: 0, seats: 1, seats_used: 1,
        s3_upload_bytes_monthly: 0, s3_upload_bytes_used: 0,
        ai_tokens_monthly: 0, ai_tokens_used: 0, ai_calls_per_day: 0,
      },
    },
    active_workspace: workspace,
    workspaces: [workspace],
    account_mode: "owner",
    owned_count: 1,
    owned_limit: 3,
  }
}
export function fresh(): void { forgetMediaObjects(); invalidateAccountOverview(); rememberAccountOverview(activeWorkspace(WORKSPACE)) }
export function answer(digest = DIGEST, ext = "jpg", workspace = WORKSPACE) {
  const cls = ["mp4", "mov"].includes(ext) ? "videos" : "images"
  return { accountId: "env-media", workspaceUuid: workspace, storageRevision: 1,
    objectKey: `${cls}/teams/${workspace}/sha256/${digest}.${ext}`,
    publicUrl: `${PUBLIC}/${cls}/teams/${workspace}/sha256/${digest}.${ext}` }
}
export function image(digest = DIGEST, byteLength?: number): DeliverMediaObjectRequest {
  return { digest, extension: "jpg", contentType: "image/jpeg", byteLength,
    bytes: () => new Uint8Array(digest === OTHER ? [3, 4] : digest === THIRD ? [5] : [1, 2]) }
}
export type Call = { url: string; method: string; headers: Headers; body?: BodyInit | null; signal?: AbortSignal | null }
export function json(data: unknown, status = 200, code = "media_complete_missing"): Response {
  return new Response(JSON.stringify(status === 200 ? { data } : { code, message: "请重试" }), {
    status, headers: { "Content-Type": "application/json", "Retry-After": "0" },
  })
}
export function directHarness(options: {
  ready?: boolean; putStatuses?: number[]; completeStatuses?: number[];
  completeCode?: string; grantHeaders?: { content_type?: string; if_none_match?: string };
  intercept?: (call: Call) => Response | Promise<Response> | undefined;
} = {}) {
  const previous = globalThis.fetch
  const calls: Call[] = []
  let puts = 0, confirms = 0, grants = 0, nextBatch = 0
  let resolveHold: (() => void) | undefined, held: Promise<void> | undefined
  const fetcher: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const call: Call = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body, signal: init?.signal }
    calls.push(call)
    const override = options.intercept?.(call)
    if (override) return await override
    if (url.startsWith("https://s3.example.com/")) {
      if (call.method !== "PUT") throw new Error("anonymous PUT required")
      await held
      const status = options.putStatuses?.[puts++] ?? 200
      if (status === 0) throw new Error("SECRET signed URL transport detail")
      return new Response(status === 200 || status === 412 ? null : "<Error>SECRET</Error>", { status })
    }
    if (url === route("mediaUploadBatches")) {
      return json({ upload_batch: `${Date.now()}.uuid-${++nextBatch}.sig`, expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString() })
    }
    const match = url.match(new RegExp("objects/([a-f0-9]{64})/(jpg|png|mp4|mov)/(presign-batch|complete|probe)$|objects/(presign-batch)$"))
    if (!match || call.method !== "POST") throw new Error("No byte relay route: " + url)
    const body = call.body ? JSON.parse(String(call.body)) : {}
    // One object per batch presign, exactly as the transfer layer sends it.
    const item = Array.isArray(body.objects) ? body.objects[0] ?? {} : {}
    const digest = String(match[1] ?? item.digest ?? DIGEST)
    const ext = String(match[2] ?? item.extension ?? "jpg")
    const operation = match[3] ?? match[4]
    let target = answer(digest, ext)
    if (body.upload_batch && !["mp4", "mov"].includes(ext!)) {
      const [stamp, uuid] = String(body.upload_batch).split(".")
      const prefix = `uploads/2026-09-16/${stamp}-${uuid}/`
      target = { ...target, objectKey: prefix + target.objectKey, publicUrl: PUBLIC + "/" + prefix + target.objectKey }
    }
    const wire = { account_id: target.accountId, workspace_uuid: target.workspaceUuid, storage_revision: target.storageRevision,
      object_key: target.objectKey, public_url: target.publicUrl }
    if (operation === "probe") return json({ ...wire, exists: true })
    if (operation === "presign-batch") {
      grants++
      return json({ objects: [{ ...wire, transport: options.ready ? "ready" : "direct", upload_batch: body.upload_batch,
        ...(options.ready ? {} : { upload: { url: `https://s3.example.com/${target.objectKey}?X-Amz-Signature=secret-${grants}`,
          expires_at_ms: Date.now() + 600_000, headers: { content_type: ext === "jpg" ? "image/jpeg" : ext === "png" ? "image/png" : ext === "mov" ? "video/quicktime" : "video/mp4",
            if_none_match: "*", ...options.grantHeaders } }, upload_ticket: "ticket-" + grants }) }] })
    }
    return json({ ...wire, byte_length: body.byte_length, transport: "ready", deduplicated: false },
      options.completeStatuses?.[confirms++] ?? 200, options.completeCode)
  }
  globalThis.fetch = fetcher
  return { calls, hold() { held = new Promise(resolve => { resolveHold = resolve }) },
    release() { resolveHold?.(); held = undefined }, restore() { globalThis.fetch = previous; resolveHold?.() } }
}

/** Layer over a record() fixture; its restore() removes this test-only interception too. */
export function interceptMediaCompletion(reply: (body: Record<string, unknown>, url: string) => Response | undefined): void {
  const previous = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith("/complete")) {
      const overridden = reply(JSON.parse(String(init?.body)), url)
      if (overridden) return overridden
    }
    return previous(input, init)
  }
}
