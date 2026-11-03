import { Copy, Download } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { notifyCommandError, notifySuccess } from "@/lib/notify"

function storeExportName(): string {
  return `ozon-stores-${new Date().toISOString().slice(0, 10)}.txt`;
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function copyText(value: string, message: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    notifySuccess(message);
    return true;
  } catch {
    notifyCommandError(undefined, "复制失败，请改用下载。");
    return false;
  }
}

/** 批量导出密钥: the document the operator copies or downloads. */
export function StoreExportDialog({
  exportText,
  setExportText,
}: {
  exportText: string | undefined
  setExportText: (value: string | undefined) => void
}) {
  return (
    <Dialog
      open={exportText !== undefined}
      onOpenChange={(open) => {
        if (!open) setExportText(undefined);
      }}
    >
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-sm">
        <DialogHeader className="gap-1 border-b border-border px-5 py-3.5">
          <DialogTitle className="pr-6 text-base font-semibold">
            批量导出
          </DialogTitle>
          <DialogDescription>
            {`共 ${exportText ? exportText.split("\n").length : 0} 家店铺。导出内容包含明文密钥，请妥善保存。`}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="m-0 gap-2 rounded-none border-t border-border bg-popover px-5 py-3 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            disabled={!exportText}
            onClick={() => {
              if (exportText) void copyText(exportText, "已复制全部店铺密钥");
            }}
          >
            <Copy data-icon="inline-start" />
            复制
          </Button>
          <Button
            type="button"
            disabled={!exportText}
            onClick={() => {
              if (exportText)
                downloadText(storeExportName(), `${exportText}\n`);
            }}
          >
            <Download data-icon="inline-start" />
            下载 .txt
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
