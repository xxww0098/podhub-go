import assert from "node:assert/strict"
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import test from "node:test"
import { assertPipelineBrowserSafety, parsePipelineBrowserOptions, type PipelineBrowserSafetyConfig } from "./publish-pipeline-browser-safety"

function baseline(): PipelineBrowserSafetyConfig {
  return {
    envDir: false,
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "react/jsx-dev-runtime", "react/jsx-runtime",
      "@base-ui/react > use-sync-external-store/shim", "@base-ui/react > use-sync-external-store/shim/with-selector", "lucide-react",
      "zustand > use-sync-external-store/shim/with-selector.js"] },
    server: { hmr: false, ws: false, warmup: { clientFiles: [], ssrFiles: [] }, forwardConsole: { enabled: false } },
    plugins: [{ name: "podhub-mock-gate-without-dev-client" }],
  }
}

test("resolved mock-mode baseline accepts exactly the installed React includes, in either order", () => {
  const config = baseline()
  assert.doesNotThrow(() => assertPipelineBrowserSafety(config))
  config.optimizeDeps.include!.reverse()
  const before = structuredClone(config)
  assert.doesNotThrow(() => assertPipelineBrowserSafety(config))
  assert.deepEqual(config, before, "checking must not repair unsafe settings or mutate resolved config")
})

test("resolved mock-mode safety requires both fixed CommonJS shims and rejects aliases, subsets and duplicates", () => {
  const seams = ["@base-ui/react > use-sync-external-store/shim", "@base-ui/react > use-sync-external-store/shim/with-selector"]
  const reactOnly = baseline()
  reactOnly.optimizeDeps.include = reactOnly.optimizeDeps.include!.filter((entry) => !seams.includes(entry))
  assert.throws(() => assertPipelineBrowserSafety(reactOnly), { message: "Vite mock-mode safety contract was not applied" })
  for (const seam of seams) {
    for (const mutate of [
      (c: PipelineBrowserSafetyConfig) => { c.optimizeDeps.include = c.optimizeDeps.include!.filter((entry) => entry !== seam) },
      (c: PipelineBrowserSafetyConfig) => { c.optimizeDeps.include!.push(seam) },
      (c: PipelineBrowserSafetyConfig) => { c.optimizeDeps.include = c.optimizeDeps.include!.map((entry) => entry === seam ? entry.split(" > ")[1]! : entry) },
    ]) {
      const config = baseline()
      mutate(config)
      assert.throws(() => assertPipelineBrowserSafety(config), { message: "Vite mock-mode safety contract was not applied" }, seam)
    }
  }
})

