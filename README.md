# Mode Controller Extension

Four operation modes for pi coding agent with token awareness and efficiency features.

## Installation

```bash
pi install git:github.com:valueforvalue/pi-mode-controller
```

Or try without installing:
```bash
pi -e git:github.com:valueforvalue/pi-mode-controller
```

## Modes

All modes share the full set of installed tools (built-in + every extension tool such as `web_search`, `web_fetch`, `todo`, `advisor`, `ask_user_question`, `Agent`, etc.). Each mode only declares which tools it *removes* on top of that baseline.

### YOLO Mode (⚡)
Default mode. Executes all commands immediately without confirmation.
- Removes: none
- Full toolset available

### Planning Mode (📋)
Read-only exploration mode for planning before execution.
- Removes: `edit`, `write`
- All other tools remain available (including `web_search`/`web_fetch` for research)
- Points at `/ask-matt` to route to the right slash skill for the situation (interview, prototype, PRD, etc.)

### Autopilot Mode (🚀)
Continuous execution until stopped.
- Removes: none
- Runs continuously without waiting for user input
- Type `stop` to halt and get summary

### HITL Mode (👁)
Human-in-the-loop with configurable checkpoints.
- Removes: none
- Pauses every 2-3 turns for human approval
- Blocks destructive commands and sensitive file writes
- User can type `/pause` for immediate checkpoint

## Commands

| Command | Description |
|---------|-------------|
| `/mode` | Cycle to next mode |
| `/mode <name>` | Switch to specific mode |
| `/mode show` | List active + hidden tools in current mode |
| `/mode add <tool>` | Restore a hidden tool to the current mode |
| `/mode remove <tool>` | Hide a tool in the current mode |
| `/mode reset` | Restore default hidden-tool lists for every mode |
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

## Token Tracking

Tracks per session:
- Total tokens used
- Estimated cost
- Context usage percentage
- Turn count

Auto-enables efficient mode at 80% context usage.

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
