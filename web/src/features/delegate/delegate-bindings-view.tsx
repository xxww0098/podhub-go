/**
 * 绑定管理视图：「店 × 商品」预绑厂家的增改停删 + 原图素材。
 *
 * 改绑走 `expectedRevision` CAS，409 = 绑定已被别处更新（提示刷新，不重试
 * 覆盖）；被在途单引用的绑定服务端拒删（409 原样提示）；绑定到无活跃成员
 * 的厂家按后端 `warning` 文案展示但不拦。原图上传走三步管线（见
 * delegate-upload.ts），≤500MB、jpg/png/webp/psd，前端预检省一次注定失败的
 * 往返。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { Ban, Paperclip, Pencil, Plus, RefreshCw, Trash2, UploadCloud } from "lucide-react"

import type {
  DelegateBinding,
  DelegateSource,
} from "./delegate-http"
import { delegateHttp } from "./delegate-http"
import {
  ASSET_ACCEPT,
  assetContentType,
  assetExtensionOf,
  assetFileError,
  formatInstantValue,
  isDelegateConflict,
  normalizedOfferId,
} from "./delegate-model"
import { uploadDelegateAsset } from "./delegate-upload"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { notifyCommandError, notifyError, notifySuccess } from "@/lib/notify"

export type DelegateBindingsViewProps = {
  storeId: string
  sources: DelegateSource[]
  /** 绑定变化信号（素材晋升会让 posting 行转 ready），屏级转发给列表。 */
  onChanged: () => void
}

export function DelegateBindingsView({
  storeId,
  sources,
  onChanged,
}: DelegateBindingsViewProps) {
  const [bindings, setBindings] = useState<DelegateBinding[]>([])
  const [loading, setLoading] = useState(false)
  const [editor, setEditor] = useState<
    { mode: "create" } | { mode: "edit"; binding: DelegateBinding } | null
  >(null)
  const [assetsFor, setAssetsFor] = useState<DelegateBinding | null>(null)
  const [deleting, setDeleting] = useState<DelegateBinding | null>(null)

  const reload = useCallback(async () => {
    if (!storeId) return
    setLoading(true)
    try {
      setBindings(await delegateHttp.listBindings(storeId))
    } catch (reason) {
      notifyCommandError(reason, "无法读取委托绑定")
    } finally {
      setLoading(false)
    }
  }, [storeId])

  useEffect(() => {
    void reload()
  }, [reload])

  async function toggleActive(binding: DelegateBinding) {
    try {
      await delegateHttp.patchBinding(binding.binding_id, {
        expected_revision: binding.revision,
        active: !binding.active,
      })
      await reload()
      onChanged()
    } catch (reason) {
      if (isDelegateConflict(reason)) {
        notifyError("绑定已被更新，请刷新后重试", { reason })
        await reload()
      } else {
        notifyCommandError(reason, binding.active ? "停用失败" : "启用失败")
      }
    }
  }

  async function removeBinding(binding: DelegateBinding) {
    try {
      await delegateHttp.deleteBinding(binding.binding_id)
      notifySuccess("已删除绑定")
      setDeleting(null)
      await reload()
      onChanged()
    } catch (reason) {
      if (isDelegateConflict(reason)) {
        // 在途委托单还引用着这行绑定：只能停用，不能删。
        notifyError("该绑定被在途委托单引用，请改为停用", { reason })
        setDeleting(null)
      } else {
        notifyCommandError(reason, "删除绑定失败")
      }
    }
  }

  if (!storeId) return null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-compact text-muted-foreground">
          绑定是商品级预绑：出单后按行的绑定厂家派发；原图核验通过才算就绪。
        </span>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => void reload()}
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} />
            刷新
          </Button>
          <Button size="sm" onClick={() => setEditor({ mode: "create" })}>
            <Plus />
            新建绑定
          </Button>
        </div>
      </div>
      {bindings.length === 0 && !loading ? (
        <Empty className="min-h-40">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Paperclip />
            </EmptyMedia>
            <EmptyTitle>这家店还没有委托绑定</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" variant="outline" onClick={() => setEditor({ mode: "create" })}>
              新建绑定
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <Table containerClassName="max-w-full">
            <DelegateBindingsTable
              bindings={bindings}
              loading={loading}
              onEdit={(binding) => setEditor({ mode: "edit", binding })}
              onAssets={setAssetsFor}
              onToggle={(binding) => void toggleActive(binding)}
              onDelete={setDeleting}
            />
          </Table>
        </div>
      )}
      <DelegateBindingEditorDialog
        editor={editor}
        storeId={storeId}
        sources={sources}
        onClose={() => setEditor(null)}
        onSaved={async () => {
          setEditor(null)
          await reload()
          onChanged()
        }}
      />
      <DelegateAssetsDialog
        binding={assetsFor}
        onClose={() => setAssetsFor(null)}
        onChanged={async (next) => {
          if (next) setAssetsFor(next)
          await reload()
          onChanged()
        }}
      />
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(next) => {
          if (!next) setDeleting(null)
        }}
        title={`删除绑定 ${deleting?.offer_id ?? ""}`}
        description="删除后该商品不再自动委托；被在途委托单引用的绑定无法删除。素材对象按引用差集回收。"
        confirmText="删除"
        disabled={!deleting}
        onConfirm={() => {
          if (deleting) void removeBinding(deleting)
        }}
      />
    </div>
  )
}

