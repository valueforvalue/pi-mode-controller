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
 * - Shift+Tab cycles modes
 * - Status bar indicator with mode icon + name
 * - Mode persistence across sessions
 * - Token tracking and efficient mode
 * - HITL configurable allow/block rules
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";

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
const YOLO_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const PLANNING_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const AUTOPILOT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const HITL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

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

function getPreviousMode(current: Mode): Mode {
  const idx = MODE_ORDER.indexOf(current);
  return MODE_ORDER[(idx - 1 + MODE_ORDER.length) % MODE_ORDER.length];
}

function isDestructiveCommand(command: string, blocklist: string[]): boolean {
  const lowerCmd = command.toLowerCase();
  return blocklist.some((blocked) => lowerCmd.includes(blocked.toLowerCase()));
}

function matchesFilePattern(path: string, patterns: string[]): boolean {
  // Simple glob matching
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

    // Update widget showing all modes (quick-switch)
    const lines = MODE_ORDER.map((mode) => {
      const info = MODE_INFO[mode];
      const isActive = mode === state.currentMode;
      if (isActive) {
        return ctx.ui.theme.fg(info.color, `▶ ${info.icon} ${info.label}`);
      }
      return ctx.ui.theme.fg("muted", `  ${info.icon} ${info.label}`);
    });
    ctx.ui.setWidget("mode-controller-modes", lines);
  }

  // ========================================
  // Tool Configuration
  // ========================================

  function setModeTools(mode: Mode): void {
    switch (mode) {
      case "yolo":
        pi.setActiveTools(YOLO_TOOLS);
        break;
      case "planning":
        pi.setActiveTools(PLANNING_TOOLS);
        break;
      case "autopilot":
        pi.setActiveTools(AUTOPILOT_TOOLS);
        break;
      case "hitl":
        pi.setActiveTools(HITL_TOOLS);
        break;
    }
  }

  // ========================================
  // Mode Switching
  // ========================================

  function switchMode(ctx: ExtensionContext, newMode: Mode): void {
    const oldMode = state.currentMode;
    state.currentMode = newMode;
    state.hitlTurnCounter = 0;
    state.autopilotRunning = false;

    setModeTools(newMode);
    updateModeIndicator(ctx);

    // Notify user
    const info = MODE_INFO[newMode];
    ctx.ui.notify(`Switched to ${info.label} mode`, "info");

    // Persist state
    persistState();
  }

  function cycleMode(ctx: ExtensionContext, forward: boolean = true): void {
    const newMode = forward ? getNextMode(state.currentMode) : getPreviousMode(state.currentMode);
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
    }

    setModeTools(state.currentMode);
    updateModeIndicator(ctx);
  }

  // ========================================
  // Commands
  // ========================================

  // Mode switching command
  pi.registerCommand("mode", {
    description: "Switch between operation modes (yolo, planning, autopilot, hitl)",
    getArgumentCompletions: () => MODE_ORDER.map((m) => ({ value: m, label: MODE_INFO[m].label })),
    handler: async (args, ctx) => {
      if (!args) {
        // Cycle to next mode
        cycleMode(ctx, true);
        return;
      }

      const targetMode = MODE_ORDER.find((m) => m === args.toLowerCase());
      if (targetMode) {
        switchMode(ctx, targetMode);
      } else {
        ctx.ui.notify(`Unknown mode: ${args}. Use: ${MODE_ORDER.join(", ")}`, "error");
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
      if (!args) {
        // Show current HITL status
        const blocked = state.hitlRules.blocklist.length;
        const allowed = state.hitlRules.allowlist.length;
        ctx.ui.notify(`HITL Rules: ${blocked} blocked, ${allowed} allowed`, "info");
        return;
      }

      const [action, ...rest] = args.split(" ");
      const pattern = rest.join(" ");

      switch (action) {
        case "block":
          if (pattern) {
            state.hitlRules.blocklist.push(pattern);
            ctx.ui.notify(`Blocked: ${pattern}`, "info");
            persistState();
          } else {
            ctx.ui.notify("Usage: /hitl block <pattern>", "warning");
          }
          break;

        case "allow":
          if (pattern) {
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
          const verbose = args.includes("--verbose");
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
      // Signal pause - handled in before_agent_start
      state.hitlTurnCounter = 0; // Force a pause
      ctx.ui.notify("Paused for human input", "info");
    },
  });

  // ========================================
  // Keyboard Shortcuts
  // ========================================

  // Ctrl+Tab to cycle modes
  pi.registerShortcut(Key.ctrlTab, {
    description: "Cycle to next operation mode",
    handler: async (ctx) => cycleMode(ctx, true),
  });

  // Escape to stop autopilot
  pi.registerShortcut(Key.escape, {
    description: "Stop autopilot execution",
    handler: async (ctx) => {
      if (state.autopilotRunning) {
        state.autopilotRunning = false;
        ctx.ui.notify("Autopilot stopped. Type 'continue' to resume or new instructions.", "info");
      }
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

      // Check if matches blocked file pattern
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

      // Check allowlist first
      if (state.hitlRules.allowlist.some((p) => command.toLowerCase().includes(p.toLowerCase()))) {
        return; // Allowed
      }

      // Check blocklist
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
  pi.on("before_agent_start", async (event, ctx) => {
    const messages: Array<{ customType: string; content: string; display: boolean }> = [];

    // Mode-specific context
    switch (state.currentMode) {
      case "planning":
        messages.push({
          customType: "mode-context",
          content: `[PLANNING MODE ACTIVE]
You are in planning mode - a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: read, bash (safe commands), grep, find, ls, questionnaire
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to read-only commands

Create a detailed numbered plan under a "Plan:" header. Use /grill-me or /grill-me-with-docs to refine the plan through questioning.

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.`,
          display: false,
        });
        break;

      case "autopilot":
        if (state.autopilotRunning) {
          messages.push({
            customType: "mode-context",
            content: `[AUTOPILOT MODE - Continuous execution enabled]
Execute the plan continuously. When done, report summary.
Press Escape or type "stop" to halt.`,
            display: false,
          });
        }
        break;

      case "hitl":
        state.hitlTurnCounter++;
        // Pause every 2-3 turns
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

    // Efficient mode context
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

    // Update context usage
    const context = ctx.getContextUsage();
    if (context) {
      state.tokenStats.contextUsage = Math.round((context.tokens / context.limit) * 100);

      // Auto-enable efficient mode at 80%
      if (state.tokenStats.contextUsage >= 80 && !state.efficientMode) {
        ctx.ui.notify("Context at 80% - Efficient mode auto-enabled", "warning");
        state.efficientMode = true;
        persistState();
      }
    }

    // Check autopilot stop condition
    if (state.autopilotRunning && state.currentMode === "autopilot") {
      // Check if user typed "stop"
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
      // Extract todos from plan
      // This would need to parse the assistant message for "Plan:" sections
      // For now, just prompt for execution
      const choice = await ctx.ui.select("Planning complete - what next?", [
        "Execute the plan (Autopilot)",
        "Stay in planning mode",
        "Refine the plan",
      ]);

      if (choice?.startsWith("Execute")) {
        switchMode(ctx, "autopilot");
        state.autopilotRunning = true;
        pi.sendUserMessage("Execute the plan you just created.");
      } else if (choice === "Refine the plan") {
        const refinement = await ctx.ui.editor("Refine the plan:", "");
        if (refinement?.trim()) {
          pi.sendUserMessage(refinement.trim());
        }
      }
    }

    if (state.currentMode === "autopilot" && state.autopilotRunning) {
      // Autopilot continues - check if done
      // For now, just continue unless stopped
    }
  });

  // ========================================
  // Initialize
  // ========================================

  // Register flag for starting in specific mode
  pi.registerFlag("mode", {
    description: "Start in specific mode (yolo, planning, autopilot, hitl)",
    type: "string",
    default: "yolo",
  });

  // Register flag for efficient mode
  pi.registerFlag("efficient", {
    description: "Start in efficient mode",
    type: "boolean",
    default: false,
  });
}
