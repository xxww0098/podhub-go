import type { PublishQueueState } from "../../rows/types"
import type { SendQueueOptions } from "./types"

export function saveQueue(options: SendQueueOptions, publish: PublishQueueState): Promise<void> {
  options.rows.updateCardState((state) => ({
    ...state, workspaceUuid: options.workspaceUuid, cardId: options.cardId, publish,
    queue: state?.queue ?? { frozenRowIds: [], nextPosition: 0, paused: true, stopAfterCurrent: false },
  }))
  return options.rows.flush()
}
