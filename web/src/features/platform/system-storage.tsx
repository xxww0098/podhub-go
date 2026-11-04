import { useEffect, useState, type FormEvent } from "react"
import { Pencil, Plus, Trash2 } from "lucide-react"

import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import { replaceIntegrationConfigRequest } from "@/bindings/integration-writes"
import { PlatformAdminSurface } from "@/components/platform-admin-surface"
import { R2BucketFields, type R2BucketValues } from "@/components/r2-bucket-fields"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { errorMessage } from "@/lib/error-message"
import { notifySuccess } from "@/lib/notify"

type Config = components["schemas"]["AdminIntegrationConfigView"]
type Storage = components["schemas"]["AdminSystemStorageWrite"]
type Role = Storage["role"]
type Editor = { role: Role; values: R2BucketValues }

const roles: { role: Role; label: string; defaultBucket: string }[] = [
  { role: "assets", label: "素材桶（公开）", defaultBucket: "podhub-supplier" },
  { role: "private", label: "私有数据桶", defaultBucket: "podhub-private" },
]

const emptyValues: R2BucketValues = { endpoint: "", bucket: "", public_base_url: "", access_key_id: "", secret_access_key: "" }

function labelOf(role: Role) {
  return roles.find((item) => item.role === role)!.label
}

function normalizeEndpoint(value: string) {
  return value.trim().replace(/\/+$/, "").toLowerCase()
}

function writable(rows: readonly components["schemas"]["AdminSystemStorageView"][], role: Role, values: R2BucketValues): Storage[] {
  const written = rows.map((row) => row.role === role
    ? { role, ...values }
    : { role: row.role, endpoint: row.endpoint, bucket: row.bucket, public_base_url: row.public_base_url, access_key_id: "", secret_access_key: "" })
  if (!rows.some((row) => row.role === role)) written.push({ role, ...values })
  return written
}

