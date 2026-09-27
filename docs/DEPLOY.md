# CLAW — Production Deployment & Scaling Guide

Everything you need to run `claw serve` for real: deployment modes, security
hardening, scaling from one box to many, observability, and cost governance.
(For *how the code works*, read [GUIDE.md](GUIDE.md); for *how it was built*,
read [BUILD.md](BUILD.md).)

---

## 1. Choose your deployment shape

CLAW is one Node process with no mandatory external dependencies — that
drives every recommendation below.

| Shape | Use when | What runs |
| --- | --- | --- |
| **A. Personal / single user** | just you, one machine | `claw serve` behind nothing (localhost) |
| **B. Team workbench** | a small team, one shared box or VM | `claw serve` behind Nginx/Caddy + auth, one process |
| **C. Multi-tenant service** | many users, many workspaces | N instances behind a load balancer, sessions on shared storage (see §4) |

Start with A. Only go to C when B actually hurts — the session store is the
only stateful part (§4.2).

## 2. The deployable unit

The whole agent is `E:\ACode\claw` — Node ≥ 23.6, **zero runtime npm
dependencies**. Deploy = copy the folder (or the git repo) and run:

```bash
node src/cli.ts serve --host 127.0.0.1 --port 8787 -y
```

- `--host 127.0.0.1` keeps the agent off the public internet; a reverse
  proxy (§3) provides TLS and auth.
- `-y` (`autoApprove`) **skips the human approval gate** — required for
  headless operation, and the reason every other hardening measure below
  matters. If you cannot accept that, do not run `-y`; risky tools will be
  denied and the agent will simply work read-only.
- **Never** run as root/Administrator. The agent has a `shell` tool; the
  OS user it runs as is your real security boundary.

### 2.1 A minimal production environment

```bash
# .env (permissions 600, never commit)
CLAW_API_KEY=MY_ENV_VAR_NAME          # name of the env var holding the key
MY_ENV_VAR_NAME=sk-...
CLAW_WORKSPACE=/srv/workspaces/demo   # the ONE folder the agent may touch
CLAW_SEARCH_PROVIDER=tavily
TAVILY_API_KEY=tvly-...
```

Config layering still applies (flags > `.claw.json` > `~/.claw/config.json`
> env > defaults), so pin the model in the workspace's `.claw.json`:

```jsonc
{
  "baseURL": "https://api.openai.com/v1",
  "model": "gpt-4o-mini",          // PIN the model — provider prompt caches hit
  "maxIterations": 16,
  "outputCap": 4000,
  "autoApprove": true,
  "riskyTools": ["shell", "git_commit"],
  "shellAllowlist": ["echo", "pwd", "ls", "npm test"],
  "subagents": { "enabled": true, "maxDepth": 2, "timeoutMs": 60000, "maxConcurrency": 4 }
}
```

### 2.2 Process supervision

Any supervisor works; the process is stateless apart from `~/.claw`.

**systemd:**

```ini
# /etc/systemd/system/claw.service
[Unit]
Description=CLAW coding agent
After=network-online.target

[Service]
User=claw
Group=claw
WorkingDirectory=/srv/claw
EnvironmentFile=/srv/claw/.env
ExecStart=/usr/bin/node /srv/claw/src/cli.ts serve --host 127.0.0.1 --port 8787 -y
Restart=on-failure
RestartSec=3
# Hardening: the agent can run commands, so box in what the OS allows.
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/srv/workspaces /home/claw/.claw
PrivateTmp=true
MemoryMax=2G

[Install]
WantedBy=multi-user.target
```

`ProtectSystem=strict` + `ReadWritePaths` enforces at the kernel level what
the path-confine guard enforces at the application level — defense in depth.

**Windows:** `nssm install claw "C:\Program Files\nodejs\node.exe" "E:\ACode\claw\src\cli.ts serve --host 127.0.0.1 --port 8787 -y"`, or a
scheduled task at startup. Run the service under a dedicated low-privilege
account; `icacls` the workspace folder down to that account only.

**Docker:**

```dockerfile
FROM node:25-slim
RUN apt-get update && apt-get install -y git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
ENV CLAW_WORKSPACE=/workspace
RUN useradd -m claw && mkdir -p /workspace /home/claw/.claw && chown -R claw:claw /workspace /home/claw
USER claw
EXPOSE 8787
CMD ["node", "src/cli.ts", "serve", "--host", "0.0.0.0", "--port", "8787", "-y"]
```

```bash
docker run -d --name claw \
  -v /srv/workspaces/demo:/workspace \
  -v claw-state:/home/claw/.claw \
  --env-file .env \
  --memory 2g --pids-limit 256 \
  --read-only --tmpfs /tmp \
  -p 127.0.0.1:8787:8787 \
  claw:latest
```

