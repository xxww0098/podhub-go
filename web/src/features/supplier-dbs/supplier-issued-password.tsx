import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

export function IssuedSupplierPassword({
  issued,
  onClose,
}: {
  issued?: { email: string; password: string }
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  return (
    <Dialog open={issued !== undefined} onOpenChange={() => undefined}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>一次性初始密码</DialogTitle>
          <DialogDescription>
            只显示这一次。把下面的邮箱和密码交给厂家，关掉后无法再查看。
          </DialogDescription>
        </DialogHeader>
        {issued ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <p className="text-meta text-muted-foreground">登录邮箱</p>
              <p className="font-mono break-all text-compact">{issued.email}</p>
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-meta text-muted-foreground">初始密码</p>
              <p className="rounded-md border border-border px-3 py-3 font-mono break-all text-compact">
                {issued.password}
              </p>
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              if (issued) {
                void navigator.clipboard.writeText(`${issued.email}\n${issued.password}`)
              }
              setCopied(true)
            }}
          >
            {copied ? "已复制" : "复制邮箱和密码"}
          </Button>
          <Button type="button" onClick={onClose}>
            我已保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
