import { renderOpfs } from "@/bindings/render-opfs"

export function imageSourceType(bytes: Uint8Array, declared: string): string {
  const kind = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
    : [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte) ? "image/png" : ""
  if (!kind || declared && declared !== "application/octet-stream" && declared !== kind) throw new Error("源图内容不是有效的 JPEG/PNG")
  return kind
}

/** Hash the bounded OPFS source preview's actual bytes sent to the model. */
export async function imageSetSource(handle: string): Promise<{ base64: string; sha256: string }> {
  const preview = await renderOpfs.workflowSourcePreview(handle, 1600)
  const url = preview.data_url
  if (!url.startsWith("blob:") && !url.startsWith("data:image/")) throw new Error("本行源图不可读取")
  let blob: Blob
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error("本行源图不可读取")
    blob = await response.blob()
  } finally { if (url.startsWith("blob:")) URL.revokeObjectURL(url) }
  if (!blob.size || blob.size > 20 * 1024 * 1024) throw new Error("源图须为 JPEG/PNG，最大 20 MB")
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const kind = imageSourceType(bytes, blob.type)
  const bitmap = await createImageBitmap(new Blob([bytes], { type: kind }))
  const pixels = bitmap.width * bitmap.height
  bitmap.close()
  if (!pixels || pixels > 4_000_000) throw new Error("源图超过 400 万像素")
  const hash = await crypto.subtle.digest("SHA-256", bytes)
  let binary = ""
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return { base64: btoa(binary), sha256: [...new Uint8Array(hash)].map((v) => v.toString(16).padStart(2, "0")).join("") }
}
