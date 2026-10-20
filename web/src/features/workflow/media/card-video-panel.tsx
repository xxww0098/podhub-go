import { Film, RefreshCw, Trash2, Upload } from "lucide-react"
import type {
  WorkflowCategoryVideo,
  WorkflowPendingVideo,
  WorkflowVideoMetadata,
} from "@/bindings/commands"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatBytes } from "@/lib/format"
import { cn } from "@/lib/utils"

export type VideoActionPhase = "idle" | "selecting" | "uploading"

export type PendingVideoStatus = "pending" | "uploading" | "certifying" | "failed"

export type PendingVideoItem = WorkflowPendingVideo & {
  status: PendingVideoStatus
  error?: string
  /** Live byte progress while transferring or certifying (from workflow-media-progress). */
  progress?: { sent: number; total: number }
}

function pendingVideoBusy(status: PendingVideoStatus | "uploaded"): boolean {
  return status === "uploading" || status === "certifying"
}

/** Row badge after the file name. Bytes at 100% is not "uploaded" — Cloud still has to ACK and certify. */
export function pendingVideoStatusLabel(
  status: PendingVideoStatus | "uploaded",
  progress?: PendingVideoItem["progress"],
): string {
  if (status === "uploaded") return "S3 已就绪"
  if (status === "failed") return "失败"
  if (status === "certifying") return "确认中"
  if (status === "uploading") {
    if (progress && progress.total > 0 && progress.sent >= progress.total) return "等待确认"
    return "上传中"
  }
  return "待上传"
}

function uploadVideosLabel(phase: VideoActionPhase, pendingVideos: PendingVideoItem[]): string {
  if (phase !== "uploading") return "上传视频"
  if (pendingVideos.some((video) => video.status === "certifying")) return "确认中"
  if (pendingVideos.some((video) => pendingVideoStatusLabel(video.status, video.progress) === "等待确认")) {
    return "等待确认"
  }
  return "上传中"
}

