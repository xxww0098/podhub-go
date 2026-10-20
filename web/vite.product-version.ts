import { readFileSync } from "node:fs"
import path from "node:path"

/** Root `VERSION` (`X.Y.Z`) for Vite `define`. */
export function productVersionFromRoot(fromDir: string): string {
  const version = readFileSync(path.resolve(fromDir, "../VERSION"), "utf8").trim()
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`VERSION must be X.Y.Z, got: ${version}`)
  }
  return version
}
