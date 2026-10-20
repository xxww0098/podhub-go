/* tslint:disable */
/* eslint-disable */

/**
 * All methods run on the responsive coordinator Worker. Awaiting Rayon yields
 * its event loop; disposing an owner never releases still-running compute.
 */
export class RenderRuntime {
    free(): void;
    [Symbol.dispose](): void;
    acquire(owner: number, key: string): Promise<string>;
    dispose_owner(owner: number): void;
    measure(): string;
    constructor(threads: number, budget: number);
    prepare_image(lease: number, bytes: Uint8Array): Promise<Uint8Array>;
    register_owner(owner: number): void;
    release(id: number): void;
    render(lease: number, template_id: number, design: Uint8Array, name: string, intent: string): Promise<Uint8Array>;
    retain_template(lease: number, bytes: Uint8Array): Promise<number>;
    set_external_bytes(bytes: number): void;
}

export function initThreadPool(num_threads: number): Promise<any>;

export class wbg_rayon_PoolBuilder {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    build(): void;
    numThreads(): number;
    receiver(): number;
}

export function wbg_rayon_start_worker(receiver: number): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly __wbg_renderruntime_free: (a: number, b: number) => void;
    readonly alloc: (a: number) => number;
    readonly drop_result: (a: number) => void;
    readonly drop_template: (a: number) => void;
    readonly free: (a: number, b: number) => void;
    readonly last_error_len: () => number;
    readonly last_error_ptr: () => number;
    readonly load_template: (a: number, b: number) => number;
    readonly prepare_ai_image: (a: number, b: number) => number;
    readonly render_product: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly renderruntime_acquire: (a: number, b: number, c: number, d: number) => number;
    readonly renderruntime_dispose_owner: (a: number, b: number) => void;
    readonly renderruntime_measure: (a: number, b: number) => void;
    readonly renderruntime_new: (a: number, b: number, c: number) => void;
    readonly renderruntime_prepare_image: (a: number, b: number, c: number, d: number) => number;
    readonly renderruntime_register_owner: (a: number, b: number, c: number) => void;
    readonly renderruntime_release: (a: number, b: number) => void;
    readonly renderruntime_render: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly renderruntime_retain_template: (a: number, b: number, c: number, d: number) => number;
    readonly renderruntime_set_external_bytes: (a: number, b: number, c: number) => void;
    readonly result_len: (a: number) => number;
    readonly result_ptr: (a: number) => number;
    readonly take_stage_timings: () => number;
    readonly __wbg_wbg_rayon_poolbuilder_free: (a: number, b: number) => void;
    readonly initThreadPool: (a: number) => number;
    readonly wbg_rayon_poolbuilder_build: (a: number) => void;
    readonly wbg_rayon_poolbuilder_numThreads: (a: number) => number;
    readonly wbg_rayon_poolbuilder_receiver: (a: number) => number;
    readonly wbg_rayon_start_worker: (a: number) => void;
    readonly __wasm_bindgen_func_elem_455: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_461: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_457: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_2451: (a: number, b: number, c: number) => void;
    readonly memory: WebAssembly.Memory;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_export2: (a: number, b: number) => void;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export4: (a: number, b: number) => number;
    readonly __wbindgen_export5: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_thread_destroy: (a?: number, b?: number, c?: number) => void;
    readonly __wbindgen_start: (a: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number }} module - Passing `SyncInitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number } | SyncInitInput, memory?: WebAssembly.Memory): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number }} module_or_path - Passing `InitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number } | InitInput | Promise<InitInput>, memory?: WebAssembly.Memory): Promise<InitOutput>;
