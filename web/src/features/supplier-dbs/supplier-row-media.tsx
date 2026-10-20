/**
 * 行媒体区 — 图集多图 / PSD / 视频的上传、预览、排序与摘除。
 *
 * 上传先做有界 SHA，再领取短期匿名不可变 PUT，最后经认证服务端验证实际字节。
 * 只有确认返回的 URL 才能交给 `store.updateRow`；新素材附加须有同货源确认事实，
 * 行 CAS 与已有引用/回收语义不变。
 *
 * 实现取舍：
 * - **视频封面 = 用户手传**（`coverUrl` 独立字段）。不选首帧抽帧：抽帧要
 *   `<video>` + canvas，而 canvas 对跨源视频帧默认污染（桶未发 CORS 读头
 *   时 `toBlob` 直接拒），上传链路又要再走一遍 presign——两张失败面换一
 *   个装饰性封面不值。手传复用图集同一条图片管线，稳定可测。
 * - **拖拽 = 原生 HTML5 draggable**：仓库无既有 dnd 依赖，数组序 = 显示序。
 * - **缩略图降级**：`gallery[].url` 加载失败显示占位图标（onError 换底）。
 *
 * 错误纪律：本地校验/读取失败 → `notifyError`；presign/PUT/写行失败 →
 * `notifyLive` 常驻（带「重试」action）；503 STORAGE_NOT_CONFIGURED →
 * 入口置灰 + title 提示 + notifyLive「去配置」跳「平台管理 → 对象存储」。
 * 页面上没有任何内联错误块。
 */
import { useEffect, useRef, useState } from "react"
import {
  CircleAlert,
  Download,
  FileText,
  GripVertical,
  Image as ImageIcon,
  ImagePlus,
  Plus,
  Trash2,
  Video,
} from "lucide-react"

import { pickFiles } from "@/bindings/file-picker"
import type {
  SupplierDbGalleryItem,
  SupplierDbRow,
  SupplierDbUploadKind,
  UpsertSupplierDbRowRequest,
} from "@/bindings/http-supplier-dbs"
import { useOpenSettings } from "@/app/settings-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatBytes } from "@/lib/format"
import { commandErrorCode, errorMessage } from "@/lib/error-message"
import { readVideoDurationMs } from "@/lib/video-duration"
import {
  clearLive,
  notifyCommandError,
  notifyError,
  notifyLive,
  notifySuccess,
} from "@/lib/notify"
import { cn } from "@/lib/utils"

import {
  GALLERY_ACCEPT,
  PSD_ACCEPT,
  STORAGE_NOT_CONFIGURED_CODE,
  VIDEO_ACCEPT,
  isUploadAbort,
  uploadCountError,
  uploadFileError,
  useSupplierDbUpload,
} from "./supplier-db-upload"
import { supplierDbs, type SupplierDbsStore } from "./supplier-dbs-store"
import { commandFailure } from "./supplier-dbs-errors"

const STORAGE_NOTICE_ID = "supplier-db-storage-missing"
const STORAGE_HINT = "先在平台集成配置平台货源存储桶"

// ---------- 纯函数（可测） ----------

/** 拖动重排：把 `from` 摘出来插到 `to` 前；越界输入原样返回。 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= items.length ||
    to >= items.length
  ) {
    return [...items]
  }
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/** 点选封面：提到数组首位（首图即封面契约）。 */
export function promoteToCover<T>(items: readonly T[], index: number): T[] {
  return moveItem(items, index, 0)
}

/** `ms` → `m:ss`（视频列摘要）。 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0:00"
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}

/**
 * 媒体字段写行——复用 store 的 `updateRow`（整行 upsert + CAS），失败统一
 * `notifyCommandError` 一次性提示；返回是否写成功供调用方收尾 live notice。
 */
export async function saveRowMedia(
  store: SupplierDbsStore,
  sourceId: string,
  productId: string,
  patch: Partial<UpsertSupplierDbRowRequest>,
): Promise<boolean> {
  const result = await store.updateRow(sourceId, productId, patch)
  if (!result.ok) {
    notifyCommandError(commandFailure(result), "保存行失败")
    return false
  }
  return true
}

// ---------- 浏览器侧元数据探测 ----------

