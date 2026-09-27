# CLAW.md — project instructions

This is the CLAW repo itself: a zero-dependency terminal coding agent written
in native TypeScript (Node >= 23.6, no build step, no runtime deps).

## Build & test

- `npm run typecheck` — tsc --noEmit (must be clean before any commit)
- `npm run selfcheck` — the built-in assertion suite (src/selfcheck.ts); every
  feature ships with assertions here. Must stay green.
- `node src/cli.ts` — run the agent; `-M` forces the offline scripted mock.
- `node src/cli.ts serve -p 8790 -M` — the web workbench.

## Conventions

- Zero runtime dependencies. Never add an npm package to src/ — stdlib only.
- OpenAI wire format is the canonical internal message shape; providers are
  thin adapters (src/providers/).
- Security lives in guards.ts hook points, not inside tools. Tools stay simple
  and confine paths defensively anyway (defense in depth).
- The workbench (web/index.html) is one vanilla HTML/CSS/JS file — no
  frameworks. Keep the Apple-clean dark token system in :root; one accent
  color (green), used only where motivated.
- Comments explain WHY, never WHAT.

## Layout

- src/agent.ts — the TAOR loop; src/guards.ts — the seven hook points.
- src/tools/* — one action per file, registered in src/cli.ts.
- src/serve.ts — HTTP channel + operator approval broker (POST /approve).
- docs/ — architecture research; ../claw-docs and ../claw-orchestrator are
  the design sources this mirrors.
