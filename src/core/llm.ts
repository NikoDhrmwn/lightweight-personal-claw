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
  supportsReasoning: boolean;
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
        supportsReasoning: model.reasoning ?? false,
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
      supportsReasoning: true,
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
        supportsReasoning: model.reasoning ?? false,
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
    supportsReasoning: true,
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
    options?: { temperature?: number; topP?: number; topK?: number; maxTokens?: number; disableReasoning?: boolean; reasoningBudget?: number }
  ): AsyncGenerator<LLMStreamChunk> {
    this.refreshProviders();
    let lastError: Error | null = null;

    for (const provider of this.providers) {
      const client = this.createOpenAIClient(provider);
      const maxAttempts = isRetryFriendlyProvider(provider) ? 3 : 1;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const nativeToolsEnabled = shouldUseNativeTools(provider, tools);
          log.debug({ provider: provider.id, attempt, nativeToolsEnabled }, 'Attempting LLM provider');

        const isLocal = provider.id.startsWith('local/');
        const requestBody: any = {
          model: provider.model,
          messages: normalizeMessagesForProvider(messages, provider, nativeToolsEnabled) as any,
          stream: true,
          max_tokens: options?.maxTokens ?? provider.maxTokens,
        };

        if (!isLocal) {
          if (options?.temperature !== undefined) requestBody.temperature = options.temperature;
          if (options?.topP !== undefined) requestBody.top_p = options.topP;
          // top_k is not standard OpenAI, many strict proxies return 400.
          // max_tokens is already set at the root.
        }

        if (provider.supportsReasoning) {
          let reasoningConfig: { enabled: boolean; budget: number };
          if (options?.disableReasoning) {
            reasoningConfig = { enabled: false, budget: 0 };
          } else if (options?.reasoningBudget !== undefined) {
            reasoningConfig = { enabled: true, budget: options.reasoningBudget };
          } else {
            reasoningConfig = getReasoningConfig();
          }
          requestBody.reasoning = reasoningConfig.enabled ? 'on' : 'off';
          requestBody.reasoning_format = 'deepseek';
          requestBody.reasoning_budget = reasoningConfig.budget;
          requestBody.chat_template_kwargs = {
            ...(requestBody.chat_template_kwargs ?? {}),
            enable_thinking: reasoningConfig.enabled,
          };
        }

        if (nativeToolsEnabled && tools && tools.length > 0) {
          requestBody.tools = tools;
          requestBody.tool_choice = 'auto';
        }

        // ─── Sanitization for Non-Local Providers ───
        // Google and other strict providers will return 400 if they see unknown fields
        // like 'reasoning', 'reasoning_format', etc.
        if (!isLocal) {
          delete (requestBody as any).reasoning;
          delete (requestBody as any).reasoning_format;
          delete (requestBody as any).reasoning_budget;
          delete (requestBody as any).chat_template_kwargs;
          delete (requestBody as any).parallel_tool_calls;
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

        // Watchdog timeout between chunks (60s)
        // Watchdog timeout between chunks (60s)
        const watchdogStream = withTimeout(stream as any, 60_000);

        for await (const chunk of watchdogStream as any) {
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

          if (delta) {
            // log.debug({ deltaKeys: Object.keys(delta) }, 'LLM Delta received');
            if (delta.reasoning_content) {
              yield { type: 'thinking', content: delta.reasoning_content };
            }
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
                } else {
                  // Yield everything except a potential partial tag at the end
                  const lastOpenBracket = tagBuffer.lastIndexOf('<');
                  if (lastOpenBracket !== -1 && lastOpenBracket > tagBuffer.length - 10) {
                    // Possible partial </think> at the end, yield up to the bracket
                    const part = tagBuffer.slice(0, lastOpenBracket);
                    if (part.length > 0) yield { type: 'thinking', content: part };
                    tagBuffer = tagBuffer.slice(lastOpenBracket);
                    break;
                  } else {
                    // No tag near end, flush all
                    yield { type: 'thinking', content: tagBuffer };
                    tagBuffer = '';
                  }
                }
              } else if (isToolCall) {
                const endIdx = tagBuffer.indexOf('</tool_call>');
                const endAltIdx = tagBuffer.indexOf('<tool_call|>');

                let foundEndIdx = -1;
                let endTagLen = 0;

                if (endIdx !== -1 && (endAltIdx === -1 || endIdx < endAltIdx)) {
                  foundEndIdx = endIdx;
                  endTagLen = 12;
                } else if (endAltIdx !== -1) {
                  foundEndIdx = endAltIdx;
                  endTagLen = 12;
                }

                if (foundEndIdx !== -1) {
                  toolCallBuffer += tagBuffer.slice(0, foundEndIdx);
                  try {
                    let parsed: any;
                    if (toolCallBuffer.includes('call:')) {
                      // Extract name and args from format: call:name{args}
                      const parts = toolCallBuffer.split('call:')[1].trim();
                      const nameMatch = parts.match(/^([a-z0-9_-]+)/i);
                      const name = nameMatch?.[1];
                      const rawArgs = parts.slice(name?.length ?? 0).trim();

                      if (name) {
                        parsed = {
                          name,
                          arguments: rawArgs
                        };
                      }
                    } else if (/<function=/i.test(toolCallBuffer)) {
                      parsed = parseFunctionStyleToolCall(toolCallBuffer);
                    } else {
                      parsed = JSON.parse(toolCallBuffer.trim());
                    }

                    if (parsed) {
                      const tcId = `call_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
                      // Handle both standard JSON and extracted name/args
                      const args = typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments ?? {});

                      yield {
                        type: 'tool_call',
                        toolCall: {
                          id: tcId,
                          type: 'function',
                          function: {
                            name: parsed.name,
                            arguments: args
                          }
                        }
                      };
                    }
                  } catch (e: any) {
                    log.warn({ text: toolCallBuffer }, 'Failed to parse XML tool call');
                  }
                  tagBuffer = tagBuffer.slice(foundEndIdx + endTagLen);
                  isToolCall = false;
                  toolCallBuffer = '';
                } else {
                  // Buffer up to the last potential start of a tag
                  const lastOpenBracket = tagBuffer.lastIndexOf('<');
                  if (lastOpenBracket !== -1 && lastOpenBracket > tagBuffer.length - 15) {
                    const part = tagBuffer.slice(0, lastOpenBracket);
                    if (part.length > 0) toolCallBuffer += part;
                    tagBuffer = tagBuffer.slice(lastOpenBracket);
                    break;
                  } else {
                    toolCallBuffer += tagBuffer;
                    tagBuffer = '';
                  }
                }
              } else {
                // Looking for start tags
                const startThinkIdx = tagBuffer.indexOf('<think>');
                const startToolIdx = tagBuffer.indexOf('<tool_call>');
                const startAltToolIdx = tagBuffer.indexOf('<|tool_call|>');
                const startAltToolIdx2 = tagBuffer.indexOf('<|tool_call>');

                // Which one comes first?
                let startIdx = -1;
                let isNextThink = false;
                let tagLength = 0;

                const foundTags: { idx: number; len: number; isThink: boolean }[] = [];
                if (startThinkIdx !== -1) foundTags.push({ idx: startThinkIdx, len: 7, isThink: true });
                if (startToolIdx !== -1) foundTags.push({ idx: startToolIdx, len: 11, isThink: false });
                if (startAltToolIdx !== -1) foundTags.push({ idx: startAltToolIdx, len: 13, isThink: false });
                if (startAltToolIdx2 !== -1) foundTags.push({ idx: startAltToolIdx2, len: 12, isThink: false });

                foundTags.sort((a, b) => a.idx - b.idx);

                if (foundTags.length > 0) {
                  const first = foundTags[0];
                  startIdx = first.idx;
                  tagLength = first.len;
                  isNextThink = first.isThink;
                }

                if (startIdx !== -1) {
                  // Emit everything before tag as normal content
                  const contentPart = tagBuffer.slice(0, startIdx);
                  if (contentPart.length > 0) {
                    yield { type: 'content', content: contentPart };
                  }

                  if (isNextThink) {
                    tagBuffer = tagBuffer.slice(startIdx + tagLength);
                    isThinking = true;
                  } else {
                    tagBuffer = tagBuffer.slice(startIdx + tagLength);
                    isToolCall = true;
                    toolCallBuffer = '';
                  }
                } else if (tagBuffer.endsWith('<') || tagBuffer.match(/<\|?[a-z_]*$/i)) {
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
          const errorDetail = extractProviderError(err);
          const retryable = attempt < maxAttempts && isRetryableProviderError(err);
          log.warn({
            provider: provider.id,
            attempt,
            retryable,
            error: errorDetail.message,
            status: errorDetail.status,
          }, retryable ? 'Provider failed, retrying same provider' : 'Provider failed, trying fallback');
          if (retryable) {
            await delay(250 * Math.pow(2, attempt - 1));
            continue;
          }
          break;
        }
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
      const client = this.createOpenAIClient(provider);
      const maxAttempts = isRetryFriendlyProvider(provider) ? 3 : 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const response = await client.chat.completions.create({
            model: provider.model,
            messages: normalizeMessagesForProvider(messages, provider, false) as any,
            max_tokens: options?.maxTokens ?? 2048,
            temperature: 0.3,
          }, {
            signal: AbortSignal.timeout(60_000),
          });
          return response.choices[0]?.message?.content ?? '';
        } catch (err: any) {
          const errorDetail = extractProviderError(err);
          const retryable = attempt < maxAttempts && isRetryableProviderError(err);
          log.warn({ provider: provider.id, attempt, retryable, error: errorDetail.message, status: errorDetail.status }, 'Completion failed');
          if (retryable) {
            await delay(250 * Math.pow(2, attempt - 1));
            continue;
          }
          break;
        }
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

function getReasoningConfig(): { enabled: boolean; budget: number } {
  const level = String(getConfig().agent?.thinkingDefault ?? 'medium').toLowerCase();
  switch (level) {
    case 'off':
      return { enabled: false, budget: 0 };
    case 'low':
      return { enabled: true, budget: 1024 };
    case 'high':
      return { enabled: true, budget: 4096 };
    case 'medium':
    default:
      return { enabled: true, budget: 2048 };
  }
}

function parseFunctionStyleToolCall(raw: string): { name: string; arguments: Record<string, unknown> } | null {
  const functionMatch = raw.match(/<function=([a-z0-9_-]+)>\s*([\s\S]*?)<\/function>/i);
  if (!functionMatch) return null;

  const name = functionMatch[1];
  const body = functionMatch[2] ?? '';
  const args: Record<string, unknown> = {};
  const paramRegex = /<parameter=([a-z0-9_-]+)>\s*([\s\S]*?)\s*<\/parameter>/gi;

  let match: RegExpExecArray | null;
  while ((match = paramRegex.exec(body)) !== null) {
    const key = match[1];
    const rawValue = (match[2] ?? '').trim();

    if (!rawValue) {
      args[key] = '';
      continue;
    }

    try {
      args[key] = JSON.parse(rawValue);
    } catch {
      args[key] = rawValue;
    }
  }

  return { name, arguments: args };
}

function shouldUseNativeTools(provider: LLMProvider, tools?: LLMToolDef[]): boolean {
  if (!tools || tools.length === 0) return false;
  if (!provider.supportsTools) return false;
  if (isGoogleProvider(provider)) return false;
  return true;
}

function normalizeMessagesForProvider(
  messages: LLMMessage[],
  provider: LLMProvider,
  nativeToolsEnabled: boolean,
): any[] {
  const strictProvider = isGoogleProvider(provider);
  return messages.map(message => {
    let role: LLMMessage['role'] | 'user' = message.role;
    let content: string | LLMContentPart[] | null = message.content;
    const normalized: any = { role };

    if (!nativeToolsEnabled && message.role === 'assistant' && message.tool_calls?.length) {
      const contentText = flattenMessageContent(message.content);
      const toolTranscript = message.tool_calls
        .map(call => `<tool_call>\n${JSON.stringify({
          name: call.function.name,
          arguments: tryParseJson(call.function.arguments) ?? call.function.arguments,
        }, null, 2)}\n</tool_call>`)
        .join('\n\n');
      content = [contentText, toolTranscript].filter(Boolean).join('\n\n').trim();
    } else if (!nativeToolsEnabled && message.role === 'tool') {
      role = 'user';
      normalized.role = role;
      content = `[TOOL RESULT]\n${flattenMessageContent(message.content)}`.trim();
    }

    if (nativeToolsEnabled && message.tool_calls?.length) {
      normalized.tool_calls = message.tool_calls;
    }
    if (nativeToolsEnabled && message.tool_call_id) {
      normalized.tool_call_id = message.tool_call_id;
    }
    if (message.name) normalized.name = message.name;

    if (strictProvider && message.role === 'assistant' && message.tool_calls?.length && flattenMessageContent(content ?? '').trim().length === 0) {
      normalized.content = null;
    } else {
      normalized.content = content;
    }

    return normalized;
  });
}

function flattenMessageContent(content: string | LLMContentPart[] | null): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content
    .map(part => part.type === 'text' ? (part.text ?? '') : `[image:${part.image_url?.detail ?? 'auto'}]`)
    .join('\n');
}

function isGoogleProvider(provider: Pick<LLMProvider, 'id' | 'baseUrl'>): boolean {
  return provider.id.startsWith('google/') || provider.baseUrl.includes('generativelanguage.googleapis.com');
}

function isRetryFriendlyProvider(provider: LLMProvider): boolean {
  return isGoogleProvider(provider) || !provider.id.startsWith('local/');
}

function isRetryableProviderError(err: any): boolean {
  const detail = extractProviderError(err);
  const message = detail.message.toLowerCase();
  return detail.status === 429
    || detail.status === 500
    || detail.status === 502
    || detail.status === 503
    || detail.status === 504
    || message.includes('timed out')
    || message.includes('timeout')
    || message.includes('stalled')
    || message.includes('empty body')
    || message.includes('connection');
}

function extractProviderError(err: any): { status?: number; message: string } {
  const status = err?.status ?? err?.response?.status ?? err?.cause?.status;
  const bodyMessage = err?.error?.message
    ?? err?.response?.data?.error?.message
    ?? err?.cause?.error?.message
    ?? err?.cause?.message;
  const message = String(bodyMessage || err?.message || 'unknown error').trim();
  return {
    status: typeof status === 'number' ? status : undefined,
    message: message || 'unknown error',
  };
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Watchdog wrapper for async iterables.
 * Throws an error if no item is yielded within the specified timeout.
 */
async function* withTimeout<T>(iterable: AsyncIterable<T>, timeoutMs: number): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    while (true) {
      let timeoutId: any;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`LLM stream stalled (no data for ${timeoutMs / 1000}s)`)), timeoutMs);
      });

      const nextPromise = iterator.next();
      const result = (await Promise.race([nextPromise, timeoutPromise])) as IteratorResult<T>;
      clearTimeout(timeoutId);

      if (result.done) break;
      yield result.value;
    }
  } finally {
    if (iterator.return) {
      await iterator.return();
    }
  }
}
