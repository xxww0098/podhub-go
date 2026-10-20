/** The File just picked, so backup can slice parts without reading OPFS into one buffer. */
const files = new Map<string, File>()
const handles = new Map<string, FileSystemFileHandle>()
const handleOfFile = new WeakMap<File, FileSystemFileHandle>()

export function noteTemplateHandle(file: File, handle: FileSystemFileHandle): void {
  handleOfFile.set(file, handle)
}

export function rememberTemplateFile(sha256: string, file: File): void {
  files.set(sha256, file)
  const handle = handleOfFile.get(file)
  if (handle) handles.set(sha256.toLowerCase(), handle)
}

export function rememberedTemplateFile(sha256: string): File | undefined {
  return files.get(sha256)
}

export function rememberedTemplateHandle(sha256: string): FileSystemFileHandle | undefined {
  return handles.get(sha256.toLowerCase())
}

export function rememberTemplateHandle(sha256: string, handle: FileSystemFileHandle): void {
  handles.set(sha256.toLowerCase(), handle)
}
