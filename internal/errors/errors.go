package errors

import "errors"

// Sentinel errors representing standard operational and domain failure conditions.
var (
	// ErrConfiguration indicates a missing, malformed, or invalid configuration.
	ErrConfiguration = errors.New("configuration error")

	// ErrNotFound indicates a requested entity, backup, or file was not found.
	ErrNotFound = errors.New("not found")

	// ErrUnauthorized indicates an authentication or permission failure.
	ErrUnauthorized = errors.New("unauthorized")

	// ErrConflict indicates an operation conflicted with existing state or lock.
	ErrConflict = errors.New("state conflict")

	// ErrPrerequisite indicates a required dependency, daemon, or tool is missing.
	ErrPrerequisite = errors.New("prerequisite not met")

	// ErrInternal indicates an unrecoverable system or filesystem failure.
	ErrInternal = errors.New("internal error")
)
