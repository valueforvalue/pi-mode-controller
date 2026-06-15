# Mode Controller Extension

Provides four operation modes for pi coding agent with token awareness and efficiency features.

## Modes

### YOLO Mode (⚡)
Default mode. Executes all commands immediately without confirmation.
- Tools: read, bash, edit, write, grep, find, ls
- No restrictions

### Planning Mode (📋)
Read-only exploration mode for planning before execution.
- Tools: read, bash (safe commands only), grep, find, ls, questionnaire
- Creates numbered plans from "Plan:" sections
- Integrates `/grill-me` and `/grill-me-with-docs` skills

### Autopilot Mode (🚀)
Continuous execution until stopped.
- Tools: All tools enabled
- Runs continuously without waiting for user input
- Press `Escape` to stop and get summary

### HITL Mode (👁)
Human-in-the-loop with configurable checkpoints.
- Tools: All tools enabled
- Pauses every 2-3 turns for human approval
- Blocks destructive commands and sensitive file writes
- User can type "pause" for immediate checkpoint

## Commands

| Command | Description |
|---------|-------------|
| `/mode` | Cycle to next mode |
| `/mode <name>` | Switch to specific mode |
| `/yolo`, `/planning`, `/autopilot`, `/hitl` | Quick switch to mode |
| `/hitl block <pattern>` | Add command to blocklist |
| `/hitl allow <pattern>` | Add command to allowlist |
| `/hitl unblock <pattern>` | Remove from blocklist |
| `/hitl unallow <pattern>` | Remove from allowlist |
| `/hitl rules` | Show current rules |
| `/hitl reset` | Reset to default rules |
| `/tokens` | Show token usage statistics |
| `/efficient` | Toggle efficient mode |
| `/pause` | Trigger immediate HITL checkpoint |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Type `stop` | Stop autopilot |
| `Escape` | Stop autopilot execution |

## Efficient Mode

When enabled:
- Shorter system prompts
- Aggressive compaction hints
- Restricted verbose tools
- Auto-enables at 80% context usage

## Token Tracking

Tracks per session:
- Total tokens used
- Estimated cost
- Context usage percentage
- Turn count

## Default Blocklist

Commands blocked by default:
- `rm -rf`, `rm -r`, `rmdir`
- `git reset --hard`, `git reset --mixed`
- `git checkout --force`, `git clean -fd`
- `dd`, `mkfs`, `format`
- `chmod -R 777`
- `shutdown`, `reboot`, `halt`

## File Patterns

Sensitive file patterns blocked by default:
- `*.env`, `*.pem`, `*.key`
- `*credentials*`, `*secret*`
- `.git/config`

## Installation

Copy the `mode-controller` folder to:
- Global: `~/.pi/agent/extensions/`
- Project: `.pi/extensions/`

Or reference in `settings.json`:
```json
{
  "extensions": [".pi/extensions/mode-controller"]
}
```
