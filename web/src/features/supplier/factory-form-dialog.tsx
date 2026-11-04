import type { FactoryDraft } from "@/bindings/http-factories"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"

export type FactoryEditor = { factoryId?: string; draft: FactoryDraft }
export const EMPTY_FACTORY: FactoryDraft = { name: "", country: "", contact: "", internal_note: "", icon: "", account_email: "" }

export function FactoryFormDialog({ editor, busy, onClose, onChange, onSubmit }: {
  editor: FactoryEditor | null
  busy: boolean
  onClose: () => void
  onChange: (draft: FactoryDraft) => void
  onSubmit: () => void
}) {
  const draft = editor?.draft
  const creating = editor && !editor.factoryId
  return <Dialog open={editor !== null} onOpenChange={(open) => { if (!open && !busy) onClose() }}>
    <DialogContent>
      <DialogHeader><DialogTitle>{creating ? "新增工厂" : "工厂设置"}</DialogTitle><DialogDescription>{creating ? "创建工厂并开通首个登录账号，初始密码仅显示一次。" : "修改工厂基本资料。"}</DialogDescription></DialogHeader>
      {draft ? <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); onSubmit() }}>
        <FieldGroup>
          <Field><FieldLabel htmlFor="factory-name">工厂名称</FieldLabel><Input id="factory-name" required maxLength={80} value={draft.name} disabled={busy} onChange={(event) => onChange({ ...draft, name: event.target.value })} /></Field>
          {creating ? <Field><FieldLabel htmlFor="factory-email">工厂登录邮箱</FieldLabel><Input id="factory-email" type="email" required value={draft.account_email ?? ""} disabled={busy} onChange={(event) => onChange({ ...draft, account_email: event.target.value })} /></Field> : null}
          <Field><FieldLabel htmlFor="factory-contact">联系方式</FieldLabel><Input id="factory-contact" value={draft.contact} disabled={busy} onChange={(event) => onChange({ ...draft, contact: event.target.value })} /></Field>
          <Field><FieldLabel htmlFor="factory-country">国家或地区代码</FieldLabel><Input id="factory-country" maxLength={2} placeholder="如 CN" value={draft.country} disabled={busy} onChange={(event) => onChange({ ...draft, country: event.target.value })} /></Field>
          <Field><FieldLabel htmlFor="factory-note">备注</FieldLabel><Textarea id="factory-note" value={draft.internal_note} disabled={busy} onChange={(event) => onChange({ ...draft, internal_note: event.target.value })} /></Field>
        </FieldGroup>
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" variant="brand" disabled={busy}>{busy ? <Spinner /> : null}{creating ? "创建工厂" : "保存"}</Button></DialogFooter>
      </form> : null}
    </DialogContent>
  </Dialog>
}
