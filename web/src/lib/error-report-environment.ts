import { productVersion } from "@/lib/product-version"
import { isUuid } from "@/lib/utils"

/** Counts and phases only. URLs, object keys, file names and hashes never enter. */
export type ErrorMediaSummary = {
  stage?: string
  media?: string
  imageTotal?: number
  imageCompleted?: number
  phases?: string
  videos?: number
  cover?: "present" | "absent"
  objects?: string
  blockedRows?: number
}

export type ErrorReportContext = {
  stage?: string
  rowId?: string
  cardId?: string
  requestId?: string
  apiPath?: string
  apiStatus?: number
  refusalReason?: string
  media?: ErrorMediaSummary
}

export type ErrorReportEnvironment = ErrorReportContext & {
  appVersion?: string
  userId?: string
  workspaceId?: string
  userAgent?: string
}

const VERSION = /^\d+\.\d+\.\d+$/
const ROW_STAGE = new Set(["awaiting_content", "recognizing", "recognition_failed", "rendering", "uploading", "media_failed", "candidates_pending", "build_stale", "fields_invalid", "ready_to_publish", "queued", "submitting", "outcome_unknown", "accepted", "publish_rejected", "operator_attested"])
const MEDIA_PHASE = new Set(["pending", "rendering", "rendered", "uploading", "ready", "failed"])
const IMAGE_PHASE = new Set(["rendered", "uploading", "public_ready", "failed"])

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : undefined
}

/** Printable ASCII, no URL, credential or query. A bad agent is omitted, not stored. */
export function safeUserAgent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const text = value.replace(/[^\x20-\x7e]/g, "").slice(0, 180)
  if (!text || /:\/\/|bearer|token|x-amz|secret|password|=/i.test(text)) return undefined
  return text
}

function uuid(value: unknown): string | undefined {
  return typeof value === "string" && isUuid(value) ? value.toLowerCase() : undefined
}

/** Session UUIDs pushed from the account overview. Email and workspace name stay out. */
let reportIdentity: { userId?: string; workspaceId?: string } = {}

export function setErrorReportIdentity(next: { userId?: string; workspaceId?: string } | null): void {
  if (!next) { reportIdentity = {}; return }
  const userId = uuid(next.userId)
  const workspaceId = uuid(next.workspaceId)
  reportIdentity = { ...(userId ? { userId } : {}), ...(workspaceId ? { workspaceId } : {}) }
}

export function collectErrorEnvironment(): Pick<ErrorReportEnvironment, "appVersion" | "userId" | "workspaceId" | "userAgent"> {
  const version = productVersion()
  const userAgent = safeUserAgent(typeof navigator === "undefined" ? undefined : navigator.userAgent)
  return {
    ...(VERSION.test(version) && version.length <= 32 ? { appVersion: version } : {}),
    ...reportIdentity,
    ...(userAgent ? { userAgent } : {}),
  }
}

type MediaSource = {
  stage?: unknown
  media?: unknown
  image_total?: unknown
  image_completed?: unknown
  images?: readonly { phase?: unknown; object_key?: unknown }[]
  product_videos?: readonly unknown[]
  video_cover?: unknown
}

/** One row's image/video/object phases. The key and the public URL stay on the row. */
export function listingMediaSummary(lifecycle: MediaSource | undefined, blockedRows?: number): ErrorMediaSummary | undefined {
  if (!lifecycle) return blockedRows === undefined ? undefined : { blockedRows }
  const phases = new Map<string, number>()
  let bound = 0
  let unbound = 0
  for (const image of lifecycle.images ?? []) {
    if (typeof image.phase !== "string" || !IMAGE_PHASE.has(image.phase)) continue
    phases.set(image.phase, (phases.get(image.phase) ?? 0) + 1)
    if (typeof image.object_key === "string" && image.object_key.length > 0) bound++
    else unbound++
  }
  const summary: ErrorMediaSummary = {}
  if (typeof lifecycle.stage === "string" && ROW_STAGE.has(lifecycle.stage)) summary.stage = lifecycle.stage
  if (typeof lifecycle.media === "string" && MEDIA_PHASE.has(lifecycle.media)) summary.media = lifecycle.media
  const imageTotal = count(lifecycle.image_total)
  const imageCompleted = count(lifecycle.image_completed)
  if (imageTotal !== undefined) summary.imageTotal = imageTotal
  if (imageCompleted !== undefined) summary.imageCompleted = imageCompleted
  if (phases.size) summary.phases = [...phases].map(([phase, total]) => `${phase}:${total}`).join(",")
  const videos = count(lifecycle.product_videos?.length ?? 0)
  if (videos !== undefined) summary.videos = videos
  summary.cover = lifecycle.video_cover ? "present" : "absent"
  if ((lifecycle.images?.length ?? 0) > 0) summary.objects = `bound:${bound},unbound:${unbound}`
  const rows = count(blockedRows)
  if (rows !== undefined) summary.blockedRows = rows
  return summary
}
