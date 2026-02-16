# Wilson

Deployment orchestration for the Wilson system. Manages updates and monitoring
for Engram, Synapse, Cortex, and itself on the Mac Mini.

## Install

```bash
curl -fsSL https://github.com/shetty4l/wilson/releases/latest/download/install.sh | bash
```

## Usage

```
wilson status              Show all services (running/stopped, PID, port, version)
wilson health              Check health endpoints for all services
wilson logs <source> [n]   Show last n log lines (default: 20)
wilson restart <service>   Restart a service via its CLI
wilson update [service]    Run update check (all or specific service)
wilson version             Show Wilson + all service versions
```

### Log sources

- `engram` — Engram daemon log
- `synapse` — Synapse daemon log
- `cortex` — Cortex daemon log
- `updater` — Wilson update orchestrator log

### Options

- `--json` — Machine-readable JSON output on any command

## Architecture

Wilson owns deployment for all services. Each service owns its own code,
CI, and install script. Wilson provides:

- A LaunchAgent that checks for updates every 4 minutes
- A CLI for monitoring and managing all services from one place
- Update orchestration: version check → delegate to service installer → restart

### Update flow

```
wilson-update.sh (runs every 4min via LaunchAgent)
├── 1. Check Engram for updates → if newer: run engram install.sh, restart
├── 2. Check Synapse for updates → if newer: run synapse install.sh, restart
├── 3. Check Cortex for updates → if newer: run cortex install.sh, restart
└── 4. Check Wilson for updates → if newer: run wilson install.sh (self-update)
```

Each check is independent — failure in one does not block the others.

## Services

| Service | Repo | Port | Purpose |
|---------|------|------|---------|
| Engram  | shetty4l/engram  | 7749 | Persistent memory |
| Synapse | shetty4l/synapse | 7750 | LLM routing proxy |
| Cortex  | shetty4l/cortex  | 7751 | Life assistant |

## Paths

| Path | Purpose |
|------|---------|
| `~/srv/wilson/` | Wilson install (versioned dirs + `latest` symlink) |
| `~/srv/engram/` | Engram install |
| `~/srv/synapse/` | Synapse install |
| `~/srv/cortex/` | Cortex install |
| `~/.local/bin/wilson` | Wilson CLI |
| `~/.local/bin/engram` | Engram CLI |
| `~/.local/bin/synapse` | Synapse CLI |
| `~/.local/bin/cortex` | Cortex CLI |
| `~/Library/LaunchAgents/com.suyash.wilson-updater.plist` | Update LaunchAgent |
| `~/Library/Logs/wilson-updater.log` | Update orchestrator log |

## Development

```bash
bun install
bun run validate     # typecheck + lint + format:check + test
bun run format       # auto-fix formatting
```

### Version bumps

Patch versions are automatic on every merge to main. For minor/major:

```bash
bun run version:bump minor   # 0.1.x → 0.2.0
bun run version:bump major   # 0.x.y → 1.0.0
```
