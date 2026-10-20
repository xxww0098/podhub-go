import type { ResolvedConfig } from "vite"

export type PipelineBrowserRunnerOptions = { mode: "run" | "serve"; scenario: string; outputRoot?: string }

/** Parse before starting resources. Native serving and automated scenarios are distinct modes. */
export function parsePipelineBrowserOptions(args: readonly string[]): PipelineBrowserRunnerOptions {
  const result: PipelineBrowserRunnerOptions = { mode: "run", scenario: "all" }
  const seen = new Set<string>()
  for (const arg of args) {
    const key = arg.split("=", 1)[0]!
    if (seen.has(key)) throw new Error("Duplicate runner option")
    seen.add(key)
    if (arg === "--serve") result.mode = "serve"
    else if (arg.startsWith("--scenario=") && arg.slice(11)) result.scenario = arg.slice(11)
    else if (arg.startsWith("--output-root=") && arg.slice(14)) result.outputRoot = arg.slice(14)
    else throw new Error("Only --serve, --scenario=all|name and --output-root=directory are supported")
  }
  if (result.mode === "serve" && seen.has("--scenario")) throw new Error("--serve cannot run scenarios")
  return result
}

/** Only the resolved settings used by the fixture's pre-listen safety check. */
export type PipelineBrowserSafetyConfig = {
  envDir: ResolvedConfig["envDir"]
  optimizeDeps: Pick<ResolvedConfig["optimizeDeps"], "include" | "noDiscovery">
  server: Pick<ResolvedConfig["server"], "proxy" | "hmr" | "ws" | "warmup"> & {
    forwardConsole: Pick<ResolvedConfig["server"]["forwardConsole"], "enabled">
  }
  plugins: readonly { name: string }[]
}

export function assertPipelineBrowserSafety(config: PipelineBrowserSafetyConfig): void {
  // React's plugin adds four entries; Base UI's store eagerly imports both CJS shims.
  // The fixture's createRoot import needs the distinct React DOM client CJS entry.
  // Zustand imports the selector with .js; that exact specifier needs its own entry.
  // Lucide's installed icon barrel needs one fixed entry to avoid per-icon fanout.
  // noDiscovery forbids crawling; missing, duplicate or extra entries fail closed.
  const expectedIncludes = ["@base-ui/react > use-sync-external-store/shim", "@base-ui/react > use-sync-external-store/shim/with-selector",
    "lucide-react", "react", "react-dom", "react-dom/client", "react/jsx-dev-runtime", "react/jsx-runtime",
    "zustand > use-sync-external-store/shim/with-selector.js"]
  const includes = [...(config.optimizeDeps.include ?? [])].sort()
  if (config.envDir !== false || Object.keys(config.server.proxy ?? {}).length || config.server.hmr !== false || config.server.ws !== false
    || config.optimizeDeps.noDiscovery !== true || JSON.stringify(includes) !== JSON.stringify(expectedIncludes)
    || (config.server.warmup?.clientFiles?.length ?? 0) !== 0 || (config.server.warmup?.ssrFiles?.length ?? 0) !== 0
    || config.server.forwardConsole.enabled !== false || !config.plugins.some((plugin) => plugin.name === "podhub-mock-gate-without-dev-client")) {
    throw new Error("Vite mock-mode safety contract was not applied")
  }
}