export function PlatformSystemStorageScreen() {
  const [config, setConfig] = useState<Config>()
  const [editor, setEditor] = useState<Editor | null>(null)
  const [editorError, setEditorError] = useState("")
  const [removing, setRemoving] = useState<Role | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function load() {
    setBusy(true)
    setError("")
    try {
      const next = await api.get<Config>(route("adminIntegrationsConfig"))
      if (!Array.isArray(next.system_storage)) throw new Error("存储配置读取不完整，请刷新后重试")
      setConfig(next)
    } catch (reason) {
      setError(errorMessage(reason, "无法读取系统存储配置"))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { void load() }, [])

  function openEditor(role: Role) {
    const saved = config?.system_storage.find((row) => row.role === role)
    setEditorError("")
    setEditor({ role, values: saved
      ? { endpoint: saved.endpoint, bucket: saved.bucket, public_base_url: saved.public_base_url, access_key_id: "", secret_access_key: "" }
      : emptyValues })
  }

  function updateValue(key: keyof R2BucketValues, value: string) {
    setEditor((current) => current ? { ...current, values: { ...current.values, [key]: value } } : current)
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!config || !editor) return
    const saved = config.system_storage.find((row) => row.role === editor.role)
    const unchanged = !!saved && normalizeEndpoint(saved.endpoint) === normalizeEndpoint(editor.values.endpoint) && saved.bucket === editor.values.bucket.trim()
    if (saved && !unchanged && (editor.values.access_key_id.trim() === "" || editor.values.secret_access_key === "")) {
      setEditorError("修改端点或桶名后，请重新填写 Access Key ID 和 Secret Access Key。")
      return
    }
    setBusy(true)
    setEditorError("")
    try {
      const next = await api.put<Config>(route("adminIntegrationsConfig"), { ...replaceIntegrationConfigRequest(config), system_storage: writable(config.system_storage, editor.role, editor.values) })
      setConfig(next)
      setEditor(null)
      notifySuccess(`${labelOf(editor.role)}配置已保存`)
    } catch (reason) {
      setEditorError(errorMessage(reason, "保存失败，请检查配置后重试"))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!config || !removing) return
    setBusy(true)
    setError("")
    try {
      const rows = config.system_storage.filter((row) => row.role !== removing)
      const next = await api.put<Config>(route("adminIntegrationsConfig"), {
        ...replaceIntegrationConfigRequest(config),
        system_storage: rows.map((row) => ({ role: row.role, endpoint: row.endpoint, bucket: row.bucket, public_base_url: row.public_base_url, access_key_id: "", secret_access_key: "" })),
      })
      setConfig(next)
      notifySuccess(`${labelOf(removing)}配置已移除`)
      setRemoving(null)
    } catch (reason) {
      setError(errorMessage(reason, "无法移除存储桶配置"))
    } finally {
      setBusy(false)
    }
  }

  const savedForEditor = editor ? config?.system_storage.find((row) => row.role === editor.role) : undefined
  const retainCredentials = !!editor && !!savedForEditor && normalizeEndpoint(savedForEditor.endpoint) === normalizeEndpoint(editor.values.endpoint) && savedForEditor.bucket === editor.values.bucket.trim()

  return <PlatformAdminSurface bodyClassName="border-t-0">
    {!config ? <div className="flex flex-wrap items-center gap-3 py-5" role={error ? "alert" : "status"}>
      <span>{error || "正在读取存储配置…"}</span>
      {error ? <Button type="button" variant="outline" onClick={() => void load()} disabled={busy}>重试</Button> : null}
    </div> : <>
      <p className="max-w-prose pb-5 text-sm text-muted-foreground">素材桶用于公开图片，私有桶仅由服务端读取。凭据加密保存，不回显；保存只校验格式，不测试外部连接。</p>
      {error ? <p role="alert" className="pb-4 text-sm text-destructive">{error}</p> : null}
      <div className="flex flex-col">
        {roles.map(({ role, label }) => {
          const saved = config.system_storage.find((row) => row.role === role)
          return <section key={role} className="border-t border-border py-5 first:border-t-0 first:pt-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2"><h2 className="text-base font-medium">{label}</h2><Badge variant="outline">{saved ? "已配置" : "未配置"}</Badge></div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" aria-label={`${saved ? "编辑" : "配置"}${label}`} onClick={() => openEditor(role)} disabled={busy}>{saved ? <Pencil aria-hidden /> : <Plus aria-hidden />}{saved ? "编辑" : "配置"}</Button>
                {saved ? <Button type="button" variant="ghost" size="sm" aria-label={`移除${label}`} onClick={() => setRemoving(role)} disabled={busy}><Trash2 aria-hidden />移除</Button> : null}
              </div>
            </div>
            {saved ? <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
              <div><dt className="text-muted-foreground">R2 端点</dt><dd className="mt-1 break-all">{saved.endpoint}</dd></div>
              <div><dt className="text-muted-foreground">存储桶</dt><dd className="mt-1 break-all">{saved.bucket}</dd></div>
              {role === "assets" ? <div className="sm:col-span-2"><dt className="text-muted-foreground">公开访问地址</dt><dd className="mt-1 break-all"><a href={saved.public_base_url} target="_blank" rel="noreferrer" className="text-brand-ink underline underline-offset-4">{saved.public_base_url}</a></dd></div> : null}
            </dl> : <p className="mt-3 text-sm text-muted-foreground">尚未填写端点与凭据。</p>}
          </section>
        })}
      </div>
    </>}
    <Dialog open={editor !== null} onOpenChange={(open) => { if (!open && !busy) setEditor(null) }}>
      <DialogContent showCloseButton={!busy} className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editor ? `${savedForEditor ? "编辑" : "配置"}${labelOf(editor.role)}` : "存储桶配置"}</DialogTitle>
          <DialogDescription>保存只校验格式，不测试外部连接。修改端点或桶名后需重新填写凭据。</DialogDescription>
        </DialogHeader>
        {editor ? <form className="flex flex-col gap-4" onSubmit={(event) => void save(event)}>
          <R2BucketFields idPrefix={`${editor.role}-r2`} value={editor.values} onChange={updateValue} disabled={busy} showPublic={editor.role === "assets"} configured={retainCredentials} bucketPlaceholder={roles.find((item) => item.role === editor.role)?.defaultBucket} />
          {editorError ? <p role="alert" className="text-sm text-destructive">{editorError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setEditor(null)}>取消</Button>
            <Button type="submit" disabled={busy}>{busy ? <Spinner aria-hidden /> : null}{busy ? "保存中…" : "保存配置"}</Button>
          </DialogFooter>
        </form> : null}
      </DialogContent>
    </Dialog>
    <ConfirmDialog open={removing !== null} onOpenChange={(open) => { if (!open && !busy) setRemoving(null) }} title={`移除${removing ? labelOf(removing) : "存储桶"}配置？`} description="保存后新请求将不再使用该桶；桶内已有对象不会被删除，但相关图片和文件可能无法访问。" confirmText="移除配置" busy={busy} onConfirm={() => void remove()} />
  </PlatformAdminSurface>
}
