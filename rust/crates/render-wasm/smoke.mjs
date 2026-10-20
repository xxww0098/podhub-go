// Exercises the serialized C ABI, including ownership and failure recovery.
// Production uses the separate threaded adapter.
//   bash web/scripts/build-render.sh && node rust/crates/render-wasm/smoke.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = new URL('../../', import.meta.url);
const wasm = readFileSync(new URL('target/wasm32-unknown-unknown/release/render_wasm.wasm', root));
const psd = readFileSync(new URL('fixtures/psd/synthetic/tiny-smart-mask-warp-groups.psd', root));
const png = readFileSync(new URL('fixtures/psd/synthetic/replacement-transparent-edges.png', root));
const { instance } = await WebAssembly.instantiate(wasm, { env: { performance_now: () => performance.now() } });
const api = instance.exports;
const bytes = () => new Uint8Array(api.memory.buffer);
const errorText = () => new TextDecoder().decode(bytes().subarray(api.last_error_ptr(), api.last_error_ptr() + api.last_error_len()));
const fail = (what) => { throw new Error(what + ': ' + errorText()); };
function withInput(data, task) {
  const ptr = api.alloc(data.length);
  assert.notEqual(ptr, 0, 'input allocation failed');
  try { bytes().set(data, ptr); return task(ptr, data.length); }
  finally { api.free(ptr, data.length); }
}
function take(handle) {
  assert.notEqual(handle, 0, errorText());
  const out = bytes().slice(api.result_ptr(handle), api.result_ptr(handle) + api.result_len(handle));
  api.drop_result(handle);
  assert.equal(api.result_len(handle), 0);
  assert.equal(api.result_ptr(handle), 0);
  return out;
}
assert.equal(api.load_template(0, 1), 0);
assert.match(errorText(), /input pointer is null/);
const template = withInput(psd, (ptr, len) => api.load_template(ptr, len)) || fail('load_template');
const parseTimings = JSON.parse(new TextDecoder().decode(take(api.take_stage_timings())));
assert.ok(parseTimings.psdParse.count > 0);
const name = new TextEncoder().encode('replacement-transparent-edges.png');
const render = (id) => withInput(png, (designPtr, designLen) =>
  withInput(name, (namePtr, nameLen) => api.render_product(id, designPtr, designLen, namePtr, nameLen, 0, 0)));
const out = take(render(template) || fail('render_product'));
const end = out.indexOf(0x0a);
assert.ok(end > 0);
const header = JSON.parse(new TextDecoder().decode(out.subarray(0, end)));
const timings = header.manifest.stageTimings;
assert.ok(timings && Object.values(timings).some((stage) => stage.count > 0 && stage.ms > 0), 'stage timings were not measured');
console.log('wasm ' + wasm.length + ' B · ' + header.slices.length + ' slices · manifest v' + header.manifest.version);
for (const s of header.slices) {
  const jpeg = out.subarray(end + 1 + s.offset, end + 1 + s.offset + s.len);
  const hash = 'sha256:' + createHash('sha256').update(jpeg).digest('hex');
  assert.equal(hash, s.contentHash, s.fileName);
  console.log('  ' + s.fileName + ' ' + s.width + 'x' + s.height + ' ' + s.len + ' B ' + hash + ' ok');
}
api.drop_template(template);
assert.equal(render(template), 0);
assert.match(errorText(), /no template for handle/);
assert.equal(withInput(new Uint8Array([7, 7]), (ptr, len) => api.prepare_ai_image(ptr, len)), 0);
assert.match(errorText(), /unsupported|undecodable/);
assert.deepEqual(take(withInput(png, (ptr, len) => api.prepare_ai_image(ptr, len))), new Uint8Array(png));
const replacement = withInput(psd, (ptr, len) => api.load_template(ptr, len));
assert.ok(replacement > template, 'dropped template handles must not be reused');
api.drop_template(replacement);
console.log('  input ownership, stale handles, fail-closed image admission and recovery ok');
