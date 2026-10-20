import { useEffect, useId, useRef, useState } from "react"
import { Camera, Crown, Loader2, ShieldCheck, UserRound, UsersRound } from "lucide-react"

import { cn } from "@/lib/utils"
import { notifyCommandError } from "@/lib/notify"
import { onSessionInvalidated } from "@/lib/session-cache"

/* Stable identity colors, independent of selection and status colors. */
const WORKSPACE_PALETTE = [
  { bg: "#f0d8d5", fg: "#81463f" },
  { bg: "#f3dfb5", fg: "#775323" },
  { bg: "#dfe5c7", fg: "#536036" },
  { bg: "#cee4dc", fg: "#35685b" },
  { bg: "#d5e2f0", fg: "#3e5d83" },
  { bg: "#e5daf0", fg: "#6a4f82" },
] as const

export type IdentityKind = "user" | "workspace"

export function identityMarkAction(kind: IdentityKind): string {
  return kind === "user" ? "更换头像" : "更换工作空间头像"
}

export async function fileToSquareJpeg(file: File, size = 256): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = document.createElement("canvas")
    canvas.width = size
    canvas.height = size
    const context = canvas.getContext("2d")
    if (!context) throw new Error("无法处理图片")
    const side = Math.min(bitmap.width, bitmap.height)
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size)
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((next) => next ? resolve(next) : reject(new Error("无法导出 JPEG")), "image/jpeg", 0.85)
    })
    if (blob.size === 0 || blob.size > 256 * 1024) throw new Error("图片须为不超过 256KB 的 JPEG")
    return blob
  } finally {
    bitmap.close()
  }
}

export function IdentityMark({
  kind,
  workspaceId,
  workspaceIds,
  role,
  imageUrl,
  editable,
  disabled,
  inputId,
  onPick,
  className,
}: {
  kind: IdentityKind
  name: string
  workspaceId?: number
  workspaceIds?: readonly number[]
  role?: string | null
  imageUrl?: string
  editable?: boolean
  disabled?: boolean
  inputId?: string
  onPick?: (image: Blob, signal?: AbortSignal) => void | Promise<void>
  className?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const pickController = useRef<AbortController | null>(null)
  useEffect(() => () => { pickController.current?.abort() }, [kind, workspaceId])
  const generatedId = useId()
  const fileId = inputId ?? generatedId
  const [busy, setBusy] = useState(false)
  // Account-local order avoids collisions from unrelated global workspace IDs.
  const workspaceIndex = new Set(workspaceIds?.filter((id) => id < (workspaceId ?? 0))).size
  const hue = (workspaceIndex * 137.508) % 360
  const palette = WORKSPACE_PALETTE[workspaceIndex] ?? {
    bg: `hsl(${hue} 45% 88%)`, fg: `hsl(${hue} 35% 32%)`,
  }
  const RoleIcon = role === "super_admin" ? Crown : role === "admin" ? ShieldCheck : UserRound
  const rounded = kind === "user" ? "rounded-full" : "rounded-md"
  const action = identityMarkAction(kind)
  const fallbackStyle =
    kind === "workspace"
      ? ({ "--mark-bg": palette.bg, "--mark-fg": palette.fg } as React.CSSProperties)
      : undefined

  const face = (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex items-center justify-center overflow-hidden text-xs font-semibold tracking-tight",
        kind === "user" && (role === "super_admin"
          ? "bg-primary text-st-attest-ink"
          : role === "admin"
            ? "bg-brand-soft text-brand-ink"
            : "bg-muted text-muted-foreground"),
        kind === "workspace" && "bg-(--mark-bg) text-(--mark-fg)",
        rounded,
        className
      )}
      style={fallbackStyle}
    >
      {imageUrl ? (
        <img src={imageUrl} alt="" className="size-full object-cover" />
      ) : kind === "user" ? (
        <RoleIcon className="size-[62%]" strokeWidth={1.8} />
      ) : (
        <UsersRound className="size-[62%]" strokeWidth={1.8} />
      )}
      {editable ? (
        <span
          className={cn(
            "absolute inset-0 bg-foreground/0 transition-colors duration-150",
            "group-hover/mark:bg-foreground/45 group-focus-visible/mark:bg-foreground/45",
            (disabled || busy) && "group-hover/mark:bg-foreground/0"
          )}
        />
      ) : null}
    </span>
  )

  if (!editable) {
    return face
  }

  async function pick(file: File | undefined) {
    if (!file || !onPick) return
    const controller = new AbortController()
    pickController.current?.abort()
    pickController.current = controller
    const release = onSessionInvalidated(() => controller.abort())
    setBusy(true)
    try {
      let image: Blob
      try {
        image = await fileToSquareJpeg(file)
      } catch {
        if (!controller.signal.aborted) notifyCommandError(new Error("无法处理图片"), "无法处理图片，请选择其他图片")
        return
      }
      if (!controller.signal.aborted) await onPick(image, controller.signal)
    } finally {
      release()
      if (pickController.current === controller) {
        pickController.current = null
        setBusy(false)
        if (inputRef.current) inputRef.current.value = ""
      }
    }
  }

  return (
    <span className="relative inline-flex shrink-0">
      <button
        type="button"
        aria-label={action}
        disabled={disabled || busy}
        className={cn(
          "group/mark relative inline-flex cursor-pointer rounded-inherit outline-none",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          "disabled:cursor-not-allowed"
        )}
        onClick={() => inputRef.current?.click()}
      >
        {face}
        <span
          aria-hidden
          className={cn(
            "absolute -right-0.5 -bottom-0.5 grid size-4 place-items-center rounded-full",
            "bg-card text-foreground ring-1 ring-border",
            (disabled || busy) && "opacity-70"
          )}
        >
          {busy ? (
            <Loader2 className="size-2.5 animate-spin" />
          ) : (
            <Camera className="size-2.5" strokeWidth={2.25} />
          )}
        </span>
      </button>
      <input
        id={fileId}
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        disabled={disabled || busy}
        onChange={(event) => void pick(event.target.files?.[0])}
      />
    </span>
  )
}
