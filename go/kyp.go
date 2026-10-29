// Package kyp is the Go SDK for Keep Your Prompts.
//
//	prompts, err := kyp.FromEnv(ctx) // KYP_DELIVERY_KEY, KYP_APP, KYP_ENV
//	if err != nil { ... }
//	defer prompts.Close()
//	text, err := prompts.Render("triage", kyp.Vars{"company": "Acme"})
//
// It implements prompt delivery protocol v1 (protocol/README.md in the SDK
// repository): interchangeable mirrors with one layout (envs/<app>/<env>.json
// plus content-addressed blobs/<sha256>), SHA-256 verification of every blob,
// ETag revalidation, a background refresher with jitter and backoff, an
// optional disk cache, and an atomic in-memory swap. Reads (Get, Render,
// Prompt) never do I/O and never take a lock.
//
// Ship a snapshot inside the binary to start with zero network:
//
//	//go:embed prompts
//	var snapshot embed.FS
//
//	prompts, err := kyp.FromEnv(ctx, kyp.WithEmbeddedSnapshot(snapshot))
//
// The package uses the standard library only.
package kyp

import (
	"errors"
	"fmt"
	"strings"
)

// Version is the SDK version.
const Version = "0.1.0"

// Sentinel errors. Use errors.Is to test for them.
var (
	// ErrNotFound: the prompt name is not in the deployed manifest.
	ErrNotFound = errors.New("kyp: prompt not found")
	// ErrMissingVariable: Render was called without a value for a {{variable}}.
	ErrMissingVariable = errors.New("kyp: missing template variable")
	// ErrUnavailable: no mirror could deliver a manifest during start-up.
	ErrUnavailable = errors.New("kyp: prompts unavailable")
	// ErrProtocol: a mirror returned something that does not follow the protocol.
	ErrProtocol = errors.New("kyp: protocol error")
	// ErrClosed: the client was closed (only returned by Refresh).
	ErrClosed = errors.New("kyp: client closed")
	// ErrOutcomesDisabled: RecordOutcome was called without an API or delivery key.
	ErrOutcomesDisabled = errors.New("kyp: outcome reporting is not configured (set KYP_API_KEY)")
)

// NotFoundError is returned by Get, Prompt and Render for an unknown name.
type NotFoundError struct {
	Name   string
	Detail string // e.g. "demo/prod revision 12"
}

func (e *NotFoundError) Error() string {
	if e.Detail == "" {
		return fmt.Sprintf("kyp: prompt not found: %q", e.Name)
	}
	return fmt.Sprintf("kyp: prompt not found: %q (%s)", e.Name, e.Detail)
}

// Is makes errors.Is(err, ErrNotFound) true.
func (e *NotFoundError) Is(target error) bool { return target == ErrNotFound }

// MissingVariableError lists every variable a strict Render had no value for,
// in order of first appearance.
type MissingVariableError struct {
	Names []string
}

func (e *MissingVariableError) Error() string {
	if len(e.Names) == 1 {
		return "kyp: missing template variable: " + e.Names[0]
	}
	return "kyp: missing template variables: " + strings.Join(e.Names, ", ")
}

// Is makes errors.Is(err, ErrMissingVariable) true.
func (e *MissingVariableError) Is(target error) bool { return target == ErrMissingVariable }

// ProtocolError describes a manifest or blob that does not follow the protocol.
type ProtocolError struct {
	Msg string
}

func (e *ProtocolError) Error() string { return "kyp: " + e.Msg }

// Is makes errors.Is(err, ErrProtocol) true.
func (e *ProtocolError) Is(target error) bool { return target == ErrProtocol }

func protocolErrorf(format string, args ...any) error {
	return &ProtocolError{Msg: fmt.Sprintf(format, args...)}
}

// unavailableError wraps ErrUnavailable with the reason.
type unavailableError struct{ msg string }

func (e *unavailableError) Error() string        { return "kyp: " + e.msg }
func (e *unavailableError) Is(target error) bool { return target == ErrUnavailable }
