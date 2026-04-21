/**
 * LiteClaw — LLM Provider Abstraction
 * 
 * Handles communication with local llama-server (OpenAI-compatible),
 * Ollama, and Google Gemini API as fallback.
 * Supports streaming, vision (native multimodal), and provider failover.
 */

import OpenAI from 'openai';
import { EventEmitter } from 'events';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('llm');

// ─── Types ───────────────────────────────────────────────────────────

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | LLMContentPart[];
  tool_call_id?: string;
  tool_calls?: LLMToolCall[];
  name?: string;
}

export interface LLMContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: 'low' | 'high' | 'auto' };
}

export interface LLMToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LLMToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMStreamChunk {
  type: 'content' | 'tool_call' | 'thinking' | 'done' | 'error';
  content?: string;
  toolCall?: LLMToolCall;
  error?: string;
  finishReason?: string;
}

export interface LLMProvider {
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  maxTokens: number;
  supportsVision: boolean;
  supportsTools: boolean;
}

// ─── Provider Registry ───────────────────────────────────────────────

export function buildProviders(): LLMProvider[] {
  const config = getConfig();
  const providers: LLMProvider[] = [];

  for (const [provId, prov] of Object.entries(config.llm?.providers ?? {})) {
    const p = prov as any;
    let baseUrl = p.baseUrl ?? '';
    if (!baseUrl && provId === 'google') baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/';

    for (const model of p.models ?? []) {
      // Skip auto-detect placeholders during sync build — they get resolved async
      if (model === 'auto' || model?.id === 'auto') continue;
      providers.push({
        id: `${provId}/${model.id}`,
        baseUrl,
        apiKey: p.apiKey ?? 'sk-no-key',
        model: model.id,
        contextWindow: model.contextWindow ?? 65536,
        maxTokens: model.maxTokens ?? 8192,
        supportsVision: model.vision ?? (model.input?.includes('image') ?? false),
        supportsTools: true,
      });
    }
  }

  return providers;
}

/**
 * Query a local OpenAI-compatible server's /v1/models endpoint
 * and return a dynamically detected LLMProvider.
 */
async function autoDetectLocalModel(provId: string, baseUrl: string, apiKey: string): Promise<LLMProvider | null> {
  try {
    const url = `${baseUrl.replace(/\/v1\/?$/, '')}/v1/models`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const body = await res.json() as any;
    // OpenAI format: body.data[0]
    const modelInfo = body.data?.[0];
    if (!modelInfo?.id) return null;

    // Extract capabilities from both Ollama-style and llama.cpp-style responses
    const meta = modelInfo.meta ?? {};
    const capabilities: string[] = body.models?.[0]?.capabilities ?? [];
    const hasVision = capabilities.includes('multimodal') || capabilities.includes('vision');
    const contextWindow = meta.n_ctx_train ?? 65536;

    log.info({ provider: provId, model: modelInfo.id, contextWindow, vision: hasVision }, 'Auto-detected model from server');

    return {
      id: `${provId}/${modelInfo.id}`,
      baseUrl,
      apiKey,
      model: modelInfo.id,
      contextWindow,
      maxTokens: Math.min(contextWindow, 8192),
      supportsVision: hasVision,
      supportsTools: true,
    };
  } catch (err: any) {
    log.debug({ provider: provId, error: err.message }, 'Auto-detect failed (server may be offline)');
    return null;
  }
}

/**
 * Build providers with async auto-detection for local servers.
 * Falls back to static config if the server is unreachable.
 */
