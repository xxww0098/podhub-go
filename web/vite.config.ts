import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

import { changelogJsonFromRoot } from "./vite.changelog.ts"
import { productVersionFromRoot } from "./vite.product-version.ts"

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  // Public product images use no-cors URLs; credentialless keeps them usable
  // without requiring every external image host to emit CORP.
  "Cross-Origin-Embedder-Policy": "credentialless",
}

// Mock gate (PODHUB_MOCK_GATE=1, set by the goal gate commands and
// tests/run-mock-browser.ts): Vite must not load any env file, must not forward
// /api or /mcp to a Cloud process, must not open an HMR
// WebSocket and must not forward the page console to the terminal (forwardConsole
// defaults on when Vite detects an agent environment). It also skips dependency
// discovery and warmup, which would crawl and pre-transform the whole
// application for a fixture page that loads only its own modules. Everything
// else — plugins, alias, isolation headers, module transforms — stays shared;
// production builds read none of these dev-server settings.
const mockGate = process.env.PODHUB_MOCK_GATE === "1"

/**
 * Mock gate only: take the injected Vite dev client out of served HTML.
 *
 * Installed Vite 8.2.x (8.2.2 at the time of writing) injects
 * `<script type="module" src="<base>@vite/client">` into every dev HTML page
 * from its built-in `devHtmlHook`, whatever `server.hmr` / `server.ws` say, and
 * that client calls `transport.connect()` on load — so `hmr: false` and
 * `ws: false` still leave the page opening a WebSocket to the dev server, which
 * the browser guard rightly counts as unknown. This version has no option that
 * skips the injection, so this `post` hook (it runs after `devHtmlHook`)
 * removes exactly that one tag. Nothing else changes: fixture modules, WASM
 * and JSON are still transformed and served by the same plugins, and the
 * browser guard still counts every request. A module that imports the client
 * itself (e.g. through `import.meta.hot`) is not hidden: its socket attempt
 * stays an unknown attempt.
 *
 * Exactly one tag must be found; otherwise the hook fails the page instead of
 * silently serving the client. Remove this plugin when the installed Vite can
 * serve a dev page without its client, or when gate fixtures are served from a
 * build instead of the dev server. Ordinary dev and production builds never
 * include it.
 */
function mockGateWithoutDevClient(): Plugin {
  let clientTag = ""
  return {
    name: "podhub-mock-gate-without-dev-client",
    apply: "serve",
    configResolved(config) {
      clientTag = `<script type="module" src="${path.posix.join(config.base, "/@vite/client")}"></script>`
    },
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        const parts = html.split(clientTag)
        if (parts.length !== 2) {
          throw new Error(`[mock-gate] expected exactly one injected Vite dev client tag in ${context.path}, found ${parts.length - 1}`)
        }
        return parts.join("")
      },
    },
  }
}

// Charts stay lazy in production; pre-bundle their modular entry seams in
// dev so the deferred graph is ready when the overview becomes visible.
const devOptimizeDeps = {
  include: ["echarts/core", "echarts/charts", "echarts/components", "echarts/renderers"],
}

const devWarmup = {
  clientFiles: ["./index.html", "./src/main.tsx", "./src/app/App.tsx", "./src/features/account/login-screen.tsx"],
}

// Production serves the SPA same-origin with the API;
// in development they are two processes, so Vite forwards `/api` and `/mcp`; the
// browser still sees one origin. `changeOrigin` stays false: the Cloud CSRF
// middleware compares the request's `Origin` host against `Host`, and
// rewriting `Host` to the target would make every dev call look cross-site.
const cloudProxy = {
  "/mcp": {
    target: process.env.DEV_CLOUD_URL ?? "http://127.0.0.1:8080",
    changeOrigin: false,
  },
  "/api": {
    target: process.env.DEV_CLOUD_URL ?? "http://127.0.0.1:8080",
    changeOrigin: false,
  },

}

export default defineConfig({
  ...(mockGate ? { envDir: false as const } : {}),
  plugins: [react(), tailwindcss(), ...(mockGate ? [mockGateWithoutDevClient()] : [])],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  optimizeDeps: mockGate ? {
    noDiscovery: true,
    // Base UI's installed useStore.mjs statically imports both CommonJS shims,
    // including with-selector on React 19. Resolve through its declared dependency
    // because neither shim is a top-level workspace dependency. No discovery/globs.
    include: [
      "@base-ui/react > use-sync-external-store/shim",
      "@base-ui/react > use-sync-external-store/shim/with-selector",
      // Zustand's ESM importer spells out .js. Vite matches nested optimizer
      // specifiers exactly even when both spellings resolve to the same file.
      "zustand > use-sync-external-store/shim/with-selector.js",
      // Its installed ESM barrel re-exports individual icons; bundle this exact
      // entry to avoid requesting the entire icon graph without discovery.
      "lucide-react",
      // The fixture imports createRoot from this separate CommonJS subpath;
      // the React plugin's react-dom root entry does not cover it.
      "react-dom/client",
    ],
  } : devOptimizeDeps,
  define: {
    "import.meta.env.PODHUB_VERSION": JSON.stringify(productVersionFromRoot(import.meta.dirname)),
    "import.meta.env.PODHUB_CHANGELOG": JSON.stringify(changelogJsonFromRoot(import.meta.dirname)),
  },
  // The render worker loads the committed `wasm/dist/browser/render/render_wasm.wasm` via `import.meta.url`.
  worker: { format: "es" },
  clearScreen: false,
  preview: { headers: isolationHeaders },
  server: {
    headers: isolationHeaders,
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    // bun installs under the repo-root node_modules/.bun store and
    // pnpm-workspace.yaml makes Vite treat web/ as the workspace root, so
    // fontsource assets must be allowed explicitly or dev serves them 403.
    // The committed artifacts live in the repo-root wasm/dist, above this root,
    // so Vite serves them through /@fs; the repo parent is allowed, never wider.
    fs: { allow: [import.meta.dirname, path.resolve(import.meta.dirname, "..")] },
    ...(mockGate ? { hmr: false, ws: false as const, forwardConsole: false } : { proxy: cloudProxy, warmup: devWarmup }),
  },
})
