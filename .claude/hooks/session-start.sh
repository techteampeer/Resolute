#!/bin/bash
# SessionStart hook for Claude Code on the web (remote sessions only).
#
# 1. npm install               -> `npm run build` / `npm test` work
# 2. Supabase CLI + dockerd +  -> the project-scoped MCP server in .mcp.json
#    `supabase start`             (http://localhost:54321/mcp) is reachable
#
# Step 2 needs the environment's network policy to allow GitHub release
# downloads and Docker registries/CDNs; on the default restricted policy it
# logs a warning and the session starts without the local Supabase stack.
set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
log() { echo "[session-start] $*" >&2; }

# --- 1. Node dependencies (registry.npmjs.org is reachable on all policies) --
if [ ! -d node_modules ]; then
  npm install --no-audit --no-fund || log "WARN: npm install failed"
fi

# --- 2. Supabase local stack -------------------------------------------------
if ! command -v supabase >/dev/null 2>&1; then
  case "$(uname -m)" in
    x86_64) sb_arch=amd64 ;;
    aarch64 | arm64) sb_arch=arm64 ;;
    *) sb_arch="" ;;
  esac
  if [ -n "$sb_arch" ] && curl -fsSL --retry 3 -o /tmp/supabase-cli.tar.gz \
      "https://github.com/supabase/cli/releases/latest/download/supabase_linux_${sb_arch}.tar.gz"; then
    tar -xzf /tmp/supabase-cli.tar.gz -C /tmp supabase &&
      install -m 0755 /tmp/supabase /usr/local/bin/supabase &&
      log "installed Supabase CLI $(supabase --version)"
  else
    log "WARN: Supabase CLI download blocked — enable broader network access" \
      "for this environment (github.com releases + Docker registries)."
  fi
fi

if command -v supabase >/dev/null 2>&1; then
  if ! docker info >/dev/null 2>&1 && command -v dockerd >/dev/null 2>&1; then
    dockerd >/tmp/session-start-dockerd.log 2>&1 &
    for _ in $(seq 1 30); do
      docker info >/dev/null 2>&1 && break
      sleep 1
    done
  fi
  if docker info >/dev/null 2>&1; then
    [ -f supabase/config.toml ] || supabase init </dev/null || true
    if supabase status >/dev/null 2>&1; then
      log "Supabase stack already running"
    elif supabase start </dev/null; then
      log "Supabase stack started — MCP at http://localhost:54321/mcp"
    else
      log "WARN: supabase start failed (Docker image pulls are blocked on" \
        "the default network policy); continuing without local Supabase."
    fi
  else
    log "WARN: Docker daemon unavailable; skipping supabase start."
  fi
fi

exit 0