export async function buildProvidersAsync(): Promise<LLMProvider[]> {
  const config = getConfig();
  const providers: LLMProvider[] = [];

  for (const [provId, prov] of Object.entries(config.llm?.providers ?? {})) {
    const p = prov as any;
    let baseUrl = p.baseUrl ?? '';
    if (!baseUrl && provId === 'google') baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/';
    
    const apiKey = p.apiKey ?? 'sk-no-key';
    const models = p.models ?? [];

    // Check if this provider wants auto-detection
    const wantsAuto = p.autoDetect === true ||
      models.length === 0 ||
      models.some((m: any) => m === 'auto' || m?.id === 'auto');

    if (wantsAuto && baseUrl) {
      const detected = await autoDetectLocalModel(provId, baseUrl, apiKey);
      if (detected) {
        providers.push(detected);
        continue; // Skip static models for this provider
      }
      // Fall through to static models if auto-detect fails
    }

    for (const model of models) {
      if (model === 'auto' || model?.id === 'auto') continue;
      providers.push({
        id: `${provId}/${model.id}`,
        baseUrl,
        apiKey,
        model: model.id,
        contextWindow: model.contextWindow ?? 65536,
        maxTokens: model.maxTokens ?? 8192,
        supportsVision: model.vision ?? (model.input?.includes('image') ?? false),
        supportsTools: true,
      });
    }
  }

  return providers;
}

export function getPrimaryProvider(): LLMProvider {
  const providers = buildProviders();
  const config = getConfig();
  const primaryId = config.llm?.defaults?.primary ?? '';

  const primary = providers.find(p => p.id === primaryId);
  if (primary) return primary;

  // Fallback: return first available
  if (providers.length > 0) return providers[0];

  // Absolute fallback
  return {
    id: 'local/default',
    baseUrl: process.env.LLM_BASE_URL ?? 'http://localhost:8080/v1',
    apiKey: process.env.LLM_API_KEY ?? 'sk-local',
    model: process.env.LLM_MODEL ?? 'gemma-4-e4b-heretic',
    contextWindow: 65536,
    maxTokens: 8192,
    supportsVision: true,
    supportsTools: true,
  };
}

export function getFallbackProviders(): LLMProvider[] {
  const providers = buildProviders();
  const config = getConfig();
  const fallbackIds = config.llm?.defaults?.fallbacks ?? [];
  return fallbackIds
    .map((id: string) => providers.find(p => p.id === id))
    .filter(Boolean) as LLMProvider[];
}

// ─── LLM Client ──────────────────────────────────────────────────────

export class LLMClient extends EventEmitter {
  private providers: LLMProvider[];
  private allProviders: LLMProvider[];
  private initialized = false;

  constructor() {
    super();
    this.providers = [];
    this.allProviders = [];
    this.refreshProviders(); // Sync fallback on startup
  }

  refreshProviders(): void {
    if (this.initialized) return; // Do not overwrite async auto-detected models
    const primary = getPrimaryProvider();
    const fallbacks = getFallbackProviders();
    this.providers = [primary, ...fallbacks];
  }

  getProviders(): LLMProvider[] {
    return this.providers;
  }

  getAllProviders(): LLMProvider[] {
    return this.allProviders;
  }

  /**
   * Async refresh that auto-detects models from running servers.
   * Call this once during startup to enable dynamic model detection.
   */
  async refreshProvidersAsync(): Promise<void> {
    const config = getConfig();
    const allProviders = await buildProvidersAsync();
    this.allProviders = allProviders;

    const primaryId = config.llm?.defaults?.primary ?? '';
    const fallbackIds = config.llm?.defaults?.fallbacks ?? [];

    // Try to find the configured primary exactly
    let primary = allProviders.find(p => p.id === primaryId);
    
    // If primary is 'auto', find the provider that originated from auto-detection
    if (!primary && (primaryId === 'auto' || primaryId.endsWith('/auto'))) {
      const autoProvId = Object.entries(config.llm?.providers ?? {}).find(([id, prov]: any) => 
         prov.autoDetect === true || (prov.models ?? []).some((m: any) => m.id === 'auto' || m === 'auto')
      )?.[0];
      
      if (autoProvId) {
         primary = allProviders.find(p => p.id.startsWith(`${autoProvId}/`));
      }
    }

    // Fallback to the first available if still not found
    if (!primary && allProviders.length > 0) {
      primary = allProviders[0];
    }
    if (!primary) {
      primary = getPrimaryProvider(); // Sync fallback
    }

    const fallbacks = fallbackIds
      .map((id: string) => allProviders.find(p => p.id === id))
      .filter(Boolean) as LLMProvider[];

    this.providers = [primary, ...fallbacks];
    this.initialized = true;

    log.info({ primary: primary.id, model: primary.model, fallbacks: fallbacks.length }, 'Providers initialized (async)');
  }

