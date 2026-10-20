/**
 * Promise-based application entry point (slice 03 "契约与缝": "client.ts：
 * 应用入口，从第一天起就是 Promise 接口（13 片按长任务门决定是否放进
 * worker，调用方不用改）"). Every method returns a `Promise` today even
 * though the underlying WASM call is synchronous, so a later move into a
 * Worker (slice 13's long-task gate) changes only this file's insides, never
 * a caller's shape.
 *
 * Owns the one thing `wasm.ts` deliberately does not: fetching and
 * instantiating the module, and wiring `env.fill_random` — the host-supplied
 * randomness `rust/crates/listing-core-wasm/src/ids.rs` imports (slice 03
 * decision: "随机只经 `env.fill_random`，所以 wasm 目标上不能出现
 * `getrandom`"). The import needs the instance's own `memory` export to
 * write bytes into, which only exists once instantiation finishes, so it is
 * wired here (right after `WebAssembly.instantiate`/`instantiateStreaming`
 * resolves), not in `wasm.ts`.
 */

import { createListingCore, type ListingCore } from "./wasm"
import type { WbMaterial, WbProductConfig, WbPreview, WbIssue, WbSchemaHandle } from "./wb-types"
import type {
  KnownIssueKey,
  ProjectSubmitDraftInput,
  SubmitDraft,
  DecideCandidatesInput,
  EditedOutput,
  EditRowInput,
  EditRowOutput,
  FreezeListingInput,
  FreezeListingOutput,
  ParsedOcrAnswer,
  RecordRenderInput,
  RecordRenderOutput,
  RevalidateInput,
  SchemaLoadInput,
  SeedRowInput,
  SeedRowOutput,
  SettleRecognitionInput,
  StageRequest,
  SubmitDraftInput,
  SubmitDraftOutput,
  ValidateVariantGroupInput,
  ValuesEqualInput,
  VariantProblem,
} from "./types"

// `ListingCoreError` stays imported from `./wasm` directly — the one file
// that actually throws it (slice 03 单一所有者: "其它文件直接碰 WASM
// exports" is what `wasm.ts` exists to prevent; re-exporting its error type
// here too would just be a second, unnecessary import path to the same
// class).
export type * from "./types"

/**
 * Fetches and instantiates the module at `url`. Streaming compile first;
 * falls back to buffered `instantiate` when a dev server answers with the
 * wrong MIME type and streaming compilation refuses (same fallback shape as
 * `web/src/render/wasm.ts`'s `loadRenderModule`).
 */
type LoadedCore = { core: ListingCore; module: WebAssembly.Module }

async function loadCore(url: string | BufferSource | WebAssembly.Module): Promise<LoadedCore> {
  // `env.fill_random` needs the instance's own linear memory, which does not
  // exist until instantiation returns — this outer binding is assigned once,
  // immediately after, before any exported call (and therefore any need for
  // randomness) can run.
  let memory: WebAssembly.Memory | undefined
  const imports = {
    env: {
      fill_random(ptr: number, len: number) {
        if (!memory) throw new Error("listing-core-wasm: fill_random called before instantiation finished")
        crypto.getRandomValues(new Uint8Array(memory.buffer, ptr, len))
      },
    },
  }

  let instance: WebAssembly.Instance
  let module: WebAssembly.Module
  if (url instanceof WebAssembly.Module) {
    module = url
    instance = await WebAssembly.instantiate(module, imports)
  } else if (typeof url !== "string") {
    ;({ instance, module } = await WebAssembly.instantiate(url, imports))
  } else if (url.startsWith("file:")) {
    // Bun tests replace global fetch. Reading the module here keeps that stub
    // from being asked for the wasm bytes.
    const bun = (globalThis as { Bun?: { file: (path: string) => { arrayBuffer: () => Promise<ArrayBuffer> } } }).Bun
    if (!bun) throw new Error("listing-core-wasm 文件地址只能在 Bun 里直接读取")
    const path = decodeURIComponent(new URL(url).pathname)
    ;({ instance, module } = await WebAssembly.instantiate(await bun.file(path).arrayBuffer(), imports))
  } else try {
    ;({ instance, module } = await WebAssembly.instantiateStreaming(fetch(url), imports))
  } catch {
    const bytes = await (await fetch(url)).arrayBuffer()
    ;({ instance, module } = await WebAssembly.instantiate(bytes, imports))
  }
  memory = (instance.exports as unknown as { memory: WebAssembly.Memory }).memory
  return { core: createListingCore(instance.exports), module }
}

