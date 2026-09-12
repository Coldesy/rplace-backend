# GeekHaven × OpenCode — Pixel Canvas: Roadmap

Companion to `system-design.md`. This breaks the build into phases so work can be split across the team and tracked to a launch date.

---

## Phase 0 — Settle before writing code

These block downstream work if left open. Resolve first:

- [ ] Confirm OpenCode main DB access method for the Milestone Service (direct read-only credentials vs. a query endpoint they expose)
- [ ] Confirm exact event start date (this fixes the day-by-day growth schedule)
- [ ] Finalize the 16-color palette (exact hex values)
- [ ] Collect the fixed list of admin GitHub IDs for `admin_allowlist`
- [ ] Confirm Postgres/Redis hosting for staging (Render add-ons) and production (VM specs)

---

## Phase 1 — Core Canvas Engine (no auth, no tiers yet)

Goal: a working shared canvas with fixed cooldown, to validate the hardest technical piece first.

- [ ] Redis: `canvas:pixels` structure (packed byte encoding for 16-color palette)
- [ ] Redis: `canvas:bounds` (hardcode to 100×100 for this phase)
- [ ] WebSocket Gateway: connect, send full snapshot, receive placement requests
- [ ] Placement Validator: bounds check + palette check (skip cooldown/tier for now — allow any placement)
- [ ] Batched Broadcaster: buffer + binary diff broadcast (100–200ms window)
- [ ] Postgres: `pixel_log` table, append on every accepted placement
- [ ] React frontend: canvas render from initial snapshot + live diff updates
- [ ] Manual test: multiple browser tabs placing pixels concurrently, confirm no dropped/corrupted state

**Exit criteria:** two people in different tabs can see each other's pixels appear live, with no visual desync after a burst of rapid placements.

---

## Phase 2 — Cooldown & Buffer System

Goal: enforce the tier-based placement limits (still with hardcoded/manual tiers, before OpenCode integration).

- [ ] Redis: `user:<id>:tier` structure (manually seed test values for now)
- [ ] Redis: `pixels_left:<id>` burst-pool counter
- [ ] Lua script: atomic check-and-decrement (Section 3/4 of system-design.md)
- [ ] Placement Validator: wire in the buffer check before allowing a write
- [ ] Frontend: show remaining cooldown / pixels-left to the user, disable placement UI when exhausted
- [ ] Load test: simulate rapid double-clicks from the same user, confirm only the allowed count goes through

**Exit criteria:** a user with a manually-set "Leader" tier can place exactly 2 pixels per 8-minute window, no more, even under rapid-fire clicking.

---

## Phase 3 — OpenCode Integration (Milestone Service)

Goal: replace manually-seeded tiers with real, live data from OpenCode.

- [ ] Milestone Service: DB poller (60s interval), diff against last-seen points per user
- [ ] Redis Stream `tier-updates`: publish on tier crossing
- [ ] Canvas Service: Tier Update Consumer (`XREADGROUP` + `XACK`)
- [ ] Consumer writes to `user:<id>:tier` AND upserts `user_tier_cache` in Postgres (same handler)
- [ ] Verify: kill the Canvas Service mid-stream, restart, confirm no tier update is lost (this is the whole point of using Streams over Pub/Sub — test it explicitly)
- [ ] Enable Redis AOF persistence, verify tier data survives a Redis restart

**Exit criteria:** a real OpenCode point change results in the correct new cooldown/buffer values being applied on that user's next placement window, and this still works after restarting either service.

---

## Phase 4 — Auth & Moderation

- [ ] GitHub OAuth flow, session creation in `users` table
- [ ] Read-only viewer mode for unauthenticated connections
- [ ] `admin_allowlist` check at login, admin session flag
- [ ] Moderation dashboard: view pixel history for a user/region, revert a pixel/region
- [ ] Moderation actions: restrict, suspend, ban — all writing to `moderation_actions`
- [ ] Rate limiting (`ratelimit:<id>`) at the WebSocket layer, independent of cooldown

**Exit criteria:** an admin can log in, find a problematic pixel via history, revert it, and ban the user — with the action logged and the user's next placement attempt correctly rejected.

---

## Phase 5 — Canvas Growth

- [ ] Growth Scheduler: daily cron, linear interpolation formula (Section 7 of system-design.md)
- [ ] `canvas_epochs` table: record every size change
- [ ] `canvas-resized` WebSocket event, frontend viewport update on receipt
- [ ] Test on an accelerated clock (e.g., simulate a full 60-day cycle in a few hours on staging) before trusting it on the real calendar

**Exit criteria:** on staging, running the accelerated schedule produces the correct size at every checkpoint (day 0 = 100×100, day 60 = 1000×600), with existing art never shifting position.

---

## Phase 6 — Staging Validation (Render)

- [ ] Full end-to-end test with ~10–20 real accounts: login, placement, cooldown, tier upgrade, growth, moderation
- [ ] Confirm binary diff broadcast performs well at simulated 500-connection load
- [ ] Confirm Postgres backup job runs and produces restorable backups
- [ ] Dry-run the timelapse script against staging's `pixel_log`

---

## Phase 7 — Production Deployment (VM)

- [ ] Provision VM, install Redis with AOF enabled, Postgres with scheduled backups
- [ ] Deploy Canvas Service + Milestone Service
- [ ] Point event start date/time, confirm growth schedule anchors correctly
- [ ] Go live — read-only viewers can watch immediately, GitHub login opens placement

---

## Phase 8 — Post-Event

- [ ] Freeze the canvas (stop accepting placements) at day 60
- [ ] Run timelapse generation script against the full `pixel_log`
- [ ] Export/archive final canvas image and video
- [ ] Publish results / share timelapse with the community

---

## Suggested ownership split

| Area | Depends on |
|---|---|
| Canvas Engine + Broadcaster (Phase 1) | Nothing — start immediately |
| Cooldown/Buffer Lua logic (Phase 2) | Phase 1's Placement Validator hook |
| Milestone Service + Streams (Phase 3) | Phase 0's OpenCode DB access decision |
| Auth + Moderation (Phase 4) | Can be built in parallel with Phases 1–3 |
| Growth Scheduler (Phase 5) | Can be built in parallel, only needs `canvas:bounds` to exist |
| Frontend (canvas render, cooldown UI, admin dashboard UI) | Can start in parallel against a mocked WebSocket API, integrate as backend phases land |

Phases 1, 4, and 5 can genuinely happen in parallel across different people. Phase 3 is the one with an external dependency (Phase 0's OpenCode access question) — flag that early so it doesn't become the bottleneck.