export function CardVideoPanel({
  videos,
  pendingVideos,
  poolVideos,
  phase,
  disabled,
  onPickVideos,
  onPickPoolVideo,
  onUploadVideos,
  uploadDisabled,
  onRemoveVideo,
  onRemovePendingVideo,
}: {
  videos: WorkflowVideoMetadata[]
  pendingVideos: PendingVideoItem[]
  /** Platform video pool for this card's category. Empty until an L3 leaf is picked. */
  poolVideos: WorkflowCategoryVideo[]
  phase: VideoActionPhase
  disabled: boolean
  onPickVideos: () => void
  onPickPoolVideo: (video: WorkflowCategoryVideo) => void
  onUploadVideos: () => void
  /** A new card needs its required fields before it has a destination for video uploads. */
  uploadDisabled: boolean
  onRemoveVideo: (video: WorkflowVideoMetadata) => void
  onRemovePendingVideo: (assetHandle: string) => void
}) {
  const busy = phase !== "idle"
  const total = videos.length + pendingVideos.length
  const pickDisabled = disabled || busy || total >= 15
  let pickLabel = "选择视频"
  if (total) pickLabel = "继续选择视频"
  if (phase === "selecting") pickLabel = "正在读取"

  return (
    <section
      className="relative flex h-full min-h-0 flex-col"
      aria-label="商品视频"
    >
      <header className="shrink-0 px-5 pt-5 pb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">商品视频</h3>
          <Badge variant="code">{total}/15</Badge>
        </div>
        <p className="mt-1.5 text-meta text-muted-foreground">
          可选 · MP4/MOV · 8 秒–5 分钟 · ≤100 MB
        </p>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto border-t border-border px-5 py-4" aria-live="polite">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-full"
          disabled={pickDisabled}
          onClick={onPickVideos}
        >
          {phase === "selecting" ? <RefreshCw className="animate-spin" /> : <Upload />}
          {pickLabel}
        </Button>
        <Select
          value={null}
          disabled={pickDisabled}
          onValueChange={(next) => {
            const hit = poolVideos.find((video) => video.video_id === next)
            if (hit) onPickPoolVideo(hit)
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="从视频池选">{() => "从视频池选"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {poolVideos.length === 0 ? (
              <SelectItem value="__empty" disabled>
                该类目暂无视频池内容
              </SelectItem>
            ) : (
              poolVideos.map((video) => (
                <SelectItem key={video.video_id} value={video.video_id}>
                  {`${video.name} · ${Math.round(video.duration_ms / 1000)} 秒`}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
        {pendingVideos.length ? (
          <div className="grid gap-3">
            <span className="text-meta font-medium">待上传 · {pendingVideos.length}</span>
            <p className="text-meta text-muted-foreground">
              文件只保留在本机；填写必填项后，点击“上传视频”才会上传到 S3。
            </p>
            <Button
              type="button"
              size="sm"
              className="w-full"
              disabled={disabled || busy || uploadDisabled}
              onClick={onUploadVideos}
            >
              {phase === "uploading" ? <RefreshCw className="animate-spin" /> : <Upload />}
              {uploadVideosLabel(phase, pendingVideos)}
            </Button>
            {pendingVideos.map((video) => (
              <VideoRow
                key={video.asset_handle}
                video={video.metadata}
                status={video.status}
                error={video.error}
                progress={video.progress}
                disabled={disabled || pendingVideoBusy(video.status)}
                onRemove={() => onRemovePendingVideo(video.asset_handle)}
              />
            ))}
          </div>
        ) : null}

        {videos.length ? (
          <div className="grid gap-1.5">
            <p className="text-meta font-medium">已上传 · {videos.length}</p>
            {videos.map((video, index) => (
              <VideoRow
                key={video.content_hash ?? video.public_url ?? `${video.file_name}-${index}`}
                video={video}
                status="uploaded"
                disabled={disabled || busy}
                onRemove={() => onRemoveVideo(video)}
              />
            ))}
          </div>
        ) : null}

        {!pendingVideos.length && !videos.length ? (
          <p className="px-1 py-2 text-meta leading-5 text-muted-foreground">
            点击“选择视频”加入 MP4/MOV 文件；不会自动上传。
          </p>
        ) : null}
      </div>
    </section>
  )
}

function VideoRow({
  video,
  status,
  error,
  progress,
  disabled,
  onRemove,
}: {
  video: WorkflowVideoMetadata
  status: PendingVideoItem["status"] | "uploaded"
  error?: string
  progress?: PendingVideoItem["progress"]
  disabled: boolean
  onRemove: () => void
}) {
  const statusLabel = pendingVideoStatusLabel(status, progress)
  const transferring = pendingVideoBusy(status)
  return (
    <article className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-card px-2 py-1.5">
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
        {transferring ? <RefreshCw className="size-3 animate-spin" /> : <Film className="size-3" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <p className="truncate text-meta font-medium" title={video.file_name}>{video.file_name}</p>
          <Badge variant={status === "failed" ? "destructive" : "outline"}>
            {statusLabel}
          </Badge>
        </div>
        <p
          className={cn("truncate text-meta text-muted-foreground", status === "failed" && "text-destructive")}
          title={error ?? video.public_url}
        >
          {error ?? formatVideoMeta(video)}
        </p>
        {transferring && progress && progress.total > 0 ? (
          <div className="mt-1 flex items-center gap-1.5">
            <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.sent}>
              <div
                className="h-full rounded-full bg-brand transition-[width] duration-200"
                style={{ width: `${Math.min(100, (progress.sent / progress.total) * 100)}%` }}
              />
            </div>
            <span className="shrink-0 font-mono text-meta tabular-nums text-muted-foreground">
              {formatBytes(progress.sent)} / {formatBytes(progress.total)}
            </span>
          </div>
        ) : null}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="size-7"
              disabled={disabled}
              aria-label={`移除视频 ${video.file_name}`}
              onClick={onRemove}
            />
          }
        >
          <Trash2 aria-hidden />
        </TooltipTrigger>
        <TooltipContent>{`移除视频 ${video.file_name}`}</TooltipContent>
      </Tooltip>
    </article>
  )
}

function formatVideoMeta(video: WorkflowVideoMetadata): string {
  const seconds = Math.round(video.duration_ms / 1000)
  // A pooled video is admitted by URL, so its byte length is only known after
  // the probe — "0.0 MB" would read as an empty file rather than "not measured".
  if (video.origin === "public_url" && video.size_bytes === 0) {
    return `视频池 · ${seconds} 秒`
  }
  const megabytes = video.size_bytes / (1024 * 1024)
  return `${megabytes >= 10 ? megabytes.toFixed(0) : megabytes.toFixed(1)} MB · ${seconds} 秒`
}
