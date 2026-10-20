import {
  useCallback,
  useRef,
  useState,
  type DragEvent,
  type RefCallback,
} from "react"

type FileDropTargetOptions = {
  disabled?: boolean
  onDropFiles?: (files: File[]) => void
  onEmptyDrop?: () => void
}

/** One visual drop zone over the DOM drag/drop events. */
export function useFileDropTarget<T extends HTMLElement>({
  disabled = false,
  onDropFiles,
  onEmptyDrop,
}: FileDropTargetOptions): {
  ref: RefCallback<T>
  dragging: boolean
  dropProps: {
    onDragEnter: (event: DragEvent<T>) => void
    onDragOver: (event: DragEvent<T>) => void
    onDragLeave: (event: DragEvent<T>) => void
    onDrop: (event: DragEvent<T>) => void
  }
} {
  const elementRef = useRef<T | null>(null)
  const [dragging, setDragging] = useState(false)
  const disabledRef = useRef(disabled)
  const onDropFilesRef = useRef(onDropFiles)
  const onEmptyDropRef = useRef(onEmptyDrop)

  disabledRef.current = disabled
  onDropFilesRef.current = onDropFiles
  onEmptyDropRef.current = onEmptyDrop

  const ref = useCallback<RefCallback<T>>((element) => {
    elementRef.current = element
  }, [])

  const onDragEnter = useCallback((event: DragEvent<T>) => {
    event.preventDefault()
    if (!disabledRef.current) setDragging(true)
  }, [])

  const onDragOver = useCallback((event: DragEvent<T>) => {
    event.preventDefault()
    if (!disabledRef.current) setDragging(true)
  }, [])

  const onDragLeave = useCallback((event: DragEvent<T>) => {
    event.preventDefault()
    const nextTarget = event.relatedTarget
    if (nextTarget && event.currentTarget.contains(nextTarget as Node)) return
    setDragging(false)
  }, [])

  const onDrop = useCallback((event: DragEvent<T>) => {
    event.preventDefault()
    setDragging(false)
    if (disabledRef.current) return

    const files = Array.from(event.dataTransfer.files)
    if (files.length && onDropFilesRef.current) onDropFilesRef.current(files)
    else onEmptyDropRef.current?.()
  }, [])

  return {
    ref,
    dragging,
    dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop },
  }
}
