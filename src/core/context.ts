/**
 * LiteClaw — Context Window Manager
 * 
 * Manages token budgets for small LLMs. Keeps conversations within
 * the context window by rolling old turns and auto-summarizing.
 */

import { LLMClient, LLMMessage } from './llm.js';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('context');

// ─── Token Estimation ────────────────────────────────────────────────

/**
 * Estimate token count from text.
 * Uses a fast heuristic: ~4 chars per token for English text.
 * More accurate than word-count, cheaper than tiktoken.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Average English: ~4 chars per token for GPT-family models
  // For Gemma SentencePiece, it's closer to 3.5, but 4 is safe
  return Math.ceil(text.length / 4);
}

export function estimateMessageTokens(msg: LLMMessage): number {
  // Base overhead per message (role, formatting)
  let tokens = 4;

  if (typeof msg.content === 'string') {
    tokens += estimateTokens(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === 'text' && part.text) {
        tokens += estimateTokens(part.text);
      } else if (part.type === 'image_url') {
        // Vision tokens: ~258 tokens for low detail, ~1290 for high
        tokens += 300;
      }
    }
  }

  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      tokens += estimateTokens(tc.function.name);
      tokens += estimateTokens(tc.function.arguments);
      tokens += 10; // overhead
    }
  }

  return tokens;
}

// ─── Context Manager ─────────────────────────────────────────────────

export interface ContextBudget {
  total: number;
  system: number;
  tools: number;
  history: number;
  available: number;
}

export class ContextManager {
  private llmClient: LLMClient;
  private maxContextTokens: number;
  private budgetPct: number;
  private softThreshold: number;

  constructor(llmClient: LLMClient) {
    this.llmClient = llmClient;
    const config = getConfig();
    this.maxContextTokens = config.agent?.contextTokens ?? 64000;
    this.budgetPct = (config.agent?.contextBudgetPct ?? 80) / 100;
    this.softThreshold = config.agent?.compaction?.softThresholdTokens ?? 48000;
  }

  /**
   * Calculate the current token budget breakdown.
   */
  calculateBudget(
    systemPrompt: string,
    toolSchemas: string,
    history: LLMMessage[]
  ): ContextBudget {
    const total = Math.floor(this.maxContextTokens * this.budgetPct);
    const system = estimateTokens(systemPrompt);
    const tools = estimateTokens(toolSchemas);
    const historyTokens = history.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    const available = total - system - tools - historyTokens;

    return { total, system, tools, history: historyTokens, available };
  }

  /**
   * Trim conversation history to fit within the context budget.
   * Removes oldest messages first, keeping the system prompt and last N turns.
   */
  trimHistory(
    history: LLMMessage[],
    systemTokens: number,
    toolTokens: number
  ): LLMMessage[] {
    const budget = Math.floor(this.maxContextTokens * this.budgetPct) - systemTokens - toolTokens;

    if (budget <= 0) {
      log.warn('Context budget exhausted by system prompt and tools alone!');
      return history.slice(-2); // Keep at minimum the last exchange
    }

    // Calculate total history tokens
    let totalTokens = 0;
    const tokenCounts = history.map(m => {
      const t = estimateMessageTokens(m);
      totalTokens += t;
      return t;
    });

    // If within budget, return as-is
    if (totalTokens <= budget) return history;

    // Trim from the front (oldest messages first)
    const trimmed: LLMMessage[] = [];
    let usedTokens = 0;

    // Walk backwards (newest first)
    for (let i = history.length - 1; i >= 0; i--) {
      if (usedTokens + tokenCounts[i] > budget) break;
      usedTokens += tokenCounts[i];
      trimmed.unshift(history[i]);
    }

    if (trimmed.length < history.length) {
      log.info(
        { removed: history.length - trimmed.length, kept: trimmed.length },
        'Trimmed conversation history to fit context window'
      );
    }

    return trimmed;
  }

  /**
   * Check if we should trigger compaction (auto-summarize).
   */
  shouldCompact(history: LLMMessage[]): boolean {
    const historyTokens = history.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    return historyTokens >= this.softThreshold;
  }

  /**
   * Summarize old history into a condensed message.
   * Uses the LLM itself to produce a summary.
   */
  async compactHistory(history: LLMMessage[]): Promise<{ summary: LLMMessage; remaining: LLMMessage[] }> {
    if (history.length <= 4) {
      return { summary: { role: 'system', content: '' }, remaining: history };
    }

    // Split: summarize all but last 4 messages
    const toSummarize = history.slice(0, -4);
    const remaining = history.slice(-4);

    const summaryText = toSummarize
      .map(m => {
        const content = typeof m.content === 'string' ? m.content : '[multimodal content]';
        return `${m.role}: ${content.slice(0, 200)}`;
      })
      .join('\n');

    try {
      const summary = await this.llmClient.complete([
        {
          role: 'system',
          content: 'Summarize this conversation history in 2-3 concise sentences. Focus on key facts, decisions, and any file/tool operations performed. Be brief.',
        },
        { role: 'user', content: summaryText },
      ], { maxTokens: 256 });

      log.info(
        { summarized: toSummarize.length, remaining: remaining.length },
        'Compacted conversation history'
      );

      return {
        summary: {
          role: 'system',
          content: `[Previous conversation summary: ${summary}]`,
        },
        remaining,
      };
    } catch (err: any) {
      log.error({ error: err.message }, 'Failed to compact history');
      // Fallback: just trim
      return { summary: { role: 'system', content: '' }, remaining };
    }
  }
}
