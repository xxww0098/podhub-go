package readhttp

import "github.com/xxww0098/podhub-go/internal/listing/read/domain"

type (
	WatchedCard = domain.WatchedCard
	EventPage   = domain.EventPage
	Replay      = domain.Replay
	ReplayItem  = domain.ReplayItem
)

const (
	CardEventChannel     = domain.CardEventChannel
	StreamBatch          = domain.StreamBatch
	StreamRetainedEvents = domain.StreamRetainedEvents
	StreamLiveBuffer     = domain.StreamLiveBuffer
	MaxWatchedCards      = domain.MaxWatchedCards
	SSEKeepAlive         = domain.SSEKeepAlive
	MaxCursorMicros      = domain.MaxCursorMicros
)

var (
	WatchCards            = domain.WatchCards
	ParseCardHint         = domain.ParseCardHint
	ClassifyReplay        = domain.ClassifyReplay
	UUIDText              = domain.UUIDText
	PageFetch             = domain.PageFetch
	ParseLimit            = domain.ParseLimit
	ParseCursor           = domain.ParseCursor
	CanonicalUUID         = domain.CanonicalUUID
	FormatCursor          = domain.FormatCursor
	ReadReplay            = domain.ReadReplay
	FormatSSE             = domain.FormatSSE
	RowRemoveData         = domain.RowRemoveData
	CardInvalidateData    = domain.CardInvalidateData
	ResetData             = domain.ResetData
	PrepareCard           = domain.PrepareCard
	CreateFingerprint     = domain.CreateFingerprint
	AssociationIdentity   = domain.AssociationIdentity
	ProjectRow            = domain.ProjectRow
	SummaryOf             = domain.SummaryOf
	HydratePayload        = domain.HydratePayload
	SchemaRevisionToFetch = domain.SchemaRevisionToFetch
)

type (
	DocError        = domain.DocError
	StoredRow       = domain.StoredRow
	RowView         = domain.RowView
	SnapshotSummary = domain.SnapshotSummary
)
