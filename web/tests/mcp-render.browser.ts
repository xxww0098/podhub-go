import { renderClient } from '../src/render/client'
import { DEFAULT_RENDER_INTENT } from '../src/render/wasm'
import templateUrl from './fixtures/psd/synthetic/tiny-smart-mask-warp-groups.psd?url'
import designUrl from './fixtures/psd/synthetic/replacement-transparent-edges.png?url'

const token = location.hash.slice(1)
history.replaceState(null, '', location.pathname)
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const status = document.querySelector('#status')!
const hash = async (bytes: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')

async function run() {
  const response = await fetch('/mcp-probe/claim?kind=render', { method: 'POST', headers })
  if (!response.ok) throw new Error(`Claim rejected: ${response.status}`)
  const job = await response.json()
  if (!job) { setTimeout(() => void run().catch(failed), 1000); return }
  document.body.dataset.state = 'running'
  status.textContent = 'Rendering PSD in browser Worker'
  const batch = renderClient.createBatch()
  try {
    const load = async (url: string) => {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Fixture unavailable: ${response.status}`)
      return new Uint8Array(await response.arrayBuffer())
    }
    const [template, design] = await Promise.all([load(templateUrl), load(designUrl)])
    const fingerprint = `sha256:${await hash(template)}`
    const rendered = await batch.withLane(fingerprint, async lane => {
      const handle = await lane.retainTemplate(fingerprint, template)
      return lane.renderProduct(handle, design, job.text, DEFAULT_RENDER_INTENT)
    })
    // Store the actual output bytes, not a text stand-in for render success.
    const combined = new Uint8Array(await new Blob(rendered.slices.map(slice => slice.bytes)).arrayBuffer())
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle('mcp-render-probe', { create: true })
    const file = await directory.getFileHandle(job.id, { create: true })
    try {
      const writer = await file.createWritable()
      await writer.write(combined)
      await writer.close()
      const restored = new Uint8Array(await (await file.getFile()).arrayBuffer())
      if (restored.length !== combined.length || !combined.every((byte, index) => byte === restored[index])) throw new Error('OPFS byte mismatch')
      const slices = []
      for (const slice of rendered.slices) {
        const jpegBase64 = btoa(Array.from(slice.bytes, byte => String.fromCharCode(byte)).join(''))
        const image = new Image()
        image.src = `data:image/jpeg;base64,${jpegBase64}`
        await image.decode()
        if (image.naturalWidth !== slice.width || image.naturalHeight !== slice.height) throw new Error('JPEG dimensions mismatch')
        image.alt = `${slice.groupName}: ${slice.width} × ${slice.height}`
        image.width = slice.width * 4
        image.height = slice.height * 4
        const figure = document.createElement('figure')
        const caption = document.createElement('figcaption')
        caption.textContent = image.alt
        figure.append(caption, image)
        document.querySelector('#slices')!.append(figure)
        slices.push({ groupName: slice.groupName, width: slice.width, height: slice.height, jpegBase64 })
      }
      const result = { sha256: await hash(restored), bytes: restored.length, opfsRoundtrip: true, slices }
      const settled = await fetch('/mcp-probe/settle', { method: 'POST', headers, body: JSON.stringify({ id: job.id, lease: job.lease, result }) })
      if (!settled.ok) throw new Error(`Settle rejected: ${settled.status}`)
      status.textContent = `Completed: ${slices.length} JPEGs rendered, decoded, stored in OPFS and returned to MCP`
      document.body.dataset.state = 'done'
    } finally { await directory.removeEntry(job.id) }
  } finally { batch.dispose() }
}
function failed(error: unknown) {
  console.error(error)
  document.body.dataset.state = 'failed'
  status.textContent = 'Stopped; inspect the browser console.'
}
void run().catch(failed)
