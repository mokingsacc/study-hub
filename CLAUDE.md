# Study Hub: notes for Claude Code

This repository is one person's own Study Hub (a Cloudflare Worker with D1, R2, Vectorize, Workers AI and a Durable
Object). They own it; help them change it the way they ask, in plain words.

## How it fits together
- worker/src/index.js serves the Study Hub only (PLATFORM=1, HUB_OFF=1). The Study Hub's own code is in
  worker/src/platform/ (each feature a module listed in features.js: ROUTES for /api/p/*, TOOLS for their Claude's
  connector, CHECKS for the self-check). It reuses the map engine in worker/src/map/ (topics, scores, writeBatch for
  every change with undo).
- public/platform.html and public/js/platform/ are the page: plain ES modules, h() and textContent only (no
  innerHTML), lazily imported screens. A new public file must be added to PLATFORM_FILES in worker/src/index.js or
  it is not served.
- worker/migrations/: the database, applied in order on every deploy. Never edit an old migration; add a new one
  (numbered after the last), and give every new table a user_id column.
- docs/api.md lists the routes; docs/free-plan.md the free-plan limits.

## Rules
- Every query names user_id; a request's user comes from its session, never from its body.
- Keep each request well under 10 ms of CPU (the free plan's limit) and one D1 batch where you can.
- Plain, friendly words in the page; no jargon.

## Before you push
- npm test (all must pass). Add a test for what you change.
- npm run dev to try it at http://localhost:8787.
- Pushing to the main branch redeploys the hub (npm run deploy applies new migrations first).
