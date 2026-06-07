import {
  query,
  type SDKMessage,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../logger.js";
import { execSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface QueryOptions {
  prompt: string;
  cwd: string;
  resume?: string;
  model?: string;
  systemPrompt?: string;
  images?: Array<{
    type: "image";
    source: { type: "base64"; media_type: string; data: string };
  }>;
  /** Called each time an assistant text chunk is produced (e.g. before/after tool calls). */
  onText?: (text: string) => Promise<void> | void;
  /** Called when Claude invokes a tool, with a human-readable summary. */
  onThinking?: (summary: string) => Promise<void> | void;
  /** Optional abort controller to cancel the query (e.g. when user sends a new message). */
  abortController?: AbortController;
}

export interface QueryResult {
  text: string;
  sessionId: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Tools that should be hidden from the user (internal bookkeeping).
 */
const HIDDEN_TOOLS = new Set([
  'TodoWrite', 'TodoRead', 'Task', 'Agent',
]);

/**
 * Extract MCP service name: mcp__zread__read_file → zread
 */
function getMcpServiceName(name: string): string | null {
  if (!name.startsWith('mcp__')) return null;
  const parts = name.split('__');
  return parts.length >= 3 ? parts[1] : null;
}

/**
 * Format a tool_use block into a concise human-readable summary.
 */
function formatToolUse(toolName: string, input: Record<string, unknown>): string | null {
  if (HIDDEN_TOOLS.has(toolName)) return null;

  // MCP tools: simple "调用 xxx MCP"
  const mcpService = getMcpServiceName(toolName);
  if (mcpService) {
    return `▸ 调用 ${mcpService} MCP`;
  }

  const labels: Record<string, string> = {
    Bash: "执行", Read: "读取", Write: "写入", Edit: "编辑", MultiEdit: "编辑",
    Grep: "搜索", Glob: "搜索", WebFetch: "抓取", WebSearch: "搜索",
    Skill: "使用",
  };
  const label = labels[toolName] ?? "调用";

  let detail = "";
  if (input.command) detail = String(input.command).slice(0, 60);
  else if (input.file_path) {
    const p = String(input.file_path);
    detail = p.split('/').slice(-2).join('/');
  }
  else if (input.url) detail = String(input.url).slice(0, 60);
  else if (input.query) detail = String(input.query).slice(0, 50);
  else if (input.pattern) detail = String(input.pattern).slice(0, 50);
  else if (input.search_query) detail = String(input.search_query).slice(0, 50);

  return detail ? `▸ ${label} ${detail}` : `▸ ${label} ${toolName}`;
}

/**
 * Extract accumulated text from an SDK assistant message's content blocks.
 */
function extractText(msg: SDKAssistantMessage): string {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block.type === "text")
    .map((block: any) => (block.text as string) ?? "")
    .join("");
}

/**
 * Extract session_id from any SDKMessage that carries one.
 */
function getSessionId(msg: SDKMessage): string | undefined {
  if ("session_id" in msg) {
    return (msg as { session_id: string }).session_id;
  }
  return undefined;
}

/**
 * Build an async iterable yielding a single SDKUserMessage with optional
 * image content blocks.  The session_id is set to "" — the SDK assigns the
 * real session id once the process starts.
 */
async function* singleUserMessage(
  text: string,
  images?: QueryOptions["images"],
): AsyncGenerator<SDKUserMessage, void, unknown> {
  const contentBlocks: Array<{
    type: string;
    text?: string;
    source?: { type: "base64"; media_type: string; data: string };
  }> = [{ type: "text", text }];

  if (images?.length) {
    for (const img of images) {
      contentBlocks.push({ type: "image", source: img.source });
    }
  }

  const msg: SDKUserMessage = {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: contentBlocks,
    },
  };

  yield msg;
}

// ---------------------------------------------------------------------------
// Resolve global claude cli.js path (avoids bundled old version in SDK)
// ---------------------------------------------------------------------------

function resolveGlobalClaudeCliPath(): string | undefined {
  try {
    const claudeBin = execSync("which claude", { encoding: "utf8" }).trim();
    if (!claudeBin) return undefined;
    // Resolve symlinks safely via fs.realpathSync instead of shell interpolation
    let realBin: string;
    try {
      realBin = realpathSync(claudeBin);
    } catch {
      realBin = claudeBin;
    }
    // On npm global installs, the binary itself is cli.js
    if (realBin.endsWith(".js") && existsSync(realBin)) return realBin;
    // Otherwise look for cli.js next to the binary
    const cliJs = join(dirname(realBin), "cli.js");
    if (existsSync(cliJs)) return cliJs;
    // Try npm global prefix
    const npmPrefix = execSync("npm config get prefix", { encoding: "utf8" }).trim();
    const npmCli = join(npmPrefix, "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    if (existsSync(npmCli)) return npmCli;
  } catch {
    // ignore
  }
  return undefined;
}

const GLOBAL_CLAUDE_CLI_PATH = resolveGlobalClaudeCliPath();

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

export async function claudeQuery(options: QueryOptions): Promise<QueryResult> {
  const {
    prompt,
    cwd,
    resume,
    model,
    systemPrompt,
    images,
    onText,
    onThinking,
    abortController,
  } = options;

  logger.info("Starting Claude query", {
    cwd,
    model,
    resume: !!resume,
    hasImages: !!images?.length,
  });

  // When images are present we use the multi-content AsyncIterable path;
  // otherwise a plain string is simpler and sufficient.
  const hasImages = images && images.length > 0;
  const promptParam: string | AsyncIterable<SDKUserMessage> = hasImages
    ? singleUserMessage(prompt, images)
    : prompt;

  // --- Build SDK options ---
  const sdkOptions: Options = {
    cwd,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: ["user", "project"],
    includePartialMessages: !!onText,
  };

  // Use the globally installed claude cli.js to avoid version mismatch with the bundled one
  if (GLOBAL_CLAUDE_CLI_PATH) {
    (sdkOptions as any).pathToClaudeCodeExecutable = GLOBAL_CLAUDE_CLI_PATH;
    logger.debug("Using global claude cli.js", { path: GLOBAL_CLAUDE_CLI_PATH });
  }

  if (model) sdkOptions.model = model;
  if (resume) sdkOptions.resume = resume;
  if (abortController) sdkOptions.abortController = abortController;
  if (systemPrompt) {
    (sdkOptions as any).systemPrompt = { type: "preset", preset: "claude_code", append: systemPrompt };
  }

  // --- Execute query & accumulate output ---
  let sessionId = "";
  const textParts: string[] = [];
  let errorMessage: string | undefined;

  const QUERY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  try {
    const result = query({ prompt: promptParam, options: sdkOptions });

    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Claude query timed out after 5 minutes')), QUERY_TIMEOUT_MS);
    });

    const iterateResult = async () => {
      for await (const message of result) {
      const sid = getSessionId(message);
      if (sid) sessionId = sid;

      switch (message.type) {
        case "assistant": {
          const aMsg = message as SDKAssistantMessage;
          const content = aMsg.message?.content;
          // Extract tool_use blocks and notify onThinking
          if (onThinking) {
            if (Array.isArray(content)) {
              for (const block of content) {
                if ((block as any).type === "tool_use") {
                  const summary = formatToolUse(
                    (block as any).name ?? "Tool",
                    (block as any).input ?? {},
                  );
                  if (summary) await onThinking(summary);
                }
              }
            }
          }
          // Accumulate text (actual streaming is handled via stream_event below)
          const text = extractText(aMsg);
          if (text) {
            textParts.push(text);
          }
          break;
        }
        case "stream_event": {
          const evt = (message as any).event;
          if (evt?.type === "content_block_delta") {
            const deltaType: string = evt.delta?.type ?? "";
            if (deltaType === "text_delta" && onText) {
              const delta: string = evt.delta.text;
              if (delta) await onText(delta);
            }
          }
          break;
        }
        case "result": {
          const rm = message as SDKResultMessage;
          if (rm.subtype === "success" && "result" in rm) {
            // The SDK result message carries the final result string.
            // Append only when it adds content not yet seen.
            if (rm.result) {
              const combined = textParts.join("");
              if (!combined.includes(rm.result)) {
                textParts.push(rm.result);
              }
            }
          } else if ("errors" in rm && rm.errors.length > 0) {
            errorMessage = rm.errors.join("; ");
            logger.error("SDK returned error result", { errors: rm.errors });
          }
          break;
        }
        case "system": {
          logger.debug("SDK system message", {
            subtype: (message as { subtype?: string }).subtype,
          });
          break;
        }
        default:
          // tool_progress, auth_status, etc. — ignore
          break;
      }
    }
    };

    try {
      await Promise.race([iterateResult(), timeoutPromise]);
    } finally {
      clearTimeout(timeoutId!);
    }
  } catch (err: unknown) {
    errorMessage = err instanceof Error ? err.message : String(err);
    logger.error("Claude query threw", { error: errorMessage });
  }

  const fullText = textParts.join("\n").trim();

  if (!fullText && !errorMessage) {
    errorMessage = "Claude returned an empty response.";
  }

  logger.info("Claude query completed", {
    sessionId,
    textLength: fullText.length,
    hasError: !!errorMessage,
  });

  return {
    text: fullText,
    sessionId,
    error: errorMessage,
  };
}