/**
 * The browser's one handle onto `listing_core`'s field rules. One instance
 * per tab is enough — `loadSchema` keeps every open Card's schema resident by
 * its own handle, and `call()` already serializes access (no wasm thread,
 * one call in flight at a time).
 */
export class ListingCoreClient {
  private core: Promise<LoadedCore>
  private instanceGeneration = 0

  get generation(): number { return this.instanceGeneration }

  constructor(wasmUrl: string | BufferSource) {
    this.core = loadCore(wasmUrl)
  }

  /** Explicit next action only. Reinstantiates the resident compiled module with zero fetches.
   * Owners must invalidate every cached handle and reload their resident materials. */
  async restart(): Promise<void> {
    const previous = await this.core
    this.instanceGeneration += 1
    this.core = loadCore(previous.module)
    await this.core
  }

  async projectSubmitDraft(input: ProjectSubmitDraftInput): Promise<SubmitDraft> {
    return (await this.core).core.projectSubmitDraft(input)
  }

  async loadWbMaterial(material: WbMaterial): Promise<WbSchemaHandle> {
    return (await this.core).core.loadWbMaterial(material)
  }

  async dropWbMaterial(handle: WbSchemaHandle): Promise<void> {
    ;(await this.core).core.dropWbMaterial(handle)
  }

  async wbPreview(handle: WbSchemaHandle, config: WbProductConfig): Promise<WbPreview> {
    return (await this.core).core.wbPreview(handle, config)
  }

  async wbMetadataIssues(handle: WbSchemaHandle): Promise<WbIssue[]> {
    return (await this.core).core.wbMetadataIssues(handle)
  }

  async issueManifest(): Promise<KnownIssueKey[]> {
    return (await this.core).core.issueManifest()
  }

  async loadSchema(material: SchemaLoadInput): Promise<number> {
    return (await this.core).core.loadSchema(material)
  }

  async dropSchema(handle: number): Promise<void> {
    ;(await this.core).core.dropSchema(handle)
  }

  async schemaRevision(handle: number): Promise<string> {
    return (await this.core).core.schemaRevision(handle)
  }

  async seedRow(handle: number, input: SeedRowInput): Promise<SeedRowOutput> {
    return (await this.core).core.seedRow(handle, input)
  }

  async editRow(handle: number, input: EditRowInput): Promise<EditRowOutput> {
    return (await this.core).core.editRow(handle, input)
  }

  async settleRecognition(handle: number, input: SettleRecognitionInput): Promise<EditedOutput> {
    return (await this.core).core.settleRecognition(handle, input)
  }

  async decideCandidates(handle: number, input: DecideCandidatesInput): Promise<EditedOutput> {
    return (await this.core).core.decideCandidates(handle, input)
  }

  async recordRender(input: RecordRenderInput): Promise<RecordRenderOutput> {
    return (await this.core).core.recordRender(input)
  }

  async recordUpload(handle: number, input: RevalidateInput): Promise<EditedOutput> {
    return (await this.core).core.recordUpload(handle, input)
  }

  async revalidate(handle: number, input: RevalidateInput): Promise<EditedOutput> {
    return (await this.core).core.revalidate(handle, input)
  }

  async valuesEqual(input: ValuesEqualInput): Promise<boolean> {
    return (await this.core).core.valuesEqual(input)
  }

  async submitDraft(input: SubmitDraftInput): Promise<SubmitDraftOutput> {
    return (await this.core).core.submitDraft(input)
  }

  async freezeListing(handle: number, input: FreezeListingInput): Promise<FreezeListingOutput> {
    return (await this.core).core.freezeListing(handle, input)
  }

  async planStage<T>(input: StageRequest): Promise<T> {
    return (await this.core).core.planStage(input)
  }

  async parseOcrAnswer(completion: unknown): Promise<ParsedOcrAnswer> {
    return (await this.core).core.parseOcrAnswer(completion)
  }

  async validateVariantGroup(input: ValidateVariantGroupInput): Promise<VariantProblem[]> {
    return (await this.core).core.validateVariantGroup(input)
  }
}

let shared: ListingCoreClient | undefined

/**
 * One module per tab. The first caller chooses the bytes; later callers share it.
 *
 * The default bytes are the built artifact under `wasm/dist/`, outside this
 * Vite root (`web/`), so the `new URL` literal must stay inline: that is what
 * lets Vite serve it from `/@fs<repo>/wasm/dist/...` in dev and content-hash it
 * into `/assets/*.wasm` (immutable) in a build.
 */
export function sharedListingCore(source?: string | BufferSource): ListingCoreClient {
  shared ??= new ListingCoreClient(
    source ?? new URL("../../../wasm/dist/browser/listing-state.wasm", import.meta.url).href,
  )
  return shared
}
