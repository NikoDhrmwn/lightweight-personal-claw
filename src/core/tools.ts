/**
 * LiteClaw — Tool Registry & Lazy Loader
 * 
 * Tools are registered with a decorator pattern. Only relevant tools
 * are injected per turn to conserve context window for small LLMs.
 */

import { createLogger } from '../logger.js';
import { LLMToolDef, LLMToolCall } from './llm.js';

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
    return Array.from(this.tools.values());
  }

  /**
   * Lazy load: select only tools relevant to the current message.
   * Scores tools by keyword match and always includes high-priority tools.
   */
  selectRelevant(userMessage: string, maxTools: number = 6): ToolDefinition[] {
    const msgLower = userMessage.toLowerCase();
    const scored: { tool: ToolDefinition; score: number }[] = [];

    for (const tool of this.tools.values()) {
      let score = 0;

      // Keyword matching
      for (const kw of tool.keywords) {
        if (msgLower.includes(kw.toLowerCase())) {
          score += 2;
        }
      }

      // Category-based boosting
      if (tool.category === 'exec' && (msgLower.includes('run') || msgLower.includes('execute') || msgLower.includes('command'))) {
        score += 1;
      }
      if (tool.category === 'filesystem' && (msgLower.includes('file') || msgLower.includes('read') || msgLower.includes('write') || msgLower.includes('create') || msgLower.includes('delete') || msgLower.includes('folder') || msgLower.includes('directory'))) {
        score += 1;
      }

      // Always include if explicitly mentioned
      if (msgLower.includes(tool.name)) {
        score += 5;
      }

      scored.push({ tool, score });
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Always include at least exec and read_file (most commonly needed)
    const alwaysInclude = ['exec', 'read_file', 'list_dir'];
    const result: ToolDefinition[] = [];
    const included = new Set<string>();

    // Add always-include tools first
    for (const name of alwaysInclude) {
      const tool = this.tools.get(name);
      if (tool) {
        result.push(tool);
        included.add(name);
      }
    }

    // Fill remaining slots with scored tools
    for (const { tool, score } of scored) {
      if (result.length >= maxTools) break;
      if (included.has(tool.name)) continue;
      if (score > 0) {
        result.push(tool);
        included.add(tool.name);
      }
    }

    // If nothing scored, include the always-include tools only
    log.debug(
      { selected: result.map(t => t.name), total: this.tools.size },
      'Selected relevant tools'
    );

    return result;
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

// ─── Singleton Registry ──────────────────────────────────────────────

export const toolRegistry = new ToolRegistry();
