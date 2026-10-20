/** Tab-global count, byte, and native user-slot admission; bodies end before permit release. */
import { cancelledError } from "@/lib/error-message"
import { completeTabSlots, createByteWindow, MEDIA_UPLOAD_BYTE_BUDGET, tabUploadSlots } from "./upload-budget"
export const MEDIA_UPLOAD_CONCURRENCY = 16
export const MEDIA_COMPLETE_CONCURRENCY = 2
/** FIFO permits. `release` is idempotent, so a `finally` can never double-free. */
export function permits(count: number) {
  let free = count
  const waiting: Array<() => void> = []
  return {
    async acquire(cancelled?: () => boolean): Promise<() => void> {
      if (cancelled?.()) throw cancelledError()
      if (free > 0) {
        free -= 1
      } else {
        await new Promise<void>((resolve, reject) => {
          const granted = () => { clearInterval(timer); resolve() }
          const timer = cancelled ? setInterval(() => {
            if (!cancelled()) return
            const index = waiting.indexOf(granted)
            if (index < 0) return
            waiting.splice(index, 1)
            clearInterval(timer)
            reject(cancelledError())
          }, 250) : undefined
          waiting.push(granted)
        })
      }
      let released = false
      return () => {
        if (released) return
        released = true
        const next = waiting.shift()
        if (next) next()
        else free += 1
      }
    },
  }
}

/**
 * One in-flight storage confirm for this tab, and at most two across tabs.
 * The server budget is two media-upload slots per user. Holding a third
 * complete-batch is what turns into 429.
 */
export async function acquireComplete(cancelled?: () => boolean): Promise<() => void> {
  const releaseCount = await completePermits.acquire(cancelled)
  try {
    const slots = completeTabSlots()
    if (!slots) return releaseCount
    const releaseSlot = await acquireUserSlot(slots, cancelled)
    return () => { releaseSlot(); releaseCount() }
  } catch (reason) {
    releaseCount()
    throw reason
  }
}

/** Only a singleflight leader sending bytes takes a permit. */
const deliveryPermits = permits(MEDIA_UPLOAD_CONCURRENCY)
const uploadBytes = createByteWindow(MEDIA_UPLOAD_BYTE_BUDGET)
export const completePermits = permits(MEDIA_COMPLETE_CONCURRENCY)

export async function acquireDelivery(byteLength: number | undefined, cancelled?: () => boolean): Promise<() => void> {
  const releaseCount = await deliveryPermits.acquire(cancelled)
  try {
    const releaseBytes = await uploadBytes.acquire(byteLength, cancelled)
    try {
      const slots = tabUploadSlots()
      if (!slots) return () => { releaseBytes(); releaseCount() }
      const releaseSlot = await acquireUserSlot(slots, cancelled)
      return () => { releaseSlot(); releaseBytes(); releaseCount() }
    } catch (reason) {
      releaseBytes()
      throw reason
    }
  } catch (reason) {
    releaseCount()
    throw reason
  }
}

async function acquireUserSlot(
  slots: NonNullable<ReturnType<typeof tabUploadSlots>>,
  cancelled?: () => boolean,
): Promise<() => void> {
  for (;;) {
    if (cancelled?.()) throw cancelledError()
    if (slots.tryAcquire()) {
      let released = false
      return () => {
        if (released) return
        released = true
        slots.release()
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}
