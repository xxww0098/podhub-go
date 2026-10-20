/**
 * 写剪贴板并出统一 toast 的复制动作。成功文案与失败兜底文案由调用方
 * 给出（各自业务名词不同）；`onCopied` 在写入成功后、成功 toast 之前
 * 回调，用来翻转「已复制」按钮态，保持与各屏原有顺序一致。
 */
import { notifyCommandError, notifySuccess } from "./notify"

export async function copyToClipboard(
  text: string,
  options: { success: string; failure: string; onCopied?: () => void },
): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    options.onCopied?.()
    notifySuccess(options.success)
    return true
  } catch (reason) {
    notifyCommandError(reason, options.failure)
    return false
  }
}
