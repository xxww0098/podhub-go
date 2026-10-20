import { isFavorite, toggleFavorite } from "../src/features/supply-chain/gallery/listing-queue"

// Test-only adapter loaded into the real catalog by the browser harness.
// The browser pulls one typed command; MCP cannot supply executable code.
export async function consumeFavorite(executorUrl: string) {
  const url = new URL(executorUrl)
  if (url.hostname !== "127.0.0.1" || url.protocol !== "http:" || !url.hash) {
    throw new Error("Expected a local probe pairing URL")
  }
  const post = async (path: string, body?: unknown) => {
    const response = await fetch(`${url.origin}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${url.hash.slice(1)}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error(`Probe bridge returned ${response.status}`)
    return response.json()
  }
  const job = await post("/claim?kind=favorite")
  if (!job) throw new Error("No favorite command queued")
  const input = JSON.parse(job.text)
  if (job.kind !== "favorite" || typeof input.productId !== "string" || typeof input.favorite !== "boolean") {
    throw new Error("Invalid favorite command")
  }
  const card = document.querySelector(`[data-gallery-card="${CSS.escape(input.productId)}"]`)
  if (!card?.querySelector("[data-gallery-card-favorite]")) {
    throw new Error("Probe may only change a visible catalog product")
  }
  if (isFavorite(input.productId) !== input.favorite) toggleFavorite(input.productId)
  const result = { productId: input.productId, favorite: isFavorite(input.productId) }
  await post("/settle", { id: job.id, lease: job.lease, result })
  return result
}
