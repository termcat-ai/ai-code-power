# AI Code Power

A **unified Claude + Codex inspection panel** plugin for TermCat.

> 中文版见 [README_cn.md](./README_cn.md)。

When the active terminal is running `claude` or `codex`, a right-side panel is auto-injected showing:

- **Unified session history** — each prompt/task in reverse-chronological order, with user input and model reply
- **Call detail expansion** — every API round-trip's tool calls under each prompt (builtin / Skill / MCP / Sub-agent / Shell / Patch / Search)
- **Token stats** — layered display of freshInput / cacheRead / output / reasoning (o3/o4) tokens
- **Mode switching** — Claude's PermissionMode (`default` / `acceptEdits` / `plan` / `bypassPermissions`); Codex's approvalMode (`suggest` / `auto-edit` / `full-auto`)
- **Proxy capture (optional)** — view the full system prompt and raw SSE request/response once the local proxy is enabled
- **Dual-CLI awareness** — if `claude` and `codex` both run in one tab, the most recently started wins; the panel follows the active terminal across tabs

## Dual-CLI adaptation (Adapter pattern)

The plugin hides the differences between the two CLIs behind an `IAdapter` interface, so upper layers are agnostic to the concrete type:

| Aspect | ClaudeAdapter | CodexAdapter |
|--------|---------------|--------------|
| Data source | `~/.claude/projects/<hash>/<uuid>.jsonl` | `~/.codex/sessions/<y>/<m>/<d>/<id>.jsonl` |
| JSONL structure | `parentUuid` DAG, main branch extracted | linear `task_started` → `assistant` → `token_count` |
| Token source | inline `message.usage` | standalone `token_count` event |
| Mode source | JSONL `permissionMode` field | `approvalMode` in `~/.codex/config.json` |
| SSE format | Anthropic `/v1/messages` | OpenAI `/v1/chat/completions` |

Detection runs via `Detector`, which polls the process tree every 5s and distinguishes `claude` from `codex` by process name / cmdline regex.

## Proxy capture

When enabled, the plugin starts a local HTTP proxy and points `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` at `http://127.0.0.1:<port>`:

- Requests hitting `captureEndpointPath` are stored in `CaptureStore` (LRU, 200 entries); everything else passes through
- SSE responses are buffered for recording while being piped to the client with zero added latency
- One `ProxyServer` supports both Anthropic and OpenAI SSE formats via a pluggable `SseStrategy`
- API keys are masked; the cache is released when the session ends

**How it takes effect:**
- Claude — written to `active.env`, applied on the next `launch` after `source`
- Codex — written to `~/.codex/proxy.env`, requires a manual `source` or a codex restart

## Design principles

- **Adapter-pattern decoupling** — `ClaudeAdapter` / `CodexAdapter` each implement `IAdapter`; the UI and entry layers never see the CLI type
- **Strategy pattern for SSE** — `SseStrategy` hides the Anthropic vs. OpenAI SSE format differences
- **Read-only local files** — data comes from JSONL files, CLI config files, and SQLite (Codex); no hooks are installed
- **"Fill, don't submit" by default** — PTY injection stops at the input line; only `launch` auto-submits
- **Panel follows the active tab** — multiple tabs running different CLIs don't interfere with each other

## Development

```bash
npm install
npm run build          # esbuild → dist/extension.js
npm run pack           # produces the installable ai-code-power.tgz
```

esbuild notes: `platform: node` / `format: cjs`; `electron` and `better-sqlite3` are external native modules; `chokidar`, `pidtree`, and `uuid` are bundled.

## Installing into TermCat

Drop the built tgz into `plugins/ai-code-power/` under TermCat's user data directory (or copy the whole `dist/` directory).

## Storage locations

```
~/.termcat/plugins/ai_code_power/
├── presets.json      # Claude preset CRUD
└── active.env        # Claude env (atomic tmp→rename write, with cleanup prologue)

~/.codex/
├── config.json       # Codex model / approvalMode
├── .env              # OPENAI_API_KEY
└── proxy.env         # export OPENAI_BASE_URL=...
```

## Related docs

- Architecture: `claude_refs/ARCHITECTURE.md`
- Technical design: `docs/tech-design/20260621-AiCodePower.md`
- Base plugin reference: `termcat_client_plugin/claude_code_power/`
- Host architecture: `termcat_client/claude_refs/ARCHITECTURE.md`
