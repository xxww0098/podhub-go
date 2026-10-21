/** One response, one instantiation attempt. MIME selects streaming versus bytes;
 * compile/link/start failures propagate instead of replaying initialization. */
export async function instantiateWasm(
  url: string,
  imports: WebAssembly.Imports,
): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`WASM download failed: HTTP ${response.status}`)

  if (response.headers.get("Content-Type")?.trim().toLowerCase() === "application/wasm") {
    return WebAssembly.instantiateStreaming(response, imports)
  }
  return WebAssembly.instantiate(await response.arrayBuffer(), imports)
}