Notes: mount the workspace read-write (that's the point), keep `~/.claw`
on a volume so sessions and OAuth tokens survive restarts, `--read-only`
rootfs + `--pids-limit` because the `shell` tool is arbitrary command
execution by design. If you need container-to-container isolation per
tenant, one container per tenant with its own workspace volume is the
correct unit of isolation.

## 3. Put TLS and auth in front (shape B)

`claw serve` speaks plain HTTP and has **no built-in authentication** —
the VS Code extension's model is "localhost is the trust boundary". For
anything network-exposed, terminate TLS at a proxy and authenticate there.

**Caddy (simplest, automatic HTTPS):**

```caddy
claw.example.com {
    # 1) your SSO / identity proxy decides who may in
    forward_auth authelia:9091 { url http://idp/api/verify }
    # 2) only the chat + health endpoints
    handle /chat* { reverse_proxy 127.0.0.1:8787 }
    handle /health { reverse_proxy 127.0.0.1:8787 }
    handle { respond 404 }
}
```

**Nginx equivalent:**

```nginx
server {
    listen 443 ssl;
    server_name claw.example.com;
    ssl_certificate     /etc/letsencrypt/live/claw/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/claw/privkey.pem;

    location / {
        auth_request /_verify;          # your SSO callback
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_read_timeout 600s;        # agent turns can be long
        proxy_buffering off;            # REQUIRED for SSE streaming
    }
}
```

`proxy_buffering off` (or Caddy's default flush behavior) matters: streamed
`/chat` responses are SSE and must not sit in a proxy buffer.

**For multi-user deployments, prefer per-user upstreams**: run one claw
process per user/workspace pair (different ports or containers) and have
the proxy route by authenticated user. That gives you:
- a hard workspace boundary per person (path-confine stays single-rooted),
- per-user `~/.claw` state,
- a per-user kill switch (`systemctl stop claw-alice`).

A single shared process for multiple untrusted users is *not* a supported
configuration — the guard stack confines paths, not identities.

## 4. Scaling

### 4.1 What actually consumes resources

| Resource | Driver | Relief valve |
| --- | --- | --- |
| LLM tokens (cost + latency) | conversation length, iteration count | compaction (already on), `maxIterations`, response/tool caches, cheap-model routing |
| Process memory | concurrent sessions' histories | sessions are small (JSON-scale); hundreds of concurrent sessions fit in GBs |
| Filesystem | the workspace | git worktrees for parallel sub-agents; disk cleanup |
| Upstream rate limits | parallel backends hammering one provider | router (failover/roundrobin + budgets) spreads across keys/endpoints |

The process itself is almost never the bottleneck — the model is. Scale
work first goes into *routing and budgets*, not into bigger boxes.

### 4.2 State: the one thing to know

State is exactly three folders under `~/.claw` (or `$HOME/.claw`):

| Path | Contents | Scaling behavior |
| --- | --- | --- |
| `sessions/` | JSONL conversation logs | written per turn; needed by `continue`/`/resume` and the web UI |
| `mcp-tokens.json` | OAuth tokens | per server identity |
| `history`, `config.json` | REPL niceties, user config | per user |

One process → zero concerns. **N processes → two rules:**

1. **Session affinity**: route a user's requests to the same instance
   (sticky sessions by cookie/IP at the proxy). Sessions live in instance
   memory (`serve.ts`'s `Map`) *and* on disk, so affinity makes both agree.
2. **Shared `~/.claw`**: NFS/EFS/Firestore-synced volume, or one persistent
   volume per instance with affinity. The JSONL format is append-only, so
   shared-disk contention is minimal.

The deliberate upgrade path (in dependency order):

1. **Affinity only** — sticky sessions, per-instance disks. Zero code
   changes; sufficient for dozens of instances.
2. **Session store backend** — replace `SessionStore` with a Redis/Postgres
   implementation of the same four methods (`create/append/load/bumpTurns`).
   The interface is tiny by design; GUIDE.md §13 explains why sessions are
   append-only lines (crash-safe, trivially portable to S3/Postgres).
3. **Session-per-request statelessness** — pass full history from the
   client every call (the `/chat` API is already 90% there: sessions are
   just `ChatMsg[]`). This is how you'd reach true horizontal scale.

### 4.3 Scaling the model side (before the server side)

- **Pin models per alias** in `models` config so provider prompt caches hit
  (measured in claw-orchestrator: pinned = ~66% cache hits, router
  free-stack = ~0%).
- **Budgets** (`budget: { maxCalls, maxUsd, ... }`) make cost policy
  enforceable per backend: cheap backends drain first; spend caps are
  automatic. This is your primary cost-containment tool in production.
- **`maxIterations`** (default 16) and the loop-detect guard are the
  runaway protection — keep them tight in multi-tenant settings.
- **Sub-agents**: `maxConcurrency` bounds parallel fan-out per turn; set
  `subagents.enabled: false` for untrusted tenants.

### 4.4 Load pattern

`/chat` requests are long (seconds to minutes), not chatty. Size for
**concurrent in-flight turns**, not requests/second:

- `ulimit -n` ≥ 1024 (each streaming turn holds a socket + possibly an
  upstream connection).
- systemd `MemoryMax` 1–2 GB is generous; if you approach it, you have a
  leak — sessions are kilobytes.
- The HTTP endpoint holds one connection per streaming response; proxies
  need `proxy_read_timeout` ≥ your longest turn (600s is sensible).

## 5. Observability

- **Health**: `GET /health` — wire it to your load balancer.
- **Per-turn cost**: every response carries `usage` (input/output/cached
  tokens + calls). Log it. Aggregate it. That's your billing and abuse
  signal — a sudden jump in `calls` per turn is the classic runaway signature.
- **Trace**: run with `-v` in staging to see Think→Act→Observe lines; in
  production, session JSONL files *are* the audit log (every message,
  including tool calls and their outputs, is persisted).
- **Structured logs**: wrap `src/cli.ts serve` with a log shipper; the
  serve banner and guard messages are the interesting events.
- **What to alert on**: `/health` down; turn error rate (`aborted: true`
  in responses); usage-per-session percentile spikes; `git_commit`/
  `shell` approval denials (in REPL mode) — a spike means the model is
  misbehaving.

## 6. Security hardening checklist

Application-level (already built in, verify the config):

- [ ] `riskyTools` minimal (`shell`, `git_commit` only if needed)
- [ ] `shellAllowlist` as small as the product allows
- [ ] `autoApprove` true *only* for headless deployments that accepted §2's trade
- [ ] `outputCap` set (default 4000) — oversized tool results are a context-window attack surface
- [ ] Workspace contains only what the agent should touch (no `.env` files of *other* systems, no SSH keys)
- [ ] MCP servers: `--trusted` only for servers you operate; untrusted servers keep the approval gate
- [ ] CLAW.md is reviewed like code — it's injected into every system prompt

OS-level (because `shell` exists):

- [ ] Dedicated low-privilege user; `NoNewPrivileges`, `ProtectSystem=strict` (or container equivalents)
- [ ] Egress allowlist if the workspace shouldn't reach the internet (the `web_fetch` tool is read-only HTTP but `shell` is not)
- [ ] Secrets reach the process via environment variables only (`CLAW_API_KEY` *names* an env var — keys never live in `.claw.json`)
- [ ] OAuth tokens (`~/.claw/mcp-tokens.json`) on an encrypted volume in multi-tenant setups

Network-level:

- [ ] TLS at the proxy; auth at the proxy; never expose 8787 directly
- [ ] `proxy_buffering off` for SSE
- [ ] Per-user upstreams for multi-tenant (§3)

## 7. Backup, upgrade, recovery

- **Back up**: `~/.claw/sessions/` (it's append-only JSONL — rsync-friendly)
  and the workspace itself (it's a git repo if you followed §8 of the
  guide — commit often).
- **Upgrade**: copy the new `claw` folder, restart. No migrations; sessions
  from older versions load fine (unknown lines are skipped by design).
- **Recovery**: the process is stateless — restart and it's back. A
  corrupted session file loses at most one line (`load()` skips bad lines).

## 8. A reference production setup (putting it together)

```
                    ┌─────────────────────────────┐
   users ──TLS──▶   │ Caddy (TLS + SSO + routing) │
                    └──────────┬──────────────────┘
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
      ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
      │ claw (alice) │  │ claw (bob)   │  │ claw (ci)    │   one systemd unit /
      │ ws: ~/alice  │  │ ws: ~/bob    │  │ ws: /srv/ci  │   container per identity
      └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
             └─────────────────┼─────────────────┘
                               ▼
                  LLM providers (routed, budgeted)
                  + MCP servers (stdio/http, OAuth)
```

- one process per identity, each with its own workspace and `~/.claw`
- the router fans out to providers with failover + per-backend budgets
- `/chat` for humans and the VS Code extension, `--json` for CI pipelines

That's the whole production story: **the agent is small; the model is the
scale unit; the guard stack plus OS confinement is the security model;
sessions are the only state and they're append-only files.**
