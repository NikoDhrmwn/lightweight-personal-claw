/**
 * LiteClaw — Tool Registry & Lazy Loader
 * 
 * Tools are registered with a decorator pattern. Only relevant tools
 * are injected per turn to conserve context window for small LLMs.
 */

import { createLogger } from '../logger.js';
import { LLMToolDef, LLMToolCall } from './llm.js';
import { getConfig } from '../config.js';

const log = createLogger('tools');

// ─── Types ───────────────────────────────────────────────────────────

export interface ToolParameter {
  name: string;
  type: string;
  description: string;
  required?: boolean;
  enum?: string[];
  items?: Record<string, any>;
  properties?: Record<string, any>;
  additionalProperties?: boolean | Record<string, any>;
}

export interface InteractiveChoiceRequest {
  prompt: string;
  options: string[];
  responses?: Record<string, string>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  category: 'filesystem' | 'exec' | 'web' | 'vision' | 'channel' | 'utility';
  parameters: ToolParameter[];
  /** Compact retrieval-friendly guidance for weaker models */
  usageNotes?: string[];
  /** Short examples that can be surfaced when relevant */
  examples?: Array<{
    userIntent: string;
    arguments: Record<string, any>;
  }>;
  /** Keywords that trigger lazy-loading this tool */
  keywords: string[];
  /** Does this tool require confirmation before execution? */
  requiresConfirmation?: boolean;
  /** The handler function */
  handler: (args: Record<string, any>, context: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  /** The channel this request came from */
  channelType: 'webui' | 'discord' | 'whatsapp' | 'cli';
  /** Channel-specific target (e.g., channel ID, phone number) */
  channelTarget?: string;
  /** Working directory for exec/file operations */
  workingDir: string;
  /** Function to request confirmation from the user */
  requestConfirmation?: (message: string) => Promise<boolean>;
  /** Function to send a file to the originating channel */
  sendFile?: (filePath: string, fileName?: string) => Promise<void>;
  /** Function to send an interactive choice prompt to the originating channel */
  sendInteractiveChoice?: (request: InteractiveChoiceRequest) => Promise<string>;
}

export interface ToolResult {
  success: boolean;
  output: string;
  /** If tool created/has a file to offer sending */
  filePath?: string;
  /** If true, the tool output needs confirmation before proceeding */
  needsConfirmation?: boolean;
  confirmationMessage?: string;
}

// ─── Category Enablement ─────────────────────────────────────────────

const CATEGORY_CONFIG_KEY: Record<string, string> = {
  filesystem: 'filesystem',
  exec: 'exec',
  web: 'web',
  vision: 'vision',
  channel: 'filesystem', // channel tools (send_file) follow filesystem enablement
  utility: 'exec',       // utility tools follow exec enablement
};

function isToolCategoryEnabled(category: string): boolean {
  const config = getConfig();
  const configKey = CATEGORY_CONFIG_KEY[category] ?? category;
  const toolConfig = (config.tools as any)?.[configKey];
  // Default to enabled if not explicitly set
  if (!toolConfig || toolConfig.enabled === undefined) return true;
  return !!toolConfig.enabled;
}

// ─── Tool Registry ───────────────────────────────────────────────────

class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
    log.debug({ tool: tool.name, category: tool.category }, 'Registered tool');
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values()).filter(t => isToolCategoryEnabled(t.category));
  }

  /**
   * Lazy load: select only tools relevant to the current message.
   * Scores tools by keyword match and always includes high-priority tools.
   */
  selectRelevant(userMessage: string, maxTools: number = 6): ToolDefinition[] {
    const msgLower = userMessage.toLowerCase();
    const mentionsLikelyFile = /[a-z0-9._-]+\.[a-z0-9]+/i.test(userMessage);
    const wantsEdit =
      msgLower.includes('edit') ||
      msgLower.includes('modify') ||
      msgLower.includes('update') ||
      msgLower.includes('change');
    const scored: { tool: ToolDefinition; score: number }[] = [];

    for (const tool of this.tools.values()) {
      // Skip disabled tool categories
      if (!isToolCategoryEnabled(tool.category)) continue;

      let score = 0;

      // Keyword matching
      for (const kw of tool.keywords) {
        if (msgLower.includes(kw.toLowerCase())) {
          score += 2;
        }
      }

      // Category-based boosting
      if (tool.category === 'exec' && (msgLower.includes('run') || msgLower.includes('execute') || msgLower.includes('command') || msgLower.includes('install') || msgLower.includes('build'))) {
        score += 1;
      }
      if (tool.category === 'filesystem' && (msgLower.includes('file') || msgLower.includes('read') || msgLower.includes('write') || msgLower.includes('create') || msgLower.includes('delete') || msgLower.includes('folder') || msgLower.includes('directory'))) {
        score += 1;
      }
      if (tool.category === 'web' && (msgLower.includes('search') || msgLower.includes('web') || msgLower.includes('latest') || msgLower.includes('news') || msgLower.includes('look up'))) {
        score += 1;
      }

      // Always include if explicitly mentioned
      if (msgLower.includes(tool.name)) {
        score += 5;
      }

      if (mentionsLikelyFile && tool.name === 'read_file') {
        score += 4;
      }

      if (mentionsLikelyFile && wantsEdit && tool.name === 'write_file') {
        score += 3;
      }

      scored.push({ tool, score });
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    const result: ToolDefinition[] = [];
    const included = new Set<string>();

    // Fill remaining slots with scored tools
    for (const { tool, score } of scored) {
      if (result.length >= maxTools) break;
      if (included.has(tool.name)) continue;
      if (score > 0) {
        result.push(tool);
        included.add(tool.name);
      }
    }

    // Safety fallback: if nothing scored, include only the most broadly useful read-only tools.
    if (result.length === 0) {
      for (const name of ['read_file', 'list_dir']) {
        const tool = this.tools.get(name);
        if (tool && result.length < Math.min(maxTools, 2)) {
          result.push(tool);
        }
      }
    }

    log.debug(
      { selected: result.map(t => t.name), total: this.tools.size },
      'Selected relevant tools'
    );

    return result;
  }

  /**
   * Build compact retrieval-augmented tool guidance for the selected tools.
   * This gives smaller models concrete usage hints without dumping every tool manual.
   */
  buildToolGuidance(tools: ToolDefinition[], userMessage: string, maxEntries: number = 4): string {
    const lowered = userMessage.toLowerCase();
    const ranked = tools
      .map(tool => ({
        tool,
        score: scoreToolGuidance(tool, lowered),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxEntries)
      .map(item => item.tool)
      .filter(tool => (tool.usageNotes?.length ?? 0) > 0 || (tool.examples?.length ?? 0) > 0);

    if (ranked.length === 0) return '';

    const lines = ['# Tool Usage Notes'];

    for (const tool of ranked) {
      lines.push(`## ${tool.name}`);
      if (tool.usageNotes && tool.usageNotes.length > 0) {
        for (const note of tool.usageNotes.slice(0, 4)) {
          lines.push(`- ${note}`);
        }
      }

      const example = pickMostRelevantExample(tool, lowered);
      if (example) {
        lines.push(`Example intent: ${example.userIntent}`);
        lines.push(`Example args: ${JSON.stringify(example.arguments)}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Convert selected tools to OpenAI tool definition format.
   */
  toLLMToolDefs(tools: ToolDefinition[]): LLMToolDef[] {
    return tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            tool.parameters.map(p => [
              p.name,
              {
                type: p.type,
                description: p.description,
                ...(p.items ? { items: p.items } : {}),
                ...(p.properties ? { properties: p.properties } : {}),
                ...(p.additionalProperties !== undefined ? { additionalProperties: p.additionalProperties } : {}),
                ...(p.enum ? { enum: p.enum } : {}),
              },
            ])
          ),
          required: tool.parameters.filter(p => p.required).map(p => p.name),
        },
      },
    }));
  }

  /**
   * Execute a tool call from the LLM.
   */
  async execute(
    toolCall: LLMToolCall,
    context: ToolContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolCall.function.name);
    if (!tool) {
      return {
        success: false,
        output: `Unknown tool: ${toolCall.function.name}`,
      };
    }

    // Enforce tools.*.enabled centrally
    if (!isToolCategoryEnabled(tool.category)) {
      return {
        success: false,
        output: `Tool "${tool.name}" is disabled (category "${tool.category}" is disabled in config).`,
      };
    }

    // Parse arguments
    let args: Record<string, any>;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch (err) {
      // Fallback: try to extract key-value pairs with regex
      log.warn({ raw: toolCall.function.arguments }, 'Failed to parse tool args as JSON, attempting regex extraction');
      args = extractArgsFromMalformedJSON(toolCall.function.arguments);
    }

    // Check confirmation requirement
    if (tool.requiresConfirmation && context.requestConfirmation) {
      const description = `Tool "${tool.name}" wants to: ${JSON.stringify(args)}`;
      const confirmed = await context.requestConfirmation(description);
      if (!confirmed) {
        return {
          success: false,
          output: 'User rejected the operation.',
        };
      }
    }

    try {
      log.info({ tool: tool.name, args }, 'Executing tool');
      const result = await tool.handler(args, context);
      log.info({ tool: tool.name, success: result.success }, 'Tool execution complete');
      return result;
    } catch (err: any) {
      log.error({ tool: tool.name, error: err.message }, 'Tool execution error');
      return {
        success: false,
        output: `Tool error: ${err.message}`,
      };
    }
  }
}

/**
 * Attempt to extract arguments from malformed JSON.
 * Small models often produce imperfect JSON — this is a safety net.
 */
function extractArgsFromMalformedJSON(raw: string): Record<string, any> {
  const args: Record<string, any> = {};

  // Try to find key: "value" or key: value patterns
  const kvPattern = /["']?(\w+)["']?\s*[:=]\s*["']([^"']*?)["']/g;
  let match;
  while ((match = kvPattern.exec(raw)) !== null) {
    args[match[1]] = match[2];
  }

  // If no matches found, try to use the raw string as a single argument
  if (Object.keys(args).length === 0 && raw.trim()) {
    // Common case: model just outputs the command/path as plain text
    args['input'] = raw.trim().replace(/^["']|["']$/g, '');
  }

  return args;
}

function scoreToolGuidance(tool: ToolDefinition, loweredMessage: string): number {
  let score = 0;
  if (loweredMessage.includes(tool.name.toLowerCase())) score += 10;

  for (const keyword of tool.keywords) {
    if (loweredMessage.includes(keyword.toLowerCase())) score += 2;
  }

  if (tool.examples) {
    for (const example of tool.examples) {
      if (loweredMessage.includes(example.userIntent.toLowerCase())) {
        score += 4;
      }
    }
  }

  return score;
}

function pickMostRelevantExample(
  tool: ToolDefinition,
  loweredMessage: string
): { userIntent: string; arguments: Record<string, any> } | null {
  if (!tool.examples || tool.examples.length === 0) return null;

  const ranked = [...tool.examples]
    .map(example => ({
      example,
      score: loweredMessage.includes(example.userIntent.toLowerCase()) ? 2 : 0,
    }))
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.example ?? null;
}

// ─── Singleton Registry ──────────────────────────────────────────────

export const toolRegistry = new ToolRegistry();
