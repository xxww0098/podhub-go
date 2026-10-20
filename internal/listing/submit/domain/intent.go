// Package submit is the listing submit pipeline and the submission_intents
// state machine.
//
// The eleven named edges are IntentTransition in
// src/listing/kernel/submission/intent_transition.rs at a03d735. from is the
// SQL `state = ANY(...)` fence. to is the assigned literal. Requeue,
// release-unknown, operator attestation, reconcile, and supersede are
// different statements. They are not edges in this table.
package domain

import "errors"

// States of submission_intents. The last four are intent history. No named
// submit edge reads or writes them.
const (
	Queued           = "queued"
	Submitting       = "submitting"
	Unknown          = "unknown"
	Accepted         = "accepted"
	Rejected         = "rejected"
	Cancelled        = "cancelled"
	Reconciled       = "reconciled"
	Conflict         = "conflict"
	OperatorAttested = "operator_attested"
	Superseded       = "superseded"
)

// Edges is the production order in the Rust table test.
var Edges = []Edge{
	Begin,
	RejectQueued,
	RejectSubmitting,
	RejectBeforeAcceptance,
	AcceptSubmitting,
	AcceptInFlight,
	AcceptUnknown,
	ParkSubmitting,
	ParkInFlight,
	CancelBeforeDispatch,
	CancelSubmitting,
}

// History states. Named edges must not use them.
var History = []string{Reconciled, Conflict, OperatorAttested, Superseded}

type Edge int

const (
	Begin Edge = iota
	RejectQueued
	RejectSubmitting
	RejectBeforeAcceptance
	AcceptSubmitting
	AcceptInFlight
	AcceptUnknown
	ParkSubmitting
	ParkInFlight
	CancelBeforeDispatch
	CancelSubmitting
)

func (e Edge) String() string {
	names := [...]string{
		"Begin",
		"RejectQueued",
		"RejectSubmitting",
		"RejectBeforeAcceptance",
		"AcceptSubmitting",
		"AcceptInFlight",
		"AcceptUnknown",
		"ParkSubmitting",
		"ParkInFlight",
		"CancelBeforeDispatch",
		"CancelSubmitting",
	}
	if e < 0 || int(e) >= len(names) {
		return "invalid"
	}
	return names[e]
}

// From is the SQL fence. ParkSubmitting is only submitting, so an unknown
// row is not refreshed. ParkInFlight includes unknown so a lost response
// may restamp.
func (e Edge) From() []string {
	switch e {
	case Begin, RejectQueued:
		return []string{Queued}
	case RejectSubmitting, AcceptSubmitting, ParkSubmitting, CancelSubmitting:
		return []string{Submitting}
	case RejectBeforeAcceptance, CancelBeforeDispatch:
		return []string{Queued, Submitting}
	case AcceptInFlight, ParkInFlight:
		return []string{Submitting, Unknown}
	case AcceptUnknown:
		return []string{Unknown}
	default:
		return nil
	}
}

// To is the assigned state literal.
func (e Edge) To() string {
	switch e {
	case Begin:
		return Submitting
	case RejectQueued, RejectSubmitting, RejectBeforeAcceptance:
		return Rejected
	case AcceptSubmitting, AcceptInFlight, AcceptUnknown:
		return Accepted
	case ParkSubmitting, ParkInFlight:
		return Unknown
	case CancelBeforeDispatch, CancelSubmitting:
		return Cancelled
	default:
		return ""
	}
}

// OnlyFrom is the single predecessor. Wider edges panic in Rust; here they
// return an error so a test can fail them without crashing the process.
func (e Edge) OnlyFrom() (string, error) {
	from := e.From()
	if len(from) != 1 {
		return "", errors.New("intent transition is not a single predecessor")
	}
	return from[0], nil
}

// ErrIllegalEdge means this pair is not a named submit edge.
var ErrIllegalEdge = errors.New("illegal submission intent edge")

// Apply moves from along edge. A state outside From is an error and must
// not be written.
func Apply(from string, edge Edge) (string, error) {
	for _, allowed := range edge.From() {
		if from == allowed {
			to := edge.To()
			if to == "" {
				return "", ErrIllegalEdge
			}
			return to, nil
		}
	}
	return "", ErrIllegalEdge
}

// Allows reports whether any named edge moves from to to.
func Allows(from, to string) bool {
	for _, edge := range Edges {
		if edge.To() != to {
			continue
		}
		for _, candidate := range edge.From() {
			if candidate == from {
				return true
			}
		}
	}
	return false
}