/**
 * 读图片真实宽高：`createImageBitmap` 优先（不解码到 DOM、快），退回
 * `<img>` + object URL。读不出即拒绝——`{w,h}` 是行内契约字段，不编。
 */
export function readImageSize(file: File): Promise<{ w: number; h: number }> {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(file).then((bitmap) => {
      const size = { w: bitmap.width, h: bitmap.height }
      bitmap.close()
      return size
    })
  }
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    return Promise.reject(new Error("当前环境无法读取图片尺寸"))
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ w: img.naturalWidth, h: img.naturalHeight })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("无法读取图片尺寸"))
    }
    img.src = url
  })
}

/**
 * 视频时长探测：解码器优先、MP4/MOV 的 `mvhd` 文件头兜底（两条腿都在
 * `@/lib/video-duration`）。15s 兜底超时；两条腿都读不出就拒绝上传，不写
 * `durationMs: 0` 的假数据。
 */
export async function probeVideoDurationMs(file: File): Promise<number> {
  const durationMs = await readVideoDurationMs(file)
  if (durationMs > 0) return durationMs
  throw new Error("无法读取视频时长")
}

// ---------- 提示组件 ----------

/**
 * 必要注释收敛成一个圆圈感叹号图标，悬停 / 聚焦出 tooltip，避免在面板里铺一排灰字。
 * 跨组件共享：行媒体区与整个行面板都用它承载字段格式与契约说明。
 */
export function FieldNote({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={text}
            data-field-note=""
            className="inline-flex shrink-0 cursor-help items-center text-faint-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-3.5"
          >
            <CircleAlert aria-hidden />
          </button>
        }
      />
      <TooltipContent side="top">{text}</TooltipContent>
    </Tooltip>
  )
}

// ---------- 组件 ----------

/** 上传入口钮：置灰态需要 hover 出 title，disabled 按钮本身不冒指针事件——包一层 span。 */
function UploadButton({
  label,
  disabled,
  blocked,
  busy,
  onClick,
}: {
  label: string
  disabled?: boolean
  blocked: boolean
  busy: boolean
  onClick: () => void
}) {
  const off = disabled || blocked || busy
  return (
    <span title={blocked ? STORAGE_HINT : undefined} className="inline-flex">
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={off}
        className="cursor-pointer"
        onClick={onClick}
      >
        {busy ? <Spinner data-icon="inline-start" /> : <Plus aria-hidden data-icon="inline-start" />}
        {label}
      </Button>
    </span>
  )
}

function MediaGroup({
  name,
  label,
  icon,
  requirement,
  action,
  children,
}: {
  /** data 属性用的固定名（测试锚点），不含计数。 */
  name: string
  label: string
  icon: React.ReactNode
  /** 上传契约：图集必传，PSD / 视频选传。 */
  requirement: "required" | "optional"
  action: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div
      data-supplier-row-media={name}
      className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-muted/20 p-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-compact font-medium text-muted-foreground">
          <span aria-hidden className="text-faint-foreground [&_svg]:size-3.5">
            {icon}
          </span>
          {label}
          {requirement === "required" ? (
            <Badge variant="brand">必传</Badge>
          ) : (
            <Badge variant="outline">选传</Badge>
          )}
        </span>
        {action}
      </div>
      {children}
    </div>
  )
}

