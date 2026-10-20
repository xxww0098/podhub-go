package submit

import "github.com/xxww0098/podhub-go/internal/listing/submit/domain"

type (
	JobPlan     = domain.JobPlan
	Reply       = domain.Reply
	Outcome     = domain.Outcome
	Edge        = domain.Edge
	UploadKey   = domain.UploadKey
	MediaSkip   = domain.MediaSkip
	Sight       = domain.Sight
	Found       = domain.Found
	ProbeMemory = domain.ProbeMemory
	ProbeAction = domain.ProbeAction
	DraftPeek   = domain.DraftPeek
	BatchBody   = domain.BatchBody
)

const (
	ImportDispatchChunk       = domain.ImportDispatchChunk
	ImportV3MaxItems          = domain.ImportV3MaxItems
	CodeWritesDisabled        = domain.CodeWritesDisabled
	CodeRowRejected           = domain.CodeRowRejected
	CodeRateLimited           = domain.CodeRateLimited
	CodeDispatchInterrupted   = domain.CodeDispatchInterrupted
	CodeCredentialInvalid     = domain.CodeCredentialInvalid
	CodePermissionDenied      = domain.CodePermissionDenied
	CodeAccessUnclassified    = domain.CodeAccessUnclassified
	CodeEgressUnreachable     = domain.CodeEgressUnreachable
	CodeEgressUnavailable     = domain.CodeEgressUnavailable
	CodeSubmitInFlight        = domain.CodeSubmitInFlight
	Queued                    = domain.Queued
	Submitting                = domain.Submitting
	Unknown                   = domain.Unknown
	Accepted                  = domain.Accepted
	Rejected                  = domain.Rejected
	Cancelled                 = domain.Cancelled
	Reconciled                = domain.Reconciled
	Conflict                  = domain.Conflict
	OperatorAttested          = domain.OperatorAttested
	Superseded                = domain.Superseded
	Begin                     = domain.Begin
	RejectQueued              = domain.RejectQueued
	RejectSubmitting          = domain.RejectSubmitting
	RejectBeforeAcceptance    = domain.RejectBeforeAcceptance
	AcceptSubmitting          = domain.AcceptSubmitting
	AcceptInFlight            = domain.AcceptInFlight
	AcceptUnknown             = domain.AcceptUnknown
	ParkSubmitting            = domain.ParkSubmitting
	ParkInFlight              = domain.ParkInFlight
	CancelBeforeDispatch      = domain.CancelBeforeDispatch
	CancelSubmitting          = domain.CancelSubmitting
	SubmitMaxAgeDays          = domain.SubmitMaxAgeDays
	MediaForeign              = domain.MediaForeign
	MediaExpired              = domain.MediaExpired
	ImportReconcileFirstWait  = domain.ImportReconcileFirstWait
	ImportProbePassCap        = domain.ImportProbePassCap
	CodeReconcileStillUnknown = domain.CodeReconcileStillUnknown
	SightAbsent               = domain.SightAbsent
	SightUnreadable           = domain.SightUnreadable
	SightFound                = domain.SightFound
)

var (
	Edges             = domain.Edges
	History           = domain.History
	ErrIllegalEdge    = domain.ErrIllegalEdge
	ErrBadRequest     = domain.ErrBadRequest
	ErrStoreRequired  = domain.ErrStoreRequired
	ErrStoreInvalid   = domain.ErrStoreInvalid
	ErrCardRequired   = domain.ErrCardRequired
	ErrRowsRequired   = domain.ErrRowsRequired
	ErrBatchTooLarge  = domain.ErrBatchTooLarge
	PlanImportJobs    = domain.PlanImportJobs
	Classify          = domain.Classify
	RecoverSubmitting = domain.RecoverSubmitting
	Apply             = domain.Apply
	Allows            = domain.Allows
	ParseUploadKey    = domain.ParseUploadKey
	ImageIssue        = domain.ImageIssue
	DecideProbe       = domain.DecideProbe
	IsDraft           = domain.IsDraft
	IsBatch           = domain.IsBatch
	PeekDraft         = domain.PeekDraft
	ParseBatch        = domain.ParseBatch
)
