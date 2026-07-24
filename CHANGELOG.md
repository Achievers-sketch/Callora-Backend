# Changelog

## Unreleased

### Added

- Stamp `Deprecation: true` and `Sunset: 2026-12-31T00:00:00.000Z` on legacy `/v1` responses and emit a structured warning log with the request correlation ID whenever a legacy endpoint is used.

### Fixed

- Return `400 BAD_REQUEST` from `POST /api/billing/deduct` when a client provides a null or empty `developerId` instead of allowing the request to proceed into billing logic.