export function DelegateBindingsTable({
  bindings,
  loading,
  onEdit,
  onAssets,
  onToggle,
  onDelete,
}: {
  bindings: DelegateBinding[]
  loading: boolean
  onEdit: (binding: DelegateBinding) => void
  onAssets: (binding: DelegateBinding) => void
  onToggle: (binding: DelegateBinding) => void
  onDelete: (binding: DelegateBinding) => void
}) {
  return (
    <>
      <TableHeader>
        <TableRow>
          <TableHead className="w-44">商品 offer_id</TableHead>
          <TableHead className="w-48">厂家</TableHead>
          <TableHead className="w-24">状态</TableHead>
          <TableHead className="w-28">原图</TableHead>
          <TableHead className="w-40">私注</TableHead>
          <TableHead className="w-56">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody aria-busy={loading}>
        {bindings.map((binding) => {
          const verified = binding.assets.filter((asset) => asset.verified).length
          return (
            <TableRow key={binding.binding_id}>
              <TableCell>
                <p className="font-mono text-compact break-all select-all">
                  {binding.offer_id}
                </p>
              </TableCell>
              <TableCell>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="break-words text-sm">{binding.source.name}</span>
                  <span className="text-meta text-muted-foreground">
                    {[binding.source.country, binding.source.icon]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {binding.warning ? (
                    <span className="text-meta text-st-attest-ink">{binding.warning}</span>
                  ) : null}
                </div>
              </TableCell>
              <TableCell>
                <StateChip
                  status={binding.active ? "active" : "inactive"}
                  tone={binding.active ? "good" : "idle"}
                  label={binding.active ? "启用" : "停用"}
                />
              </TableCell>
              <TableCell>
                <span className="font-mono text-compact tabular-nums">
                  {verified}/{binding.assets.length}
                </span>
                <span className="sr-only">已核验 {verified} 张，共 {binding.assets.length} 张</span>
              </TableCell>
              <TableCell>
                <PrivateNote note={binding.note} />
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    size="xs"
                    variant="outline"
                    aria-label={`素材 ${binding.offer_id}`}
                    onClick={() => onAssets(binding)}
                  >
                    <Paperclip />
                    素材
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    aria-label={`改绑 ${binding.offer_id}`}
                    onClick={() => onEdit(binding)}
                  >
                    <Pencil />
                    改绑
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    aria-label={binding.active ? `停用 ${binding.offer_id}` : `启用 ${binding.offer_id}`}
                    onClick={() => onToggle(binding)}
                  >
                    <Ban />
                    {binding.active ? "停用" : "启用"}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`删除 ${binding.offer_id}`}
                    onClick={() => onDelete(binding)}
                  >
                    <Trash2 />
                    删除
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </>
  )
}

function PrivateNote({ note }: { note: string }) {
  if (!note.trim()) return <span className="text-compact text-muted-foreground">—</span>
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="block max-w-36 cursor-help truncate text-compact text-muted-foreground">
            {note}
          </span>
        }
      />
      <TooltipContent>{note}</TooltipContent>
    </Tooltip>
  )
}

// ---------------------------------------------------------------------------
// 新建 / 改绑对话框
// ---------------------------------------------------------------------------

export function DelegateBindingEditorDialog({
  editor,
  storeId,
  sources,
  onClose,
  onSaved,
}: {
  editor: { mode: "create" } | { mode: "edit"; binding: DelegateBinding } | null
  storeId: string
  sources: DelegateSource[]
  onClose: () => void
  onSaved: () => void | Promise<void>
}) {
  const open = Boolean(editor)
  const editing = editor?.mode === "edit" ? editor.binding : null
  const [sourceId, setSourceId] = useState("")
  const [offerId, setOfferId] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setSourceId(editing?.source.source_id ?? "")
    setOfferId(editing?.offer_id ?? "")
    setNote(editing?.note ?? "")
  }, [open, editing])

  async function save() {
    setBusy(true)
    try {
      if (editing) {
        await delegateHttp.patchBinding(editing.binding_id, {
          expected_revision: editing.revision,
          source_id: sourceId || null,
          note,
        })
        notifySuccess("已保存绑定")
      } else {
        await delegateHttp.createBinding({
          store_id: storeId,
          offer_id: normalizedOfferId(offerId),
          source_id: sourceId,
          note: note.trim() || undefined,
        })
        notifySuccess("已创建绑定")
      }
      await onSaved()
    } catch (reason) {
      if (isDelegateConflict(reason)) {
        // 建单撞同槽 = 该商品已有绑定；改绑撞 CAS = 版本过期。都让用户看到
        // 服务端结论后刷新，绝不静默重试。
        notifyError(
          editing ? "绑定已被更新，请刷新后重试" : "该商品已有绑定，请直接改绑",
          { reason },
        )
      } else {
        notifyCommandError(reason, "保存绑定失败")
      }
    } finally {
      setBusy(false)
    }
  }

  const offerInvalid = !editing && !normalizedOfferId(offerId)
  const canSave = Boolean(sourceId) && !offerInvalid && !busy

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "改绑" : "新建绑定"}</DialogTitle>
          <DialogDescription>
            {editing
              ? `改绑 ${editing.offer_id}：换厂家后新派发走新厂家，在途包不变。`
              : "把「店 × 商品」预绑到一个厂家；offer_id 需要先在商品页同步过。"}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="delegate-binding-factory">厂家</Label>
            <Select
              value={sourceId}
              onValueChange={(next) => setSourceId(next ?? "")}
              disabled={busy}
            >
              <SelectTrigger
                size="sm"
                className="min-w-44"
                aria-label="选择厂家"
                id="delegate-binding-factory"
              >
                <SelectValue>
                  {sources.find((source) => source.source_id === sourceId)?.name ||
                    "选择厂家"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {sources.map((source) => (
                  <SelectItem key={source.source_id} value={source.source_id}>
                    {source.name}
                    {source.country ? ` · ${source.country}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="delegate-binding-offer">商品 offer_id</Label>
            {editing ? (
              <p className="font-mono text-sm break-all select-all">{editing.offer_id}</p>
            ) : (
              <Input
                id="delegate-binding-offer"
                value={offerId}
                aria-invalid={offerInvalid || undefined}
                placeholder="如 ART-40X50-0001"
                onChange={(event) => setOfferId(event.target.value)}
                disabled={busy}
              />
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="delegate-binding-note">私注（仅自己可见）</Label>
            <Textarea
              id="delegate-binding-note"
              value={note}
              placeholder="选填；不会发给厂家"
              onChange={(event) => setNote(event.target.value)}
              disabled={busy}
            />
          </div>
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button size="sm" disabled={!canSave} onClick={() => void save()}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// 原图素材对话框
// ---------------------------------------------------------------------------

export function DelegateAssetsDialog({
  binding,
  onClose,
  onChanged,
}: {
  binding: DelegateBinding | null
  onClose: () => void
  /** 传回重新装载后的绑定（无则不更新本行），外带刷新信号。 */
  onChanged: (next: DelegateBinding | null) => void | Promise<void>
}) {
  const open = Boolean(binding)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  async function upload(file: File) {
    if (!binding) return
    const precheck = assetFileError(file)
    if (precheck) {
      notifyError(precheck)
      return
    }
    setBusy(true)
    try {
      const asset = await uploadDelegateAsset(
        {
          presign: delegateHttp.presignAsset,
          putObject: delegateHttp.putAssetObject,
          finalize: delegateHttp.finalizeAsset,
        },
        { binding_id: binding.binding_id, file },
      )
      notifySuccess(asset.verified ? "原图已上传并通过核验" : "原图已上传，等待服务端核验")
      // 落行后拿最新绑定（素材列表 + 晋升信号都来自它）。
      const bindings = await delegateHttp.listBindings(binding.store_id)
      const next = bindings.find((row) => row.binding_id === binding.binding_id) ?? null
      await onChanged(next)
    } catch (reason) {
      notifyCommandError(reason, "原图上传失败")
    } finally {
      setBusy(false)
    }
  }

  async function remove(assetId: string) {
    if (!binding) return
    setBusy(true)
    try {
      const result = await delegateHttp.deleteAsset(assetId)
      notifySuccess(result.reclaimed ? "已删除并回收对象" : "已删除；对象仍被在途派发包引用")
      setDeleting(null)
      const bindings = await delegateHttp.listBindings(binding.store_id)
      const next = bindings.find((row) => row.binding_id === binding.binding_id) ?? null
      await onChanged(next)
    } catch (reason) {
      notifyCommandError(reason, "删除素材失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !busy) onClose()
        }}
      >
        <DialogContent className="flex max-h-[min(42rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <div className="shrink-0 border-b border-border py-3 pr-12 pl-4">
          <DialogHeader>
            <DialogTitle>
              <span className="block break-all">原图素材 · {binding?.offer_id ?? ""}</span>
            </DialogTitle>
            <DialogDescription>
              生产原图会自包含冻结进派发包；摘除不影响在途单，换图只影响新派发。
            </DialogDescription>
          </DialogHeader>
        </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            {binding && binding.warning ? (
              <p className="text-compact text-st-attest-ink">{binding.warning}</p>
            ) : null}
            {binding && binding.assets.length === 0 ? (
              <Empty className="min-h-32">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Paperclip />
                  </EmptyMedia>
                  <EmptyTitle>还没有原图</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : null}
            {binding
              ? binding.assets.map((asset) => (
                  <div
                    key={asset.asset_id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3"
                  >
                    <div className="min-w-0">
                      <p className="break-all text-sm">{asset.file_name}</p>
                      <p className="font-mono text-meta break-all text-muted-foreground">
                        {assetContentType({ name: asset.file_name, type: asset.mime })} ·{" "}
                        {assetExtensionOf(asset.file_name) ?? ""} ·{" "}
                        {formatInstantValue(asset.created_at_ms)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StateChip
                        status={asset.verified ? "verified" : "unverified"}
                        tone={asset.verified ? "good" : "attest"}
                        label={asset.verified ? "已核验" : "未核验"}
                      />
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`删除 ${asset.file_name}`}
                        disabled={busy}
                        onClick={() => setDeleting(asset.asset_id)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                ))
              : null}
            <input
              ref={inputRef}
              type="file"
              accept={ASSET_ACCEPT}
              className="sr-only"
              aria-label="上传原图"
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ""
                if (file) void upload(file)
              }}
            />
          </div>
          <div className="flex shrink-0 justify-end border-t border-border px-4 py-3">
            <Button
              size="sm"
              variant="brand"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              {busy ? <Spinner data-icon="inline-start" /> : <UploadCloud />}
              上传原图
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(next) => {
          if (!next) setDeleting(null)
        }}
        title="删除这张原图？"
        description="在途派发包持有冻结副本，不受影响；未被引用的桶对象按引用差集回收。"
        confirmText="删除"
        busy={busy}
        onConfirm={() => {
          if (deleting) void remove(deleting)
        }}
      />
    </>
  )
}
