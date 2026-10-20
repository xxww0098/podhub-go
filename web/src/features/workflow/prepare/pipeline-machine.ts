/** Row status vocabulary for the prepare pipeline: pending → (AI ∥ render → S3) → review → ready → sent. */

export type TrackStatus = "idle" | "running" | "done" | "failed"

export type PipelineRowStatus =
  | "pending"
  | "running"
  | "review"
  | "ready"
  | "sent"
  | "exception"
  | "failed"