export function SupplierRowMedia({
  row,
  store = supplierDbs,
}: {
  row: SupplierDbRow
  /** 测试注入内存 store；缺省走生产单例（行页面不传 store 的历史包袱）。 */
  store?: SupplierDbsStore
}) {
  const openSettings = useOpenSettings()
  const uploader = useSupplierDbUpload(row.sourceId, {
    presign: store.presignUpload,
  })
  /** 服务端 503 之后置灰全部上传入口（本会话内记住，重试无意义）。 */
  const [storageBlocked, setStorageBlocked] = useState(false)
  /** 拖放排序的源下标 / 目标下标（仅渲染期 hover 反馈用）。 */
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  /** 保存期防抖：结构变更按泳道在途（上传并发已在 uploader.busyFor 拦）。 */
  const [savingLane, setSavingLane] = useState<SupplierDbUploadKind | null>(null)
  const noticeSeq = useRef(0)
  const uploadGeneration = useRef(0)
  useEffect(() => {
    uploadGeneration.current += 1
    return () => { uploadGeneration.current += 1; uploader.cancelAll() }
  }, [row.sourceId, row.productId, uploader.cancelAll])

  /** 取 store 里该行的最新媒体数组——并发上传后避免拿旧数组覆盖。 */
  const latestRow = (): SupplierDbRow =>
    store
      .getState()
      .details[row.sourceId]?.detail?.rows.find(
        (item) => item.productId === row.productId,
      ) ?? row

  const blocked = storageBlocked
  /** 泳道忙：该道的上传在途或结构写在途；其他泳道的入口不跟着转。 */
  const laneBusy = (lane: SupplierDbUploadKind) =>
    savingLane === lane || uploader.busyFor(lane)

  // ---------- notify 纪律 ----------

  /** 503 → 置灰 + 常驻「去配置」（settings 路由存在：平台管理 → 对象存储）。 */
  const surfaceStorageMissing = (reason?: unknown) => {
    setStorageBlocked(true)
    notifyLive({
      id: STORAGE_NOTICE_ID,
      type: "error",
      reason,
      title: STORAGE_HINT,
      description: "平台货源文件走专用 R2 桶，配置在「平台管理 → 对象存储」。",
      action: {
        label: "去配置",
        onClick: () => openSettings("media"),
      },
    })
  }

  /**
   * 一次上传的完整生命周期：进度 live notice → presign → 直传 → 写行 → 收尾。
   * `patch` 把 `publicUrl` 合成写行 patch；返回是否成功。
   */
  const runUpload = async (
    file: File,
    kind: SupplierDbUploadKind,
    patch: (
      publicUrl: string,
      current: SupplierDbRow,
    ) => Partial<UpsertSupplierDbRowRequest>,
    lane: SupplierDbUploadKind = kind,
  ): Promise<boolean> => {
    const generation = uploadGeneration.current
    const noticeId = `supplier-db-upload:${row.productId}:${++noticeSeq.current}`
    notifyLive({
      id: noticeId,
      type: "loading",
      title: `正在上传 ${file.name}`,
      description: formatBytes(file.size),
    })
    try {
      const result = await uploader.upload({
        kind,
        file,
        lane,
        onProgress: (p) => {
          const percent = p.total > 0 ? Math.floor((p.loaded / p.total) * 100) : 0
          const rate = p.bytesPerSec > 0 ? `${(p.bytesPerSec / 1_000_000).toFixed(1)} MB/s` : ""
          const eta = Number.isFinite(p.etaSec) && p.etaSec > 0 && p.etaSec < 24 * 3600
            ? `剩余 ${Math.max(1, Math.round(p.etaSec))} 秒` : ""
          notifyLive({
            id: noticeId,
            type: "loading",
            title: p.phase === "hash" ? `正在校验 ${file.name}` : `正在上传 ${file.name}`,
            description: [formatBytes(file.size), `${percent}%`, rate, eta].filter(Boolean).join(" · "),
            action: { label: "取消", onClick: () => uploader.cancelAll() },
          })
        },
      })
      if (generation !== uploadGeneration.current) throw new DOMException("已取消", "AbortError")
      const saved = await saveRowMedia(
        store,
        row.sourceId,
        row.productId,
        patch(result.publicUrl, latestRow()),
      )
      clearLive(noticeId)
      if (saved && generation === uploadGeneration.current) notifySuccess(`已上传 ${file.name}`)
      return saved
    } catch (reason) {
      if (isUploadAbort(reason)) {
        clearLive(noticeId)
        return false
      }
      if (commandErrorCode(reason) === STORAGE_NOT_CONFIGURED_CODE) {
        clearLive(noticeId)
        surfaceStorageMissing(reason)
        return false
      }
      notifyLive({
        id: noticeId,
        type: "error",
        reason,
        title: `上传失败：${file.name}`,
        description: errorMessage(reason, "上传失败"),
        action: {
          label: "重试",
          onClick: () => void runUpload(file, kind, patch, lane),
        },
      })
      return false
    }
  }

  // ---------- 图集 ----------

  const pickGallery = async () => {
    const full = uploadCountError("gallery", latestRow().gallery.length)
    if (full) {
      notifyError(full)
      return
    }
    const files = await pickFiles(GALLERY_ACCEPT, true)
    // 逐张串行：追加序 = 点选序，也避开并发写行的 CAS 互踩。
    // 数组上限按实时行数判断，超过即停（服务端 normalize_row 同值复核）。
    for (const file of files) {
      const cap = uploadCountError("gallery", latestRow().gallery.length)
      if (cap) {
        notifyError(cap)
        return
      }
      await uploadGalleryFile(file)
    }
  }

  const uploadGalleryFile = async (file: File) => {
    const problem = uploadFileError("gallery", file)
    if (problem) {
      notifyError(problem)
      return
    }
    let dims: { w: number; h: number }
    try {
      dims = await readImageSize(file)
    } catch (reason) {
      notifyError(errorMessage(reason, `无法读取「${file.name}」的图片尺寸`), { reason })
      return
    }
    await runUpload(file, "gallery", (publicUrl, current) => ({
      gallery: [
        ...current.gallery,
        { url: publicUrl, w: dims.w, h: dims.h },
      ],
    }))
  }

  const applyGallery = async (next: SupplierDbGalleryItem[]) => {
    setSavingLane("gallery")
    await saveRowMedia(store, row.sourceId, row.productId, { gallery: next })
    setSavingLane(null)
  }

  // ---------- PSD ----------

  const pickPsd = async (replaceIndex: number | null = null) => {
    if (replaceIndex === null) {
      const full = uploadCountError("psd", latestRow().psd.length)
      if (full) {
        notifyError(full)
        return
      }
    }
    const [file] = await pickFiles(PSD_ACCEPT)
    if (!file) return
    const problem = uploadFileError("psd", file)
    if (problem) {
      notifyError(problem)
      return
    }
    await runUpload(file, "psd", (publicUrl, current) => {
      const item = { url: publicUrl, name: file.name, bytes: file.size }
      const psd =
        replaceIndex === null
          ? [...current.psd, item]
          : current.psd.map((old, index) => (index === replaceIndex ? item : old))
      return { psd }
    })
  }

  const removePsd = async (index: number) => {
    setSavingLane("psd")
    await saveRowMedia(store, row.sourceId, row.productId, {
      psd: latestRow().psd.filter((_, i) => i !== index),
    })
    setSavingLane(null)
  }

  // ---------- 视频 ----------

  const pickVideo = async () => {
    const full = uploadCountError("video", latestRow().productVideos.length)
    if (full) {
      notifyError(full)
      return
    }
    const [file] = await pickFiles(VIDEO_ACCEPT)
    if (!file) return
    const problem = uploadFileError("video", file)
    if (problem) {
      notifyError(problem)
      return
    }
    let durationMs: number
    try {
      durationMs = await probeVideoDurationMs(file)
    } catch (reason) {
      notifyError(errorMessage(reason, `无法读取「${file.name}」的视频时长`), { reason })
      return
    }
    await runUpload(file, "video", (publicUrl, current) => ({
      productVideos: [
        ...current.productVideos,
        { url: publicUrl, coverUrl: "", durationMs },
      ],
    }))
  }

  /** 封面图走同一条图片管线（kind=gallery 的白名单正好就是图片扩展名）。 */
  const pickVideoCover = async (index: number) => {
    const [file] = await pickFiles(GALLERY_ACCEPT)
    if (!file) return
    const problem = uploadFileError("gallery", file)
    if (problem) {
      notifyError(problem)
      return
    }
    await runUpload(
      file,
      "gallery",
      (publicUrl, current) => ({
        productVideos: current.productVideos.map((video, i) =>
          i === index ? { ...video, coverUrl: publicUrl } : video,
        ),
      }),
      // kind=gallery 复用图片白名单，但忙碌归视频道——封面动作不该让
      // 图集按钮转圈。
      "video",
    )
  }

  const removeVideo = async (index: number) => {
    setSavingLane("video")
    await saveRowMedia(store, row.sourceId, row.productId, {
      productVideos: latestRow().productVideos.filter((_, i) => i !== index),
    })
    setSavingLane(null)
  }

  // ---------- 渲染 ----------

  const gallery = row.gallery
  const psd = row.psd
  const videos = row.productVideos

  return (
    <div className="flex flex-col gap-2" data-supplier-row-media-root="">
      <MediaGroup
        name="图集"
        label={`图集${gallery.length ? ` · ${gallery.length}` : ""}`}
        icon={<ImageIcon />}
        requirement="required"
        action={
          <UploadButton
            label="上传图片"
            blocked={blocked}
            busy={laneBusy("gallery")}
            onClick={() => void pickGallery()}
          />
        }
      >
        {gallery.length ? (
          <div className="flex flex-wrap gap-1.5" data-supplier-gallery-grid="">
            {gallery.map((item, index) => (
              <div
                key={`${item.url}-${index}`}
                draggable={!laneBusy("gallery")}
                onDragStart={(event) => {
                  setDragIndex(index)
                  event.dataTransfer.effectAllowed = "move"
                }}
                onDragOver={(event) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = "move"
                  setDropIndex(index)
                }}
                onDragLeave={() =>
                  setDropIndex((current) => (current === index ? null : current))
                }
                onDrop={(event) => {
                  event.preventDefault()
                  const from = dragIndex
                  setDragIndex(null)
                  setDropIndex(null)
                  if (from !== null && from !== index) {
                    void applyGallery(moveItem(latestRow().gallery, from, index))
                  }
                }}
                onDragEnd={() => {
                  setDragIndex(null)
                  setDropIndex(null)
                }}
                role="button"
                tabIndex={0}
                title={index === 0 ? "封面（可拖动排序，Alt+←→ 移动）" : "点击设为封面 · 可拖动排序 · Alt+←→ 移动"}
                aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Enter"
                className={cn(
                  "group/thumb relative size-16 shrink-0 cursor-pointer overflow-hidden rounded-lg border focus-visible:outline-2 focus-visible:outline-ring",
                  index === 0 ? "border-brand" : "border-border",
                  dropIndex === index && dragIndex !== index
                    ? "ring-2 ring-ring"
                    : "",
                  dragIndex === index ? "opacity-50" : "",
                )}
                onClick={() => {
                  if (index !== 0) {
                    void applyGallery(promoteToCover(latestRow().gallery, index))
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && index !== 0) {
                    event.preventDefault()
                    void applyGallery(promoteToCover(latestRow().gallery, index))
                    return
                  }
                  // Keyboard reorder equivalent of drag: Alt+←/→ (or ↑/↓) moves
                  // the focused item one slot. Plain arrows stay free.
                  if (
                    event.altKey
                    && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
                  ) {
                    event.preventDefault()
                    const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1
                    const target = index + delta
                    if (target >= 0 && target < gallery.length) {
                      void applyGallery(moveItem(latestRow().gallery, index, target))
                    }
                  }
                }}
                data-supplier-gallery-item=""
                data-cover={index === 0 ? "" : undefined}
              >
                <img
                  src={item.url}
                  alt={index === 0 ? "封面" : `图集第 ${index + 1} 张`}
                  loading="lazy"
                  decoding="async"
                  className="size-full object-cover"
                  onError={(event) => {
                    // 缩略图降级：图挂了留占位底，不炸整个网格。
                    event.currentTarget.style.display = "none"
                  }}
                />
                {index === 0 ? (
                  <span className="absolute bottom-0.5 left-0.5 rounded bg-brand/90 px-1 py-px text-meta font-medium text-brand-foreground">
                    封面
                  </span>
                ) : null}
                <button
                  type="button"
                  aria-label={`删除第 ${index + 1} 张图片`}
                  disabled={laneBusy("gallery")}
                  className="absolute top-0.5 right-0.5 grid size-4 cursor-pointer place-items-center rounded bg-black/55 text-white opacity-70 transition-opacity hover:opacity-100 group-hover/thumb:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation()
                    void applyGallery(
                      latestRow().gallery.filter((_, i) => i !== index),
                    )
                  }}
                >
                  <Trash2 aria-hidden className="size-2.5" />
                </button>
                <GripVertical
                  aria-hidden
                  className="pointer-events-none absolute top-0.5 left-0.5 size-3 text-white opacity-0 drop-shadow group-hover/thumb:opacity-90"
                />
              </div>
            ))}
          </div>
        ) : (
          <p className="flex items-center gap-1.5 text-meta text-faint-foreground">
            <span>未上传</span>
            <FieldNote text="jpg/jpeg/png/webp ≤20MB，首图即封面，可拖动排序" />
          </p>
        )}
      </MediaGroup>

      <MediaGroup
        name="PSD"
        label={`PSD${psd.length ? ` · ${psd.length}` : ""}`}
        icon={<FileText />}
        requirement="optional"
        action={
          <UploadButton
            label="上传 PSD"
            blocked={blocked}
            busy={laneBusy("psd")}
            onClick={() => void pickPsd()}
          />
        }
      >
        {psd.length ? (
          <ul className="flex flex-col gap-1">
            {psd.map((file, index) => (
              <li
                key={`${file.url}-${index}`}
                className="flex items-center gap-2 text-compact"
                data-supplier-psd-item=""
              >
                <FileText aria-hidden className="size-3.5 shrink-0 text-faint-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                  {file.name}
                </span>
                <span className="shrink-0 font-mono text-meta text-faint-foreground tabular-nums">
                  {formatBytes(file.bytes)}
                </span>
                <a
                  href={file.url}
                  download={file.name}
                  aria-label={`下载 ${file.name}`}
                  className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 text-meta text-brand-ink hover:underline"
                >
                  <Download aria-hidden className="size-3" />
                  下载
                </a>
                <button
                  type="button"
                  disabled={laneBusy("psd")}
                  className="shrink-0 cursor-pointer text-meta text-muted-foreground hover:text-foreground"
                  onClick={() => void pickPsd(index)}
                >
                  替换
                </button>
                <button
                  type="button"
                  aria-label={`删除 ${file.name}`}
                  disabled={laneBusy("psd")}
                  className="shrink-0 cursor-pointer text-meta text-muted-foreground hover:text-st-bad"
                  onClick={() => void removePsd(index)}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-1.5 text-meta text-faint-foreground">
            <span>未上传</span>
            <FieldNote text=".psd ≤500MB" />
          </p>
        )}
      </MediaGroup>

      <MediaGroup
        name="视频"
        label={`视频${videos.length ? ` · ${videos.length}` : ""}`}
        icon={<Video />}
        requirement="optional"
        action={
          <UploadButton
            label="上传视频"
            blocked={blocked}
            busy={laneBusy("video")}
            onClick={() => void pickVideo()}
          />
        }
      >
        {videos.length ? (
          <ul className="flex flex-col gap-1.5">
            {videos.map((video, index) => (
              <li
                key={`${video.url}-${index}`}
                className="flex items-center gap-2"
                data-supplier-video-item=""
              >
                {video.coverUrl ? (
                  <img
                    src={video.coverUrl}
                    alt="视频封面"
                    loading="lazy"
                    decoding="async"
                    className="size-10 shrink-0 rounded border border-border object-cover"
                  />
                ) : (
                  <span
                    aria-hidden
                    className="grid size-10 shrink-0 place-items-center rounded border border-dashed border-border bg-muted/40 text-faint-foreground"
                  >
                    <Video className="size-4" />
                  </span>
                )}
                <span className="shrink-0 font-mono text-meta text-muted-foreground tabular-nums">
                  {formatDurationMs(video.durationMs)}
                </span>
                <a
                  href={video.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`打开第 ${index + 1} 个视频`}
                  className="min-w-0 flex-1 cursor-pointer truncate text-meta text-brand-ink hover:underline"
                >
                  播放
                </a>
                <span
                  title={blocked ? STORAGE_HINT : "上传一张图作为封面"}
                  className="inline-flex shrink-0"
                >
                  <button
                    type="button"
                    disabled={laneBusy("video") || blocked}
                    className="inline-flex cursor-pointer items-center gap-0.5 text-meta text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                    onClick={() => void pickVideoCover(index)}
                  >
                    <ImagePlus aria-hidden className="size-3" />
                    {video.coverUrl ? "换封面" : "设封面"}
                  </button>
                </span>
                <button
                  type="button"
                  aria-label={`删除第 ${index + 1} 个视频`}
                  disabled={laneBusy("video")}
                  className="shrink-0 cursor-pointer text-meta text-muted-foreground hover:text-st-bad"
                  onClick={() => void removeVideo(index)}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-1.5 text-meta text-faint-foreground">
            <span>未上传</span>
            <FieldNote text="mp4/mov ≤200MB" />
          </p>
        )}
      </MediaGroup>
    </div>
  )
}