test("installed Base UI CommonJS store imports match the finite mock-mode optimizer entries", () => {
  // Inspect installed exports and configuration only; no config evaluation,
  // optimizer, application import, environment mutation or service startup.
  const configSource = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8")
  const mockDeps = /optimizeDeps:\s*mockGate\s*\?\s*\{([\s\S]*?)\}\s*:\s*devOptimizeDeps/.exec(configSource)?.[1]
  assert.ok(mockDeps, "the finite optimizer settings must apply only to mock mode")
  assert.match(mockDeps, /noDiscovery:\s*true/)
  const includeSource = /include:\s*\[([\s\S]*?)\]/.exec(mockDeps)?.[1]
  assert.ok(includeSource, "mock mode must register the explicit CommonJS entry list")
  const includes = [...includeSource.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
  const specifiers = ["use-sync-external-store/shim", "use-sync-external-store/shim/with-selector"]
  assert.deepEqual(includes, [...specifiers.map((specifier) => `@base-ui/react > ${specifier}`),
    "zustand > use-sync-external-store/shim/with-selector.js", "lucide-react", "react-dom/client"])
  const resolved = baseline()
  resolved.optimizeDeps.include = [...includes, "react", "react-dom", "react/jsx-dev-runtime", "react/jsx-runtime"]
  assert.doesNotThrow(() => assertPipelineBrowserSafety(resolved))

  const baseUi = createRequire(createRequire(import.meta.url).resolve("@base-ui/react/package.json"))
  const utils = createRequire(baseUi.resolve("@base-ui/utils/package.json"))
  const storeSource = readFileSync(path.join(path.dirname(baseUi.resolve("@base-ui/utils/store")), "useStore.mjs"), "utf8")
  assert.match(storeSource, /import\s*\{\s*useSyncExternalStore\s*\}\s*from\s*['"]use-sync-external-store\/shim['"]/)
  assert.match(storeSource, /import\s*\{\s*useSyncExternalStoreWithSelector\s*\}\s*from\s*['"]use-sync-external-store\/shim\/with-selector['"]/)
  for (const specifier of specifiers) {
    const entry = baseUi.resolve(specifier)
    assert.equal(realpathSync(entry), realpathSync(utils.resolve(specifier)), "the include must resolve the same installed shim as its real importer")
    assert.match(readFileSync(entry, "utf8"), /module\.exports\s*=\s*require\(/, specifier)
  }
})

test("installed Lucide icon barrel is a fixed mock-mode optimizer entry", () => {
  const manifestPath = createRequire(import.meta.url).resolve("lucide-react/package.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  assert.equal(manifest.name, "lucide-react")
  assert.equal(manifest.module, "dist/esm/lucide-react.mjs")
  const entry = readFileSync(path.join(path.dirname(manifestPath), manifest.module), "utf8")
  assert.match(entry, /import\s*\*\s*as\s*index\s*from\s*['"]\.\/icons\/index\.mjs['"]/)
  assert.match(entry, /export\s*\{[^\n]+\}\s*from\s*['"]\.\/icons\/[^'"]+\.mjs['"]/)

  const configSource = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8")
  const mockDeps = /optimizeDeps:\s*mockGate\s*\?\s*\{([\s\S]*?)\}\s*:\s*devOptimizeDeps/.exec(configSource)?.[1]
  assert.ok(mockDeps, "icon optimization must remain restricted to the finite mock-mode branch")
  assert.match(mockDeps, /noDiscovery:\s*true/)
  const includeSource = /include:\s*\[([\s\S]*?)\]/.exec(mockDeps)?.[1]
  assert.ok(includeSource)
  const includes = [...includeSource.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
  assert.equal(includes.filter((entry) => entry === "lucide-react").length, 1)
  const resolved = baseline()
  resolved.optimizeDeps.include = [...includes, "react", "react-dom", "react/jsx-dev-runtime", "react/jsx-runtime"]
  assert.doesNotThrow(() => assertPipelineBrowserSafety(resolved))
})

test("resolved mock-mode safety requires the exact icon entry and rejects missing, duplicate, alias and glob entries", () => {
  const missing = baseline()
  missing.optimizeDeps.include = missing.optimizeDeps.include!.filter((entry) => entry !== "lucide-react")
  assert.throws(() => assertPipelineBrowserSafety(missing), { message: "Vite mock-mode safety contract was not applied" })
  const duplicate = baseline()
  duplicate.optimizeDeps.include!.push("lucide-react")
  assert.throws(() => assertPipelineBrowserSafety(duplicate), { message: "Vite mock-mode safety contract was not applied" })
  for (const alias of ["lucide-react/dist/esm/lucide-react.mjs", "lucide-react/*", "lucide-react/**"]) {
    const config = baseline()
    config.optimizeDeps.include = config.optimizeDeps.include!.map((entry) => entry === "lucide-react" ? alias : entry)
    assert.throws(() => assertPipelineBrowserSafety(config), { message: "Vite mock-mode safety contract was not applied" }, alias)
  }
})

test("installed Zustand and Base UI selector specifiers remain distinct optimizer entries", () => {
  const require = createRequire(import.meta.url)
  const baseUi = createRequire(require.resolve("@base-ui/react/package.json"))
  const zustandManifestPath = require.resolve("zustand/package.json")
  const zustand = createRequire(zustandManifestPath)
  const manifest = JSON.parse(readFileSync(zustandManifestPath, "utf8"))
  assert.equal(typeof manifest.peerDependencies["use-sync-external-store"], "string")
  const baseUiSource = readFileSync(path.join(path.dirname(baseUi.resolve("@base-ui/utils/store")), "useStore.mjs"), "utf8")
  const zustandSource = readFileSync(path.join(path.dirname(zustandManifestPath), "esm/traditional.mjs"), "utf8")
  assert.match(baseUiSource, /import\s*\{\s*useSyncExternalStoreWithSelector\s*\}\s*from\s*['"]use-sync-external-store\/shim\/with-selector['"]/)
  assert.match(zustandSource, /import\s+useSyncExternalStoreExports\s+from\s*['"]use-sync-external-store\/shim\/with-selector\.js['"]/)
  const extensionless = "use-sync-external-store/shim/with-selector"
  const extensionful = `${extensionless}.js`
  assert.equal(realpathSync(baseUi.resolve(extensionless)), realpathSync(zustand.resolve(extensionful)),
    "the same physical CJS file still requires both requested optimizer identifiers")
  assert.match(readFileSync(zustand.resolve(extensionful), "utf8"), /module\.exports\s*=\s*require\(/)

  const configSource = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8")
  const mockDeps = /optimizeDeps:\s*mockGate\s*\?\s*\{([\s\S]*?)\}\s*:\s*devOptimizeDeps/.exec(configSource)?.[1]
  assert.ok(mockDeps)
  const includeSource = /include:\s*\[([\s\S]*?)\]/.exec(mockDeps)?.[1]
  assert.ok(includeSource)
  const includes = [...includeSource.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
  for (const entry of [`@base-ui/react > ${extensionless}`, `zustand > ${extensionful}`]) {
    assert.equal(includes.filter((included) => included === entry).length, 1, entry)
  }
  const resolved = baseline()
  resolved.optimizeDeps.include = [...includes, "react", "react-dom", "react/jsx-dev-runtime", "react/jsx-runtime"]
  assert.doesNotThrow(() => assertPipelineBrowserSafety(resolved))

  const viteSource = readFileSync(path.join(path.dirname(require.resolve("vite/package.json")), "dist/node/chunks/node.js"), "utf8")
  const resolver = /function tryOptimizedResolve\([\s\S]*?\n\}/.exec(viteSource)?.[0]
  assert.ok(resolver, "inspect the installed resolver without starting Vite or the optimizer")
  assert.match(resolver, /const nestedIdMatch = `> \$\{id\}`/)
  assert.match(resolver, /optimizedData\.id\.endsWith\(nestedIdMatch\)/)
})

test("resolved mock-mode safety requires the exact Zustand selector entry and rejects missing, duplicate, alias and glob entries", () => {
  const seam = "zustand > use-sync-external-store/shim/with-selector.js"
  const missing = baseline()
  missing.optimizeDeps.include = missing.optimizeDeps.include!.filter((entry) => entry !== seam)
  assert.throws(() => assertPipelineBrowserSafety(missing), { message: "Vite mock-mode safety contract was not applied" })
  const duplicate = baseline()
  duplicate.optimizeDeps.include!.push(seam)
  assert.throws(() => assertPipelineBrowserSafety(duplicate), { message: "Vite mock-mode safety contract was not applied" })
  for (const alias of ["use-sync-external-store/shim/with-selector.js", "zustand > use-sync-external-store/shim/with-selector",
    "@base-ui/react > use-sync-external-store/shim/with-selector.js", "zustand > use-sync-external-store/shim/*"]) {
    const config = baseline()
    config.optimizeDeps.include = config.optimizeDeps.include!.map((entry) => entry === seam ? alias : entry)
    assert.throws(() => assertPipelineBrowserSafety(config), { message: "Vite mock-mode safety contract was not applied" }, alias)
  }
})

test("the actual fixture createRoot import uses the fixed installed React DOM client CommonJS entry", () => {
  const fixtureSource = readFileSync(new URL("./publish-pipeline.browser.tsx", import.meta.url), "utf8")
  assert.match(fixtureSource, /import\s*\{\s*createRoot\s*\}\s*from\s*['"]react-dom\/client['"]/)
  const require = createRequire(import.meta.url)
  const manifestPath = require.resolve("react-dom/package.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  assert.equal(manifest.exports["./client"].default, "./client.js")
  const clientPath = require.resolve("react-dom/client")
  assert.equal(realpathSync(clientPath), realpathSync(path.join(path.dirname(manifestPath), manifest.exports["./client"].default)))
  assert.notEqual(realpathSync(clientPath), realpathSync(require.resolve("react-dom")), "the root package is a different entry")
  const clientSource = readFileSync(clientPath, "utf8")
  assert.match(clientSource, /module\.exports\s*=\s*require\(['"]\.\/cjs\/react-dom-client\.production\.js['"]\)/)
  assert.match(clientSource, /module\.exports\s*=\s*require\(['"]\.\/cjs\/react-dom-client\.development\.js['"]\)/)
  const developmentSource = readFileSync(path.join(path.dirname(clientPath), "cjs/react-dom-client.development.js"), "utf8")
  assert.match(developmentSource, /exports\.createRoot\s*=/)

  const configSource = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8")
  const mockDeps = /optimizeDeps:\s*mockGate\s*\?\s*\{([\s\S]*?)\}\s*:\s*devOptimizeDeps/.exec(configSource)?.[1]
  assert.ok(mockDeps, "the actual client entry must remain restricted to mock mode")
  assert.match(mockDeps, /noDiscovery:\s*true/)
  const includeSource = /include:\s*\[([\s\S]*?)\]/.exec(mockDeps)?.[1]
  assert.ok(includeSource)
  const includes = [...includeSource.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
  assert.equal(includes.filter((entry) => entry === "react-dom/client").length, 1)
  const resolved = baseline()
  resolved.optimizeDeps.include = [...includes, "react", "react-dom", "react/jsx-dev-runtime", "react/jsx-runtime"]
  assert.doesNotThrow(() => assertPipelineBrowserSafety(resolved))
})

test("resolved mock-mode safety requires the exact React DOM client entry and rejects missing, duplicate, alias and glob entries", () => {
  const seam = "react-dom/client"
  const missing = baseline()
  missing.optimizeDeps.include = missing.optimizeDeps.include!.filter((entry) => entry !== seam)
  assert.throws(() => assertPipelineBrowserSafety(missing), { message: "Vite mock-mode safety contract was not applied" })
  const duplicate = baseline()
  duplicate.optimizeDeps.include!.push(seam)
  assert.throws(() => assertPipelineBrowserSafety(duplicate), { message: "Vite mock-mode safety contract was not applied" })
  for (const alias of ["react-dom", "react-dom/client.js", "react-dom/*", "react-dom/**"]) {
    const config = baseline()
    config.optimizeDeps.include = config.optimizeDeps.include!.map((entry) => entry === seam ? alias : entry)
    assert.throws(() => assertPipelineBrowserSafety(config), { message: "Vite mock-mode safety contract was not applied" }, alias)
  }
})

test("publish fixture HTML has no favicon or image that violates img-src none", () => {
  const html = readFileSync(new URL("./publish-pipeline.html", import.meta.url), "utf8")
  assert.doesNotMatch(html, /<link\b[^>]*\brel\s*=\s*["'][^"']*\bicon\b[^"']*["']/i)
  assert.doesNotMatch(html, /data:,|<img\b/i)
})

const unsafe: [string, (config: PipelineBrowserSafetyConfig) => void][] = [
  ["additional include", (c) => { c.optimizeDeps.include!.push("unregistered-package") }],
  ["missing include", (c) => { c.optimizeDeps.include!.pop() }],
  ["duplicate include", (c) => { c.optimizeDeps.include!.push("react") }],
  ["unexpected replacement include", (c) => { c.optimizeDeps.include![0] = "unregistered-package" }],
  ["absent includes", (c) => { delete c.optimizeDeps.include }],
  ["empty includes", (c) => { c.optimizeDeps.include = [] }],
  ["dependency discovery", (c) => { c.optimizeDeps.noDiscovery = false }],
  ["absent discovery guard", (c) => { delete c.optimizeDeps.noDiscovery }],
  ["proxy", (c) => { c.server.proxy = { "/api": "http://fixture.invalid" } }],
  ["client warmup", (c) => { c.server.warmup = { clientFiles: ["src/main.tsx"] } }],
  ["SSR warmup", (c) => { c.server.warmup = { ssrFiles: ["src/main.tsx"] } }],
  ["HMR", (c) => { c.server.hmr = true }],
  ["HMR options", (c) => { c.server.hmr = {} }],
  ["absent HMR guard", (c) => { delete c.server.hmr }],
  ["websocket", (c) => { c.server.ws = {} }],
  ["absent websocket guard", (c) => { delete c.server.ws }],
  ["console forwarding", (c) => { c.server.forwardConsole.enabled = true }],
  ["environment directory", (c) => { c.envDir = "." }],
  ["missing dev-client removal plugin", (c) => { c.plugins = [] }],
  ["different plugin", (c) => { c.plugins = [{ name: "unrelated-plugin" }] }],
]
for (const [name, mutate] of unsafe) {
  test(`resolved mock-mode safety rejects ${name} before listen`, () => {
    const config = baseline()
    mutate(config)
    assert.throws(() => assertPipelineBrowserSafety(config), { message: "Vite mock-mode safety contract was not applied" })
  })
}

test("runner options keep native serving distinct from the unchanged default scenario mode", () => {
  assert.deepEqual(parsePipelineBrowserOptions([]), { mode: "run", scenario: "all" })
  assert.deepEqual(parsePipelineBrowserOptions(["--scenario=stop", "--output-root=/tmp/owned-evidence"]),
    { mode: "run", scenario: "stop", outputRoot: "/tmp/owned-evidence" })
  assert.deepEqual(parsePipelineBrowserOptions(["--serve", "--output-root=/tmp/owned-evidence"]),
    { mode: "serve", scenario: "all", outputRoot: "/tmp/owned-evidence" })
})

test("runner options reject unknown, empty, duplicate and mixed native/scenario arguments before startup", () => {
  for (const args of [["--port=80"], ["--serve=true"], ["--scenario="], ["--output-root="], ["--serve", "--serve"],
    ["--scenario=all", "--scenario=stop"], ["--output-root=a", "--output-root=b"], ["--serve", "--scenario=all"]]) {
    assert.throws(() => parsePipelineBrowserOptions(args), args.join(" "))
  }
})
