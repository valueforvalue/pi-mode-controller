/**
 * Mode Controller Extension
 *
 * Provides four operation modes:
 * - YOLO: Execute everything immediately (default)
 * - Planning: Read-only exploration with plan creation
 * - Autopilot: Continuous execution until stopped
 * - HITL: Human-in-the-loop with configurable checkpoints
 *
 * Features:
 * - Slash commands for mode switching
 * - Status bar indicator with mode icon + name
 * - CWD display below editor
 * - Mode persistence across sessions
 * - Token tracking and efficient mode
 * - HITL configurable allow/block rules
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Types
export type Mode = "yolo" | "planning" | "autopilot" | "hitl";

export interface ModeState {
  currentMode: Mode;
  hitlRules: HitlRules;
  hitlTurnCounter: number;
  autopilotRunning: boolean;
  tokenStats: TokenStats;
  efficientMode: boolean;
  efficientBudget: number | null;
  /** Per-mode tool exclusion lists. Extension tools + builtins are active by default; these are removed. */
  removeByMode: ModeRemoveState;
}

export interface HitlRules {
  blocklist: string[];
  allowlist: string[];
  filePatterns: {
    block: string[];
    allow: string[];
  };
}

export interface TokenStats {
  totalTokens: number;
  totalCost: number;
  contextUsage: number;
  turnsCount: number;
}

// Tool configurations per mode
// Built-in tools that ship with pi. Everything else is an extension tool
// (e.g. web_search, web_fetch, todo, advisor, Agent, ask_user_question).
// Each mode declares only the EXTRA tools it removes on top of the full set,
// so extension tools stay available across all modes by default. Use
// `/mode add|remove <tool>` to override per session.
const BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

const DEFAULT_MODE_REMOVE_TOOLS: Record<Mode, readonly string[]> = {
  yolo: [],
  // Planning is read-only-ish: no file modifications. Extension tools stay.
  planning: ["edit", "write"],
  autopilot: [],
  hitl: [],
};

type ModeRemoveState = Record<Mode, string[]>;

function defaultRemoveState(): ModeRemoveState {
  return {
    yolo: [...DEFAULT_MODE_REMOVE_TOOLS.yolo],
    planning: [...DEFAULT_MODE_REMOVE_TOOLS.planning],
    autopilot: [...DEFAULT_MODE_REMOVE_TOOLS.autopilot],
    hitl: [...DEFAULT_MODE_REMOVE_TOOLS.hitl],
  };
}

// Default blocklist
const DEFAULT_BLOCKLIST = [
  "rm -rf",
  "rm -r",
  "rmdir",
  "git reset --hard",
  "git reset --mixed",
  "git checkout --force",
  "git clean -fd",
  "dd",
  "mkfs",
  "format",
  "chmod -R 777",
  "shutdown",
  "reboot",
  "halt",
];

// Default sensitive file patterns
const DEFAULT_FILE_PATTERNS = {
  block: ["*.env", "*.pem", "*.key", "*credentials*", "*secret*", ".git/config"],
  allow: [],
};

// Mode display info
const MODE_INFO: Record<Mode, { icon: string; label: string; color: string }> = {
  yolo: { icon: "⚡", label: "YOLO", color: "warning" },
  planning: { icon: "📋", label: "Plan", color: "accent" },
  autopilot: { icon: "🚀", label: "Auto", color: "success" },
  hitl: { icon: "👁", label: "HITL", color: "error" },
};

// Mode order for cycling
const MODE_ORDER: Mode[] = ["yolo", "planning", "autopilot", "hitl"];

// Helper functions
function isToolCallEventType<T extends string>(toolName: T, event: unknown): event is { input: Record<string, unknown>; toolName: string } {
  return typeof event === "object" && event !== null && "toolName" in event && (event as { toolName: string }).toolName === toolName;
}

function getNextMode(current: Mode): Mode {
  const idx = MODE_ORDER.indexOf(current);
  return MODE_ORDER[(idx + 1) % MODE_ORDER.length];
}

