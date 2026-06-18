import type { Session } from '../session.js';
import { findSkill } from '../claude/skill-scanner.js';
import { logger } from '../logger.js';
import { handleHelp, handleClear, handleCwd, handleModel, handleStatus, handleSkills, handleHistory, handleReset, handleCompact, handleUndo, handleVersion, handlePrompt, handleResume, handleSend, handleUnknown } from './handlers.js';

export interface CommandContext {
  accountId: string;
  session: Session;
  updateSession: (partial: Partial<Session>) => void;
  clearSession: () => Session;
  getChatHistoryText?: (limit?: number) => string;
  text: string;
}

export interface CommandResult {
  /**
   * Single-message reply. The bridge sends this as one WeChat TEXT item.
   * For commands whose output is naturally multi-row (e.g. /resume list),
   * prefer `replies` instead — WeChat folds a long single TEXT item into a
   * grey "long message" card that wraps awkwardly, whereas several short
   * TEXT items render as separate chat bubbles.
   */
  reply?: string;
  /**
   * Multi-bubble reply. The bridge sends each entry as its own WeChat
   * TEXT item, in order. Use this when the output has natural row/line
   * boundaries that should each appear as a separate bubble.
   */
  replies?: string[];
  handled: boolean;
  claudePrompt?: string;
  sendFile?: string; // Absolute path to a file to send to the user
}

/**
 * Parse and dispatch a slash command.
 *
 * Supported commands:
 *   /help     - Show help text with all available commands
 *   /clear    - Clear the current session
 *   /model <name> - Update the session model
 *   /status   - Show current session info
 *   /skills   - List all installed skills
 *   /<skill>  - Invoke a skill by name (args are forwarded to Claude)
 */
export async function routeCommand(ctx: CommandContext): Promise<CommandResult> {
  const text = ctx.text.trim();

  if (!text.startsWith('/')) {
    return { handled: false };
  }

  const spaceIdx = text.indexOf(' ');
  const cmd = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

  logger.info(`Slash command: /${cmd} ${args}`.trimEnd());

  switch (cmd) {
    case 'help':
      return handleHelp(args);
    case 'clear':
      return handleClear(ctx);
    case 'reset':
      return handleReset(ctx);
    case 'cwd':
      return handleCwd(ctx, args);
    case 'model':
      return handleModel(ctx, args);
    case 'prompt':
      return handlePrompt(ctx, args);
    case 'status':
      return handleStatus(ctx);
    case 'skills':
      return handleSkills(args);
    case 'history':
      return handleHistory(ctx, args);
    case 'undo':
      return handleUndo(ctx, args);
    case 'compact':
      return handleCompact(ctx);
    case 'send':
      return handleSend(ctx, args);
    case 'version':
    case 'v':
      return handleVersion();
    case 'resume':
      return handleResume(ctx, args);
    default:
      return handleUnknown(cmd, args);
  }
}
