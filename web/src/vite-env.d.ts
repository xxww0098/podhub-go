/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly PODHUB_VERSION: string
  /** JSON array of the newest changelog releases, injected at build time. */
  readonly PODHUB_CHANGELOG: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
