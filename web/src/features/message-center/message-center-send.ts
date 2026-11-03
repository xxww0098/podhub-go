import type { MessageCenterSendRequest } from "@/bindings/commands"
import { opsHttp } from "@/bindings/http-ops"

export async function sendAndReadMessage(request: MessageCenterSendRequest, canRead: () => boolean = () => true) {
  await opsHttp.messageCenterSend(request)
  if (!canRead()) return { status: "skipped" } as const
  try {
    const history = await opsHttp.messageCenterHistory({
      store_id: request.store_id,
      chat_id: request.chat_id,
    })
    return { status: "ready", history } as const
  } catch (refreshError) {
    return { status: "failed", refreshError } as const
  }
}
