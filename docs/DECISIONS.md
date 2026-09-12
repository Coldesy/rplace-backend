# Architecture Decisions

## Status

This file records decisions made while implementing the prototype.

## ADR-001: Prototype uses mock authentication

Status: Accepted

The first prototype uses a local mock user selector instead of GitHub OAuth.
Real OAuth will be added only after the core placement and realtime flows work.

## ADR-002: Prototype uses a fixed 100x100 canvas

Status: Accepted

Canvas growth is deferred until the initial placement, persistence, and reconnect flows are tested.

## ADR-003: Prototype uses idempotent placement IDs

Status: Accepted

Every placement request includes a unique `placement_id`.
A repeated request with the same ID must return the original result and must not consume capacity again.

Redis stores `idempotency:placement:{placement_id}` for 24 hours.
`pixel_log.placement_id` remains the durable unique constraint if that key expires.

## ADR-004: Production consistency decisions are deferred

Status: Open

The exact Redis/PostgreSQL consistency and recovery model requires a separate decision before production deployment.

The prototype does not rebuild Redis from `pixel_log` on startup. If Redis is empty while the log has rows, the server logs a warning and starts from a blank live canvas.

## ADR-005: JSON WebSocket messages for the first slice

Status: Accepted

The first prototype uses JSON text frames for hello, place, snapshot, acks, and diffs.
Packed binary broadcasts are deferred until the placement path is tested.

## ADR-006: Prototype dual-write accept rule

Status: Accepted (prototype only)

A placement is accepted only if the Redis live write and the `pixel_log` insert both succeed.
If the log insert fails, the server restores the previous pixel in Redis, deletes the idempotency key, and deletes the Redis stream event.
The consumed sequence number is not reused (a seq hole is allowed).

This is not the production consistency model. ADR-004 stays Open.

## ADR-007: Fixed 16-color palette until Phase 0 hex values land

Status: Accepted

`packages/shared` ships a 16-color palette for the prototype.
Exact event hex values remain a Phase 0 item.