  private createOpenAIClient(provider: LLMProvider): OpenAI {
    return new OpenAI({
      baseURL: provider.baseUrl,
      apiKey: provider.apiKey,
      timeout: 120_000, // 2 min timeout for slow local models
    });
  }

  /**
   * Stream a chat completion from the LLM.
   * Yields LLMStreamChunks as they arrive.
   * Tries providers in order, falling back on errors.
   */
  async *streamChat(
    messages: LLMMessage[],
    tools?: LLMToolDef[],
    options?: { temperature?: number; maxTokens?: number }
  ): AsyncGenerator<LLMStreamChunk> {
    this.refreshProviders();
    let lastError: Error | null = null;

    for (const provider of this.providers) {
      try {
        log.debug({ provider: provider.id }, 'Attempting LLM provider');

        const client = this.createOpenAIClient(provider);

        const requestBody: any = {
          model: provider.model,
          messages: messages as any,
          stream: true,
          temperature: options?.temperature ?? 1.0,
          max_tokens: options?.maxTokens ?? provider.maxTokens,
        };

        if (tools && tools.length > 0) {
          requestBody.tools = tools;
          requestBody.tool_choice = 'auto';
        }

        const stream = await client.chat.completions.create(requestBody);

        // Track tool call accumulation across chunks.
        // Some providers stream native tool_calls, while smaller/local models
        // may emit XML-ish tags inside plain text instead.
        const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();
        let isThinking = false;
        let isToolCall = false;
        let toolCallBuffer = '';
        let tagBuffer = ''; // Buffer for partial tag detection

        for await (const chunk of stream as any) {
          const delta = chunk.choices?.[0]?.delta;
          const finishReason = chunk.choices?.[0]?.finish_reason;

          if ((!delta || Object.keys(delta).length === 0) && finishReason) {
            // Flush any pending tool calls
            for (const [, tc] of pendingToolCalls) {
              yield {
                type: 'tool_call',
                toolCall: {
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.name, arguments: tc.arguments },
                },
              };
            }
            if (tagBuffer.length > 0) {
              yield { type: isThinking ? 'thinking' : 'content', content: tagBuffer };
              tagBuffer = '';
            }
            yield { type: 'done', finishReason };
            return; // Success — don't try fallback
          }

          if (delta?.reasoning_content) {
            yield { type: 'thinking', content: delta.reasoning_content };
          }

          if (delta?.content) {
            // Accumulate into tag buffer for robust <think> tag handling
            tagBuffer += delta.content;

            // Process complete content from the buffer
            while (tagBuffer.length > 0) {
              if (isThinking) {
                const endIdx = tagBuffer.indexOf('</think>');
                if (endIdx !== -1) {
                  const thinkPart = tagBuffer.slice(0, endIdx);
                  if (thinkPart.length > 0) {
                    yield { type: 'thinking', content: thinkPart };
                  }
                  tagBuffer = tagBuffer.slice(endIdx + 8);
                  isThinking = false;
                } else if (tagBuffer.length > 20 && !tagBuffer.includes('<')) {
                  yield { type: 'thinking', content: tagBuffer };
                  tagBuffer = '';
                } else {
                  break;
                }
              } else if (isToolCall) {
                const endIdx = tagBuffer.indexOf('</tool_call>');
                if (endIdx !== -1) {
                  toolCallBuffer += tagBuffer.slice(0, endIdx);
                  try {
                    const parsed = JSON.parse(toolCallBuffer.trim());
                    // Create pending tool call format to yield
                    const tcId = `call_${Date.now()}_${Math.floor(Math.random()*1000)}`;
                    yield {
                      type: 'tool_call',
                      toolCall: {
                        id: tcId,
                        type: 'function',
                        function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments) }
                      }
                    };
                  } catch (e: any) {
                    log.warn({ text: toolCallBuffer }, 'Failed to parse XML tool call JSON');
                    yield { type: 'content', content: `\n\n[Warning: Failed to parse tool call: ${e.message}]\n` };
                  }
                  tagBuffer = tagBuffer.slice(endIdx + 13); // '</tool_call>'.length
                  isToolCall = false;
                  toolCallBuffer = '';
                } else if (tagBuffer.length > 20 && !tagBuffer.includes('<')) {
                  toolCallBuffer += tagBuffer;
                  tagBuffer = '';
                } else {
                  break;
                }
              } else {
                // Looking for start tags
                const startThinkIdx = tagBuffer.indexOf('<think>');
                const startToolIdx = tagBuffer.indexOf('<tool_call>');
                
                // Which one comes first?
                let startIdx = -1;
                let isNextThink = false;
                
                if (startThinkIdx !== -1 && (startToolIdx === -1 || startThinkIdx < startToolIdx)) {
                  startIdx = startThinkIdx;
                  isNextThink = true;
                } else if (startToolIdx !== -1 && (startThinkIdx === -1 || startToolIdx < startThinkIdx)) {
                  startIdx = startToolIdx;
                  isNextThink = false;
                }
                
                if (startIdx !== -1) {
                  // Emit everything before tag as normal content
                  const contentPart = tagBuffer.slice(0, startIdx);
                  if (contentPart.length > 0) {
                    yield { type: 'content', content: contentPart };
                  }
                  
                  if (isNextThink) {
                    tagBuffer = tagBuffer.slice(startIdx + 7);
                    isThinking = true;
                  } else {
                    tagBuffer = tagBuffer.slice(startIdx + 11);
                    isToolCall = true;
                    toolCallBuffer = '';
                  }
                } else if (tagBuffer.endsWith('<') || tagBuffer.match(/<[a-z_]*$/i)) {
                  // Might be start of a tag, wait for more data
                  break;
                } else {
                  // No tags, flush as content
                  yield { type: 'content', content: tagBuffer };
                  tagBuffer = '';
                }
              }
            }
          }

          // Accumulate tool calls across stream chunks
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!pendingToolCalls.has(idx)) {
                pendingToolCalls.set(idx, {
                  id: tc.id ?? `call_${idx}_${Date.now()}`,
                  name: tc.function?.name ?? '',
                  arguments: '',
                });
              }
              const pending = pendingToolCalls.get(idx)!;
              if (tc.function?.name) pending.name = tc.function.name;
              if (tc.function?.arguments) pending.arguments += tc.function.arguments;
            }
          }
        }

        // Flush any remaining tool calls
        for (const [, tc] of pendingToolCalls) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            },
          };
        }
        if (tagBuffer.length > 0) {
          yield { type: isThinking ? 'thinking' : 'content', content: tagBuffer };
        }

        // If stream ended without explicit finish_reason
        yield { type: 'done', finishReason: 'stop' };
        return;

      } catch (err: any) {
        lastError = err;
        log.warn({ provider: provider.id, error: err.message }, 'Provider failed, trying fallback');
        continue;
      }
    }

    // All providers failed
    yield {
      type: 'error',
      error: `All LLM providers failed. Last error: ${lastError?.message ?? 'unknown'}`,
    };
  }

  /**
   * Non-streaming completion (for summarization, etc.)
   */
  async complete(messages: LLMMessage[], options?: { maxTokens?: number }): Promise<string> {
    this.refreshProviders();
    for (const provider of this.providers) {
      try {
        const client = this.createOpenAIClient(provider);
        const response = await client.chat.completions.create({
          model: provider.model,
          messages: messages as any,
          max_tokens: options?.maxTokens ?? 2048,
          temperature: 0.3,
        });
        return response.choices[0]?.message?.content ?? '';
      } catch (err: any) {
        log.warn({ provider: provider.id, error: err.message }, 'Completion failed');
        continue;
      }
    }
    throw new Error('All LLM providers failed for completion');
  }

  getContextWindow(): number {
    this.refreshProviders();
    return this.providers[0]?.contextWindow ?? 65536;
  }

  getModelId(): string {
    this.refreshProviders();
    return this.providers[0]?.id ?? 'unknown';
  }
}
