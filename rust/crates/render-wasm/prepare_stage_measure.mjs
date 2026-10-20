// Cold/hot stage clock for the synthetic fixture, through the legacy wasm ABI.
// Not wired into CI. Build, then pipe stdout into the native verdict:
//   cargo build -p render-wasm --profile profiling --target wasm32-unknown-unknown
//   node rust/crates/render-wasm/prepare_stage_measure.mjs | cargo xtask prepare-perf --stdin
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const wasm = readFileSync(
  new URL('target/wasm32-unknown-unknown/profiling/render_wasm.wasm', root),
);
const psdPath = 'fixtures/psd/synthetic/tiny-smart-mask-warp-groups.psd';
const designPath = 'fixtures/psd/synthetic/replacement-transparent-edges.png';
const psd = readFileSync(new URL(psdPath, root));
const png = readFileSync(new URL(designPath, root));
const stages = [
  'psdParse',
  'designDecode',
  'placedPrep',
  'pass1Bounds',
  'pass2Composite',
  'rowRead',
  'encodeTotal',
  'atomicCommit',
];
const hotN = 10;

const git = execSync('git rev-parse HEAD', {
  cwd: fileURLToPath(root),
  encoding: 'utf8',
});
const gitSha = git.trim();
if (!gitSha) {
  console.error('git rev-parse HEAD returned an empty sha');
  process.exit(1);
}

const { instance } = await WebAssembly.instantiate(wasm, {
  env: { performance_now: () => performance.now() },
});
const api = instance.exports;
const bytes = () => new Uint8Array(api.memory.buffer);
const put = (data) => {
  const ptr = api.alloc(data.length);
  bytes().set(data, ptr);
  return ptr;
};
const fail = (what) => {
  const ptr = api.last_error_ptr();
  const len = api.last_error_len();
  throw new Error(`${what}: ${new TextDecoder().decode(bytes().subarray(ptr, ptr + len))}`);
};
const takeBytes = (handle) => {
  const out = bytes().slice(api.result_ptr(handle), api.result_ptr(handle) + api.result_len(handle));
  api.drop_result(handle);
  return out;
};
const text = new TextDecoder();

function stageObject(value) {
  const out = {};
  for (const name of stages) {
    const stage = value?.[name];
    out[name] = {
      ms: typeof stage?.ms === 'number' ? stage.ms : 0,
      count: typeof stage?.count === 'number' ? stage.count : 0,
    };
  }
  return out;
}

function manifestTimings(packed) {
  const end = packed.indexOf(0x0a);
  const header = JSON.parse(text.decode(packed.subarray(0, end)));
  return stageObject(header.manifest.stageTimings);
}

const psdPtr = put(psd);
const coldStarted = performance.now();
const template = api.load_template(psdPtr, psd.length) || fail('load_template');
const coldWallMs = performance.now() - coldStarted;
const coldStages = stageObject(JSON.parse(text.decode(takeBytes(api.take_stage_timings()))));

const name = new TextEncoder().encode('replacement-transparent-edges.png');
const pngPtr = put(png);
const namePtr = put(name);
let hotWallMs = 0;
const samples = [];
for (let index = 0; index < hotN; index += 1) {
  const started = performance.now();
  const result =
    api.render_product(template, pngPtr, png.length, namePtr, name.length, 0, 0) ||
    fail('render_product');
  hotWallMs += performance.now() - started;
  samples.push(manifestTimings(takeBytes(result)));
}

const stagesMean = {};
for (const stageName of stages) {
  let ms = 0;
  let count = 0;
  for (const sample of samples) {
    ms += sample[stageName].ms;
    count += sample[stageName].count;
  }
  stagesMean[stageName] = { ms: ms / hotN, count: count / hotN };
}

const report = {
  schema: 1,
  gitSha,
  profile: 'profiling',
  psdPath,
  psdBytes: psd.length,
  designPath,
  designBytes: png.length,
  cold: { wallMs: coldWallMs, stages: coldStages },
  hot: { n: hotN, wallMs: hotWallMs, stagesMean },
  notes: 'stages nest; do not sum',
};
console.log(JSON.stringify(report, null, 2));
api.drop_template(template);
