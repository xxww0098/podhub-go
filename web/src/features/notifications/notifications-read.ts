import type { NotificationsView } from "@/bindings/commands"

export function appendNotificationPage(
  current: NotificationsView,
  next: NotificationsView,
): NotificationsView {
  const seen = new Set(current.notifications.map((item) => item.uuid))
  return {
    ...next,
    notifications: [
      ...current.notifications,
      ...next.notifications.filter((item) => !seen.has(item.uuid)),
    ],
  }
}

export async function readNotificationPages(
  read: (cursor?: string) => Promise<NotificationsView>,
  pageCount: number,
): Promise<{ view: NotificationsView; pages: number }> {
  let view = await read()
  let pages = 1
  while (pages < pageCount && view.next_cursor) {
    view = appendNotificationPage(view, await read(view.next_cursor))
    pages += 1
  }
  return { view, pages }
}