function isDestructiveCommand(command: string, blocklist: string[]): boolean {
  const lowerCmd = command.toLowerCase();
  return blocklist.some((blocked) => lowerCmd.includes(blocked.toLowerCase()));
}

function matchesFilePattern(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1);
      return path.endsWith(ext);
    }
    return path.toLowerCase().includes(pattern.toLowerCase());
  });
}

export default function modeControllerExtension(pi: ExtensionAPI): void {
  // State
  let state: ModeState = {
    currentMode: "yolo",
    hitlRules: {
      blocklist: [...DEFAULT_BLOCKLIST],
      allowlist: [],
      filePatterns: { ...DEFAULT_FILE_PATTERNS },
    },
    hitlTurnCounter: 0,
    autopilotRunning: false,
    tokenStats: {
      totalTokens: 0,
      totalCost: 0,
      contextUsage: 0,
      turnsCount: 0,
    },
    efficientMode: false,
    efficientBudget: null,
    removeByMode: defaultRemoveState(),
  };

  // ========================================
  // UI Updates
  // ========================================

  function updateStatusBar(ctx: ExtensionContext): void {
    const info = MODE_INFO[state.currentMode];
    const colorFn = ctx.ui.theme.fg(info.color, `${info.icon} ${info.label}`);
    ctx.ui.setStatus("mode-controller", colorFn);
  }

  function updateModeIndicator(ctx: ExtensionContext): void {
    updateStatusBar(ctx);

    // Show CWD and current mode - positioned below editor
    const info = MODE_INFO[state.currentMode];
    const cwd = ctx.cwd;
    const cwdDisplay = ctx.ui.theme.fg("muted", cwd);
    const modeBox = ` ${info.icon} ${info.label} `;
    const modeDisplay = ctx.ui.theme.fg(info.color, modeBox);
    ctx.ui.setWidget("mode-controller", [cwdDisplay, modeDisplay], { placement: "belowEditor" });
  }

  // ========================================
  // Tool Configuration
  // ========================================

  function setModeTools(mode: Mode, ctx?: ExtensionContext): void {
    const all = pi.getAllTools();
    const allNames = all.map((t) => t.name);
    const remove = new Set(state.removeByMode[mode] ?? []);
    const active = allNames.filter((n) => !remove.has(n));
    const removed = allNames.filter((n) => remove.has(n));
    pi.setActiveTools(active);

    if (ctx?.hasUI && removed.length > 0) {
      const list = removed.length <= 6 ? removed.join(", ") : `${removed.slice(0, 6).join(", ")} +${removed.length - 6} more`;
      ctx.ui.notify(
        `${MODE_INFO[mode].label}: ${removed.length} tool(s) hidden — ${list}. Use /mode show to list, /mode add <tool> to restore.`,
        "info",
      );
    }
  }

  // ========================================
  // Mode Switching
  // ========================================

  function switchMode(ctx: ExtensionContext, newMode: Mode, keepAutopilotRunning = false): void {
    state.currentMode = newMode;
    state.hitlTurnCounter = 0;
    // Only reset autopilotRunning if not explicitly keeping it
    if (!keepAutopilotRunning) {
      state.autopilotRunning = false;
    }

    setModeTools(newMode, ctx);
    updateModeIndicator(ctx);

    const info = MODE_INFO[newMode];
    ctx.ui.notify(`Switched to ${info.label} mode`, "info");

    persistState();
  }

  function cycleMode(ctx: ExtensionContext): void {
    const newMode = getNextMode(state.currentMode);
    switchMode(ctx, newMode);
  }

  // ========================================
  // Persistence
  // ========================================

  function persistState(): void {
    pi.appendEntry("mode-controller", {
      currentMode: state.currentMode,
      hitlRules: state.hitlRules,
      hitlTurnCounter: state.hitlTurnCounter,
      efficientMode: state.efficientMode,
      efficientBudget: state.efficientBudget,
      removeByMode: state.removeByMode,
    });
  }

  function loadState(ctx: ExtensionContext): void {
    const entries = ctx.sessionManager.getEntries();
    const stateEntry = entries
      .filter((e: unknown) => (e as { type: string }).type === "custom" && (e as { customType: string }).customType === "mode-controller")
      .pop() as { data?: Partial<ModeState> } | undefined;

    if (stateEntry?.data) {
      if (stateEntry.data.currentMode) state.currentMode = stateEntry.data.currentMode;
      if (stateEntry.data.hitlRules) state.hitlRules = stateEntry.data.hitlRules;
      if (stateEntry.data.hitlTurnCounter !== undefined) state.hitlTurnCounter = stateEntry.data.hitlTurnCounter;
      if (stateEntry.data.efficientMode !== undefined) state.efficientMode = stateEntry.data.efficientMode;
      if (stateEntry.data.efficientBudget !== undefined) state.efficientBudget = stateEntry.data.efficientBudget;
      if (stateEntry.data.removeByMode) {
        // Merge per-mode lists — default for any mode missing from saved state.
        const saved = stateEntry.data.removeByMode as Partial<ModeRemoveState>;
        const def = defaultRemoveState();
        state.removeByMode = {
          yolo: Array.isArray(saved.yolo) ? saved.yolo : def.yolo,
          planning: Array.isArray(saved.planning) ? saved.planning : def.planning,
          autopilot: Array.isArray(saved.autopilot) ? saved.autopilot : def.autopilot,
          hitl: Array.isArray(saved.hitl) ? saved.hitl : def.hitl,
        };
      }
    }

    setModeTools(state.currentMode, ctx);
    updateModeIndicator(ctx);
  }

  // ========================================
  // Commands
  // ========================================

  // Mode switching command
  pi.registerCommand("mode", {
    description: "Switch between operation modes (yolo, planning, autopilot, hitl). Subcommands: show, add <tool>, remove <tool>, reset",
    getArgumentCompletions: (prefix) => {
      const base = MODE_ORDER.map((m) => ({ value: m, label: MODE_INFO[m].label }));
      const subs = ["show", "add", "remove", "reset"];
      const all = [...base, ...subs.map((s) => ({ value: s, label: s }))];
      return all.filter((c) => c.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      if (!args || typeof args !== "string") {
        cycleMode(ctx);
        return;
      }

      const trimmed = args.trim();
      const parts = trimmed.split(/\s+/);
      const head = parts[0].toLowerCase();
      const tail = parts.slice(1).join(" ");

      if (head === "show") {
        const mode = state.currentMode;
        const removed = state.removeByMode[mode] ?? [];
        const active = pi.getActiveTools();
        const all = pi.getAllTools().map((t) => t.name);
        const inactiveBuiltins = all.filter((n) => BUILTIN_TOOLS.has(n) && !active.includes(n));
        const inactiveExtensions = active.length === 0 ? all : all.filter((n) => !active.includes(n) && !BUILTIN_TOOLS.has(n));
        const msg =
          `Mode: ${MODE_INFO[mode].label}\n` +
          `Active: ${active.length} tool(s)\n` +
          `Hidden: ${removed.length} (${removed.length === 0 ? "none" : removed.join(", ")})\n` +
          (inactiveBuiltins.length > 0 ? `Inactive builtins: ${inactiveBuiltins.join(", ")}\n` : "") +
          (inactiveExtensions.length > 0 ? `Inactive extensions: ${inactiveExtensions.join(", ")}\n` : "") +
          `Use /mode add <tool> / /mode remove <tool> / /mode reset`;
        ctx.ui.notify(msg, "info");
        return;
      }

      if (head === "add" || head === "remove") {
        if (!tail) {
          ctx.ui.notify(`Usage: /mode ${head} <tool-name>`, "warning");
          return;
        }
        const list = state.removeByMode[state.currentMode] ?? [];
        if (head === "add") {
          const next = list.filter((n) => n !== tail);
          if (next.length === list.length) {
            ctx.ui.notify(`Already active: ${tail}`, "info");
            return;
          }
          state.removeByMode[state.currentMode] = next;
          ctx.ui.notify(`Restored ${tail} in ${MODE_INFO[state.currentMode].label}`, "info");
        } else {
          if (list.includes(tail)) {
            ctx.ui.notify(`Already hidden: ${tail}`, "info");
            return;
          }
          state.removeByMode[state.currentMode] = [...list, tail];
          ctx.ui.notify(`Hidden ${tail} in ${MODE_INFO[state.currentMode].label}`, "info");
        }
        setModeTools(state.currentMode, ctx);
        persistState();
        return;
      }

      if (head === "reset") {
        state.removeByMode = defaultRemoveState();
        setModeTools(state.currentMode, ctx);
        persistState();
        ctx.ui.notify(`Reset hidden-tool lists to defaults`, "info");
        return;
      }

      const targetMode = MODE_ORDER.find((m) => m === head);
      if (targetMode) {
        switchMode(ctx, targetMode);
      } else {
        ctx.ui.notify(`Unknown subcommand or mode: ${head}. Use: ${MODE_ORDER.join(", ")}, show, add, remove, reset`, "error");
      }
    },
  });

  // Quick switch commands
  MODE_ORDER.forEach((mode) => {
    pi.registerCommand(mode, {
      description: `Switch to ${MODE_INFO[mode].label} mode`,
      handler: async (_args, ctx) => switchMode(ctx, mode),
    });
  });

  // HITL rule management
  pi.registerCommand("hitl", {
    description: "Manage HITL rules (block, allow, rules, reset)",
    getArgumentCompletions: (prefix) => {
      const subs = ["block", "allow", "unblock", "unallow", "rules", "reset"];
      return subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
    },
    handler: async (args, ctx) => {
      if (!args || typeof args !== "string") {
        const blocked = state.hitlRules.blocklist.length;
        const allowed = state.hitlRules.allowlist.length;
        ctx.ui.notify(`HITL Rules: ${blocked} blocked, ${allowed} allowed`, "info");
        return;
      }

      const parts = args.split(" ");
      const action = parts[0] || "";
      const pattern = parts.slice(1).join(" ");

      switch (action) {
        case "block":
          if (pattern && typeof pattern === "string") {
            state.hitlRules.blocklist.push(pattern);
            ctx.ui.notify(`Blocked: ${pattern}`, "info");
            persistState();
          } else {
            ctx.ui.notify("Usage: /hitl block <pattern>", "warning");
          }
          break;

        case "allow":
          if (pattern && typeof pattern === "string") {
            state.hitlRules.allowlist.push(pattern);
            ctx.ui.notify(`Allowed: ${pattern}`, "info");
            persistState();
          } else {
            ctx.ui.notify("Usage: /hitl allow <pattern>", "warning");
          }
          break;

        case "unblock":
          if (pattern) {
            state.hitlRules.blocklist = state.hitlRules.blocklist.filter((p) => p !== pattern);
            ctx.ui.notify(`Unblocked: ${pattern}`, "info");
            persistState();
          }
          break;

        case "unallow":
          if (pattern) {
            state.hitlRules.allowlist = state.hitlRules.allowlist.filter((p) => p !== pattern);
            ctx.ui.notify(`Unallowed: ${pattern}`, "info");
            persistState();
          }
          break;

        case "rules":
          const blockList = state.hitlRules.blocklist.join("\n");
          const allowList = state.hitlRules.allowlist.join("\n");
          ctx.ui.notify(
            `HITL Rules:\n\nBlocked (${state.hitlRules.blocklist.length}):\n${blockList || "(none)"}\n\nAllowed (${state.hitlRules.allowlist.length}):\n${allowList || "(none)"}`,
            "info",
          );
          break;

        case "reset":
          state.hitlRules = {
            blocklist: [...DEFAULT_BLOCKLIST],
            allowlist: [],
            filePatterns: { ...DEFAULT_FILE_PATTERNS },
          };
          ctx.ui.notify("HITL rules reset to defaults", "info");
          persistState();
          break;

        default:
          ctx.ui.notify(`Unknown action: ${action}. Use: block, allow, unblock, unallow, rules, reset`, "error");
      }
    },
  });

  // Token stats
  pi.registerCommand("tokens", {
    description: "Show token usage statistics",
    handler: async (_args, ctx) => {
      const stats = state.tokenStats;
      const mode = state.efficientMode ? "EFFICIENT" : "NORMAL";
      ctx.ui.notify(
        `Token Stats (${mode}):\n\nTotal: ${stats.totalTokens.toLocaleString()}\nCost: $${stats.totalCost.toFixed(4)}\nContext: ${stats.contextUsage}%\nTurns: ${stats.turnsCount}`,
        "info",
      );
    },
  });

  // Efficient mode toggle
  pi.registerCommand("efficient", {
    description: "Toggle efficient mode (reduces token usage)",
    handler: async (_args, ctx) => {
      state.efficientMode = !state.efficientMode;
      ctx.ui.notify(state.efficientMode ? "Efficient mode ON" : "Efficient mode OFF", "info");
      persistState();
    },
  });

  // Pause command (for HITL)
  pi.registerCommand("pause", {
    description: "Pause for human input (HITL mode)",
    handler: async (_args, ctx) => {
      if (state.currentMode !== "hitl") {
        ctx.ui.notify("Pause only works in HITL mode", "warning");
        return;
      }
      state.hitlTurnCounter = 0;
      ctx.ui.notify("Paused for human input", "info");
    },
  });

  // ========================================
  // Event Handlers
  // ========================================

  // Session start - load state
  pi.on("session_start", async (_event, ctx) => {
    loadState(ctx);
  });

  // Tool call interception for HITL
  pi.on("tool_call", async (event, ctx) => {
    if (state.currentMode !== "hitl") return;

    // Check file writes
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const path = (event.input.path as string) || "";

      if (matchesFilePattern(path, state.hitlRules.filePatterns.block)) {
        return {
          block: true,
          reason: `HITL: Blocked writing to sensitive file pattern: ${path}`,
        };
      }
    }

    // Check bash for destructive commands
    if (isToolCallEventType("bash", event)) {
      const command = (event.input.command as string) || "";

      if (state.hitlRules.allowlist.some((p) => command.toLowerCase().includes(p.toLowerCase()))) {
        return;
      }

      if (isDestructiveCommand(command, state.hitlRules.blocklist)) {
        const choice = await ctx.ui.select("HITL: Blocked Command", [
          "Allow Once",
          "Block Once",
          "Always Allow",
        ]);

        if (choice === "Always Allow") {
          state.hitlRules.allowlist.push(command.split(" ")[0] || command);
          persistState();
        }

        if (choice === "Block Once" || choice === "Always Allow") {
          return {
            block: true,
            reason: `HITL: Blocked destructive command: ${command}`,
          };
        }
      }
    }
  });

  // Before agent start - inject mode context
  pi.on("before_agent_start", async () => {
    const messages: Array<{ customType: string; content: string; display: boolean }> = [];

    switch (state.currentMode) {
      case "planning":
        messages.push({
          customType: "mode-context",
          content: `[PLANNING MODE ACTIVE]
You are in a read-only exploration mode. Edit and write tools are disabled.

Tools available: read, bash (read-only commands), grep, find, ls, questionnaire
Tools blocked: edit, write (file modifications)

To start a structured plan, run /ask-matt. It routes to the right skill:
- /grill-with-docs - interview (you have a codebase)
- /grill-me - interview (no codebase)
- /prototype - test an idea in throwaway code
- /to-prd, /to-issues - publish to the issue tracker
- /implement is blocked in this mode - switch to /yolo or /hitl to execute

Or describe the problem here and explore the codebase with read/grep/find/ls before committing to a plan. If you produce a plan, write it under a "Plan:" header. Do NOT attempt to make changes.`,
          display: false,
        });
        break;

      case "autopilot":
        if (state.autopilotRunning) {
          messages.push({
            customType: "mode-context",
            content: `[AUTOPILOT MODE - Continuous execution enabled]
Execute the plan continuously. When done, report summary.
Type "stop" to halt.`,
            display: false,
          });
        }
        break;

      case "hitl":
        state.hitlTurnCounter++;
        if (state.hitlTurnCounter >= 2) {
          messages.push({
            customType: "mode-context",
            content: `[HITL CHECKPOINT]
This is a human-in-the-loop checkpoint. Before continuing:
1. Summarize what you just did
2. State what you're about to do next
3. Wait for human approval ("continue" or redirect)

Current progress: Turn ${state.tokenStats.turnsCount}`,
            display: false,
          });
          state.hitlTurnCounter = 0;
        }
        break;
    }

    if (state.efficientMode) {
      messages.push({
        customType: "efficient-context",
        content: `[EFFICIENT MODE - Minimize token usage]
- Keep responses concise
- Avoid redundant explanations
- Use aggressive compaction
- Prefer direct tool calls over commentary`,
        display: false,
      });
    }

    if (messages.length > 0) {
      return {
        message: messages[0],
      };
    }
  });

  // Turn end - update stats
  pi.on("turn_end", async (event, ctx) => {
    if (event.message && "usage" in event.message) {
      const usage = event.message.usage as { inputTokens?: number; outputTokens?: number; cost?: { total?: number } };
      state.tokenStats.totalTokens += (usage.inputTokens || 0) + (usage.outputTokens || 0);
      state.tokenStats.totalCost += usage.cost?.total || 0;
      state.tokenStats.turnsCount++;
    }

    const context = ctx.getContextUsage();
    if (context) {
      state.tokenStats.contextUsage = Math.round((context.tokens / context.limit) * 100);

      if (state.tokenStats.contextUsage >= 80 && !state.efficientMode) {
        ctx.ui.notify("Context at 80% - Efficient mode auto-enabled", "warning");
        state.efficientMode = true;
        persistState();
      }
    }

    if (state.autopilotRunning && state.currentMode === "autopilot") {
      const entries = ctx.sessionManager.getEntries();
      const lastUser = entries.filter((e: unknown) => (e as { type: string }).type === "message").slice(-1)[0] as { message?: { content?: string } } | undefined;
      if (lastUser?.message?.content === "stop" || lastUser?.message?.content === "Stop") {
        state.autopilotRunning = false;
        ctx.ui.notify("Autopilot stopped by user", "info");
      }
    }

    persistState();
  });

  // Agent end - handle mode transitions
  pi.on("agent_end", async (event, ctx) => {
    if (state.currentMode === "planning") {
      const choice = await ctx.ui.select("Planning complete - what next?", [
        "Execute the plan (Autopilot)",
        "Stay in planning mode",
        "Refine the plan",
      ]);

      if (choice?.startsWith("Execute")) {
        // Switch to autopilot mode, keeping autopilotRunning true
        switchMode(ctx, "autopilot", true);
        // Queue the execution message for the next turn (defer to avoid timing issues)
        setTimeout(() => {
          pi.sendUserMessage("Execute the plan you just created.", { deliverAs: "steer" });
        }, 100);
      } else if (choice === "Refine the plan") {
        const refinement = await ctx.ui.editor("Refine the plan:", "");
        if (refinement?.trim()) {
          pi.sendUserMessage(refinement.trim(), { deliverAs: "steer" });
        }
      }
    }
  });

  // ========================================
  // Initialize
  // ========================================

  pi.registerFlag("mode", {
    description: "Start in specific mode (yolo, planning, autopilot, hitl)",
    type: "string",
    default: "yolo",
  });

  pi.registerFlag("efficient", {
    description: "Start in efficient mode",
    type: "boolean",
    default: false,
  });
}
