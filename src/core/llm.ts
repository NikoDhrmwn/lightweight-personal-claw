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
  reasoning_content?: string;
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

type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'max';

interface ReasoningConfig {
  enabled: boolean;
  budget: number;
  effort: ReasoningEffort;
}

export interface LLMProvider {
  id: string;
  providerId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  maxTokens: number;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsReasoning: boolean;
  supportsTopK: boolean;
  rawProvider?: Record<string, any>;
  rawModel?: Record<string, any>;
}

// ─── Provider Registry ───────────────────────────────────────────────

export function buildProviders(): LLMProvider[] {
  const config = getConfig();
  const providers: LLMProvider[] = [];

  for (const [provId, prov] of Object.entries(config.llm?.providers ?? {})) {
    const p = prov as any;
    const baseUrl = getProviderBaseUrl(provId, p);
    const apiKey = p.apiKey ?? 'sk-no-key';

    for (const model of p.models ?? []) {
      // Skip auto-detect placeholders during sync build — they get resolved async
      if (model === 'auto' || model?.id === 'auto') continue;
      providers.push(buildProviderDefinition(provId, p, model, baseUrl, apiKey));
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
      providerId: provId,
      baseUrl,
      apiKey,
      model: modelInfo.id,
      contextWindow,
      maxTokens: Math.min(contextWindow, 8192),
      supportsVision: hasVision,
      supportsTools: true,
      supportsReasoning: true,
      supportsTopK: isLocalishBaseUrl(baseUrl),
      rawProvider: {},
      rawModel: modelInfo,
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
    const baseUrl = getProviderBaseUrl(provId, p);

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
      providers.push(buildProviderDefinition(provId, p, model, baseUrl, apiKey));
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
    providerId: 'local',
    baseUrl: process.env.LLM_BASE_URL ?? 'http://localhost:8080/v1',
    apiKey: process.env.LLM_API_KEY ?? 'sk-local',
    model: process.env.LLM_MODEL ?? 'gemma-4-e4b-heretic',
    contextWindow: 65536,
    maxTokens: 8192,
    supportsVision: true,
    supportsTools: true,
    supportsReasoning: true,
    supportsTopK: true,
    rawProvider: {},
    rawModel: {},
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

    log.info({
      discoveredProviders: allProviders.map(p => p.id),
      configPrimary: primaryId
    }, 'Discovered LLM providers');

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
      log.warn({ primaryId, fallbackTo: allProviders[0].id }, 'Configured primary model not found, falling back');
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

    log.info({
      primary: primary.id,
      model: primary.model,
      fallbacks: fallbacks.map(f => f.id),
      totalProviders: this.providers.length
    }, 'LLM Providers refreshed');
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
          log.info({ provider: provider.id, model: provider.model, baseUrl: provider.baseUrl, attempt }, 'Attempting LLM request');

        const requestBody: any = {
          model: provider.model,
          messages: normalizeMessagesForProvider(messages, provider, nativeToolsEnabled) as any,
          stream: true,
          max_tokens: options?.maxTokens ?? provider.maxTokens,
        };

        const reasoningConfig = resolveReasoningConfig(options);
        applySamplingSettings(requestBody, provider, options, reasoningConfig);
        applyReasoningSettings(requestBody, provider, reasoningConfig);

        if (nativeToolsEnabled && tools && tools.length > 0) {
          requestBody.tools = tools;
          requestBody.tool_choice = 'auto';
        }

        // ─── Sanitization for Non-Local Providers ───
        // Google and other strict providers will return 400 if they see unknown fields
        // like 'reasoning', 'reasoning_format', etc.
        const stream = await client.chat.completions.create(requestBody);

        // Track tool call accumulation across chunks.
        // Some providers stream native tool_calls, while smaller/local models
        // may emit XML-ish tags inside plain text instead.
        const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();
        let isThinking = false;
        let isToolCalling = false;
        let isDsmlCalling = false;
        let tagBuffer = '';

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

          const thinkingDelta = extractThinkingDelta(delta);
          if (thinkingDelta) {
            yield { type: 'thinking', content: thinkingDelta };
          }

          const contentDelta = extractContentDelta(delta);
          if (contentDelta) {
            tagBuffer += contentDelta;

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
                } else if (tagBuffer.indexOf('</thought>') !== -1) {
                  const endIdx = tagBuffer.indexOf('</thought>');
                  const thinkPart = tagBuffer.slice(0, endIdx);
                  if (thinkPart.length > 0) {
                    yield { type: 'thinking', content: thinkPart };
                  }
                  tagBuffer = tagBuffer.slice(endIdx + 10);
                  isThinking = false;
                } else if (tagBuffer.indexOf('</thinking>') !== -1) {
                  const endIdx = tagBuffer.indexOf('</thinking>');
                  const thinkPart = tagBuffer.slice(0, endIdx);
                  if (thinkPart.length > 0) {
                    yield { type: 'thinking', content: thinkPart };
                  }
                  tagBuffer = tagBuffer.slice(endIdx + 11);
                  isThinking = false;
                } else {
                  const lastOpenBracket = tagBuffer.lastIndexOf('<');
                  if (lastOpenBracket !== -1 && lastOpenBracket > tagBuffer.length - 10) {
                    const part = tagBuffer.slice(0, lastOpenBracket);
                    if (part.length > 0) yield { type: 'thinking', content: part };
                    tagBuffer = tagBuffer.slice(lastOpenBracket);
                    break;
                  } else {
                    yield { type: 'thinking', content: tagBuffer };
                    tagBuffer = '';
                  }
                }
              } else if (isDsmlCalling) {
                  const endIdx = tagBuffer.indexOf('</|DSML|tool_calls') !== -1 ? tagBuffer.indexOf('</|DSML|tool_calls') :
                                tagBuffer.indexOf('</｜DSML｜tool_calls') !== -1 ? tagBuffer.indexOf('</｜DSML｜tool_calls') : -1;
                  if (endIdx !== -1) {
                    const totalEndIdx = endIdx + (tagBuffer.includes('｜') ? 19 : 18);
                    // Check for optional closing bracket
                    const nextChar = tagBuffer[totalEndIdx];
                    const finalEndIdx = nextChar === '>' ? totalEndIdx + 1 : totalEndIdx;
                    const fullTag = tagBuffer.slice(0, finalEndIdx);

                    // Parse DSML content
                    const dsmlToolCalls = parseDsml(fullTag);
                    for (const tc of dsmlToolCalls) {
                      yield { type: 'tool_call', ...tc };
                    }

                    tagBuffer = tagBuffer.slice(totalEndIdx);
                    isDsmlCalling = false;
                  } else {
                    break;
                  }
              } else if (isToolCalling) {
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
                  const toolCallContent = tagBuffer.slice(0, foundEndIdx);
                  try {
                    let parsed: any;
                    if (toolCallContent.includes('call:')) {
                      const parts = toolCallContent.split('call:')[1].trim();
                      const nameMatch = parts.match(/^([a-z0-9_-]+)/i);
                      const name = nameMatch?.[1];
                      const rawArgs = parts.slice(name?.length ?? 0).trim();
                      if (name) {
                        parsed = { name, arguments: rawArgs };
                      }
                    } else if (/<function=/i.test(toolCallContent)) {
                      parsed = parseFunctionStyleToolCall(toolCallContent);
                    } else {
                      parsed = JSON.parse(toolCallContent.trim());
                    }

                    if (parsed) {
                      const tcId = `call_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
                      const args = typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments ?? {});
                      yield {
                        type: 'tool_call',
                        toolCall: { id: tcId, type: 'function', function: { name: parsed.name, arguments: args } }
                      };
                    }
                  } catch (e: any) {
                    log.warn({ text: toolCallContent }, 'Failed to parse XML tool call');
                  }
                  tagBuffer = tagBuffer.slice(foundEndIdx + endTagLen);
                  isToolCalling = false;
                } else {
                  const lastOpenBracket = tagBuffer.lastIndexOf('<');
                  if (lastOpenBracket !== -1 && lastOpenBracket > tagBuffer.length - 15) {
                    const part = tagBuffer.slice(0, lastOpenBracket);
                    if (part.length > 0) tagBuffer = tagBuffer.slice(lastOpenBracket);
                    break;
                  } else {
                    tagBuffer = '';
                  }
                }
              } else {
                const startThinkIdx = tagBuffer.indexOf('<think>');
                const startThoughtIdx = tagBuffer.indexOf('<thought>');
                const startThinkingIdx = tagBuffer.indexOf('<thinking>');
                const startToolIdx = tagBuffer.indexOf('<tool_call>');
                const startAltToolIdx = tagBuffer.indexOf('<|tool_call|>');
                const startAltToolIdx2 = tagBuffer.indexOf('<|tool_call>');
                const startDsmlIdx = tagBuffer.indexOf('<|DSML|tool_calls') !== -1 ? tagBuffer.indexOf('<|DSML|tool_calls') :
                                   tagBuffer.indexOf('<｜DSML｜tool_calls') !== -1 ? tagBuffer.indexOf('<｜DSML｜tool_calls') : -1;

                let startIdx = -1;
                let isNextThink = false;
                let tagLength = 0;

                const foundTags: { idx: number; len: number; isThink: boolean }[] = [];
                if (startThinkIdx !== -1) foundTags.push({ idx: startThinkIdx, len: 7, isThink: true });
                if (startThoughtIdx !== -1) foundTags.push({ idx: startThoughtIdx, len: 9, isThink: true });
                if (startThinkingIdx !== -1) foundTags.push({ idx: startThinkingIdx, len: 10, isThink: true });

                foundTags.sort((a, b) => a.idx - b.idx);

                if (foundTags.length > 0) {
                  const first = foundTags[0];
                  startIdx = first.idx;
                  tagLength = first.len;
                  isNextThink = first.isThink;
                } else if (startToolIdx !== -1 || startAltToolIdx !== -1 || startAltToolIdx2 !== -1 || startDsmlIdx !== -1) {
                  const idx = startToolIdx !== -1 ? startToolIdx :
                             startAltToolIdx !== -1 ? startAltToolIdx :
                             startAltToolIdx2 !== -1 ? startAltToolIdx2 : startDsmlIdx;

                  if (idx > 0) {
                    yield { type: 'content', content: tagBuffer.slice(0, idx) };
                    tagBuffer = tagBuffer.slice(idx);
                    // Do not continue here; let the next iteration of the while loop
                    // handle the tag now that it's at index 0
                  } else {
                    // Tag is at index 0, transition state
                    if (startDsmlIdx !== -1) {
                      isDsmlCalling = true;
                    } else {
                      isToolCalling = true;
                    }
                    // We don't slice here because the tool-specific blocks
                    // (isDsmlCalling/isToolCalling) expect to see the full tag for parsing
                  }
                  continue;
                }

                if (startIdx !== -1) {
                  const contentPart = tagBuffer.slice(0, startIdx);
                  if (contentPart.length > 0) yield { type: 'content', content: contentPart };
                  tagBuffer = tagBuffer.slice(startIdx + tagLength);
                  if (isNextThink) isThinking = true;
                  continue;
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

function getReasoningConfig(): ReasoningConfig {
  const level = String(getConfig().agent?.thinkingDefault ?? 'medium').toLowerCase();
  switch (level) {
    case 'off':
      return { enabled: false, budget: 0, effort: 'none' as const };
    case 'minimal':
      return { enabled: true, budget: 1024, effort: 'minimal' as const };
    case 'low':
      return { enabled: true, budget: 1024, effort: 'low' as const };
    case 'xhigh':
    case 'max':
      return { enabled: true, budget: 32768, effort: 'max' as const };
    case 'high':
      return { enabled: true, budget: 24576, effort: 'high' as const };
    case 'medium':
    default:
      return { enabled: true, budget: 8192, effort: 'medium' as const };
  }
}

function resolveReasoningConfig(options?: { disableReasoning?: boolean; reasoningBudget?: number }): ReasoningConfig {
  if (options?.disableReasoning) {
    return { enabled: false, budget: 0, effort: 'none' };
  }

  const config = getReasoningConfig();
  if (options?.reasoningBudget !== undefined) {
    return {
      enabled: options.reasoningBudget > 0,
      budget: Math.max(0, options.reasoningBudget),
      effort: options.reasoningBudget >= 24576 ? 'high' : options.reasoningBudget >= 8192 ? 'medium' : 'low',
    };
  }
  return config;
}

function getProviderBaseUrl(provId: string, providerConfig: Record<string, any>): string {
  let baseUrl = providerConfig.baseUrl ?? '';
  if (!baseUrl && provId === 'google') baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/';
  if (!baseUrl && provId === 'nvidia') baseUrl = 'https://integrate.api.nvidia.com/v1';
  if (!baseUrl && provId === 'deepseek') baseUrl = 'https://api.deepseek.com';
  return baseUrl;
}

function buildProviderDefinition(
  provId: string,
  providerConfig: Record<string, any>,
  model: Record<string, any>,
  baseUrl: string,
  apiKey: string,
): LLMProvider {
  const modelId = String(model.id ?? '');
  return {
    id: `${provId}/${modelId}`,
    providerId: provId,
    baseUrl,
    apiKey,
    model: modelId,
    contextWindow: model.contextWindow ?? 65536,
    maxTokens: model.maxTokens ?? 8192,
    supportsVision: model.vision ?? (model.input?.includes('image') ?? false),
    supportsTools: model.tools ?? true,
    supportsReasoning: inferSupportsReasoning(provId, baseUrl, modelId, model.reasoning),
    supportsTopK: inferSupportsTopK(provId, baseUrl, modelId, model.supportsTopK),
    rawProvider: providerConfig,
    rawModel: model,
  };
}

function inferSupportsReasoning(
  provId: string,
  baseUrl: string,
  modelId: string,
  configured?: boolean,
): boolean {
  if (configured === true) return true;

  const provider = provId.toLowerCase();
  const model = modelId.toLowerCase();
  const url = baseUrl.toLowerCase();

  if (provider === 'google' || url.includes('generativelanguage.googleapis.com')) {
    return model.includes('gemini-2.5') || model.includes('gemini-3');
  }
  if (provider === 'deepseek' || url.includes('api.deepseek.com')) {
    return model.includes('deepseek');
  }
  if (provider === 'nvidia' || url.includes('api.nvidia.com')) {
    return /(deepseek|nemotron|reason|kimi|glm)/.test(model);
  }

  return configured ?? false;
}

function inferSupportsTopK(
  provId: string,
  baseUrl: string,
  _modelId: string,
  configured?: boolean,
): boolean {
  if (typeof configured === 'boolean') return configured;
  const provider = provId.toLowerCase();
  if (provider === 'local' || provider === 'ollama') return true;
  return isLocalishBaseUrl(baseUrl);
}

function applySamplingSettings(
  requestBody: Record<string, any>,
  provider: LLMProvider,
  options: { temperature?: number; topP?: number; topK?: number } | undefined,
  reasoningConfig: ReasoningConfig,
): void {
  const skipSampling = isDeepSeekProvider(provider) && reasoningConfig.enabled;
  if (skipSampling) return;

  if (options?.temperature !== undefined) requestBody.temperature = options.temperature;
  if (options?.topP !== undefined) requestBody.top_p = options.topP;
  if (options?.topK !== undefined && provider.supportsTopK) requestBody.top_k = options.topK;
}

function applyReasoningSettings(
  requestBody: Record<string, any>,
  provider: LLMProvider,
  reasoningConfig: ReasoningConfig,
): void {
  if (!provider.supportsReasoning) return;

  if (isGoogleProvider(provider)) {
    if (!reasoningConfig.enabled) {
      if (canDisableGoogleReasoning(provider)) {
        requestBody.reasoning_effort = 'none';
      }
      return;
    }

    const googleThinkingConfig = buildGoogleThinkingConfig(provider, reasoningConfig);
    mergeExtraBody(requestBody, { google: { thinking_config: googleThinkingConfig } });
    return;
  }

  if (isDeepSeekProvider(provider)) {
    mergeExtraBody(requestBody, { thinking: { type: reasoningConfig.enabled ? 'enabled' : 'disabled' } });
    if (reasoningConfig.enabled) {
      requestBody.reasoning_effort = mapDeepSeekReasoningEffort(reasoningConfig.effort);
    }
    return;
  }

  if (isNvidiaProvider(provider)) {
    const chatTemplateKwargs: Record<string, any> = {
      thinking: reasoningConfig.enabled,
      enable_thinking: reasoningConfig.enabled,
    };
    if (reasoningConfig.enabled && reasoningConfig.effort === 'low' && isLowEffortNvidiaModel(provider)) {
      chatTemplateKwargs.low_effort = true;
    }
    mergeExtraBody(requestBody, {
      thinking: { type: reasoningConfig.enabled ? 'enabled' : 'disabled' },
    });
    mergeExtraBody(requestBody, { chat_template_kwargs: chatTemplateKwargs });
    return;
  }

  if (isLocalReasoningProvider(provider)) {
    mergeExtraBody(requestBody, {
      chat_template_kwargs: {
        enable_thinking: reasoningConfig.enabled,
      },
    });
    return;
  }

  requestBody.reasoning = reasoningConfig.enabled ? 'on' : 'off';
  requestBody.reasoning_format = 'deepseek';
  requestBody.reasoning_budget = reasoningConfig.budget;
  mergeExtraBody(requestBody, {
    chat_template_kwargs: {
      enable_thinking: reasoningConfig.enabled,
    },
  });
}

function buildGoogleThinkingConfig(provider: LLMProvider, reasoningConfig: ReasoningConfig): Record<string, any> {
  const model = provider.model.toLowerCase();
  if (model.includes('gemini-2.5')) {
    return {
      thinking_budget: mapGoogleThinkingBudget(reasoningConfig.effort),
      include_thoughts: true,
    };
  }

  return {
    thinking_level: mapGoogleThinkingLevel(reasoningConfig.effort),
    include_thoughts: true,
  };
}

function extractThinkingDelta(delta: any): string {
  if (!delta) return '';

  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
    return delta.reasoning_content;
  }
  if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) {
    return delta.reasoning;
  }
  if (Array.isArray(delta.reasoning)) {
    return delta.reasoning
      .map((part: any) => typeof part === 'string' ? part : part?.text ?? '')
      .filter(Boolean)
      .join('');
  }

  return '';
}

function extractContentDelta(delta: any): string {
  if (!delta) return '';

  if (typeof delta.content === 'string') {
    return delta.content;
  }

  if (Array.isArray(delta.content)) {
    return delta.content
      .map((part: any) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('');
  }

  if (typeof delta.output_text === 'string') {
    return delta.output_text;
  }

  return '';
}

function mapGoogleThinkingLevel(effort: ReasoningEffort): 'minimal' | 'low' | 'medium' | 'high' {
  switch (effort) {
    case 'none':
    case 'minimal':
      return 'minimal';
    case 'low':
      return 'low';
    case 'high':
    case 'max':
      return 'high';
    case 'medium':
    default:
      return 'medium';
  }
}

function mapGoogleThinkingBudget(effort: ReasoningEffort): number {
  switch (effort) {
    case 'none':
      return 0;
    case 'minimal':
    case 'low':
      return 1024;
    case 'high':
    case 'max':
      return 24576;
    case 'medium':
    default:
      return 8192;
  }
}

function canDisableGoogleReasoning(provider: LLMProvider): boolean {
  const model = provider.model.toLowerCase();
  return model.includes('gemini-2.5-flash') && !model.includes('pro');
}

function mapDeepSeekReasoningEffort(effort: ReasoningEffort): 'high' | 'max' {
  return effort === 'max' ? 'max' : 'high';
}

function isLocalishBaseUrl(baseUrl: string): boolean {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(baseUrl);
}

function isDeepSeekProvider(provider: Pick<LLMProvider, 'id' | 'baseUrl' | 'providerId'>): boolean {
  return provider.providerId === 'deepseek' || provider.id.startsWith('deepseek/') || provider.baseUrl.includes('api.deepseek.com');
}

function isLowEffortNvidiaModel(provider: LLMProvider): boolean {
  const model = provider.model.toLowerCase();
  return model.includes('nemotron');
}

function isLocalReasoningProvider(provider: Pick<LLMProvider, 'providerId' | 'baseUrl'>): boolean {
  return provider.providerId === 'local'
    || provider.providerId === 'ollama'
    || isLocalishBaseUrl(provider.baseUrl);
}

function mergeExtraBody(requestBody: Record<string, any>, patch: Record<string, any>): void {
  requestBody.extra_body = mergeObjects(requestBody.extra_body ?? {}, patch);
}

function mergeObjects(target: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  const next: Record<string, any> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(next[key])) {
      next[key] = mergeObjects(next[key], value as Record<string, any>);
    } else {
      next[key] = value;
    }
  }
  return next;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

export function shouldUseNativeTools(provider: LLMProvider, tools?: LLMToolDef[]): boolean {
  if (!tools || tools.length === 0) return false;
  if (!provider.supportsTools) return false;
  return true;
}

function normalizeMessagesForProvider(
  messages: LLMMessage[],
  provider: LLMProvider,
  nativeToolsEnabled: boolean,
): any[] {
  const strictProvider = isGoogleProvider(provider) || isNvidiaProvider(provider);
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

    // DeepSeek's OpenAI-compatible API accepts assistant.reasoning_content natively.
    if (message.reasoning_content && isDeepSeekProvider(provider)) {
      normalized.reasoning_content = message.reasoning_content;
    } else if (message.reasoning_content && !provider.supportsReasoning) {
      // Only replay reasoning inline for providers that have no dedicated reasoning channel.
      const reasoningText = `<think>\n${message.reasoning_content}\n</think>`;
      if (typeof content === 'string') {
        content = reasoningText + '\n\n' + content;
      } else if (Array.isArray(content)) {
        content = [{ type: 'text', text: reasoningText }, ...content];
      }
    }

    if (strictProvider && message.role === 'assistant' && message.tool_calls?.length && flattenMessageContent(content ?? '').trim().length === 0) {
      normalized.content = '';
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

function isNvidiaProvider(provider: Pick<LLMProvider, 'id' | 'baseUrl'>): boolean {
  return provider.id.startsWith('nvidia/') || provider.baseUrl.includes('api.nvidia.com');
}

function isRetryFriendlyProvider(provider: LLMProvider): boolean {
  return isGoogleProvider(provider) || isNvidiaProvider(provider) || !provider.id.startsWith('local/');
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
/**
 * Parse DeepSeek Markup Language (DSML) tool calls.
 * Handles both standard | and fullwidth ｜ characters.
 */
function parseDsml(dsml: string): { toolCall: LLMToolCall }[] {
  const results: { toolCall: LLMToolCall }[] = [];
  const invokeRegex = /<[|｜]DSML[|｜]invoke\s+name="([^"]+)">([\s\S]*?)<\/[|｜]DSML[|｜]invoke>/gi;
  const paramRegex = /<[|｜]DSML[|｜]parameter\s+name="([^"]+)"\s+string="(true|false)">([\s\S]*?)<\/[|｜]DSML[|｜]parameter>/gi;

  let invokeMatch;
  while ((invokeMatch = invokeRegex.exec(dsml)) !== null) {
    const name = invokeMatch[1];
    const paramsContent = invokeMatch[2];
    const args: Record<string, any> = {};

    let paramMatch;
    while ((paramMatch = paramRegex.exec(paramsContent)) !== null) {
      const paramName = paramMatch[1];
      const isString = paramMatch[2] === 'true';
      const value = paramMatch[3].trim();

      if (isString) {
        args[paramName] = value;
      } else {
        try {
          args[paramName] = JSON.parse(value);
        } catch {
          args[paramName] = value;
        }
      }
    }

    results.push({
      toolCall: {
        id: `call_${Math.random().toString(36).slice(2, 11)}`,
        type: 'function',
        function: {
          name,
          arguments: JSON.stringify(args)
        }
      }
    });
  }
  return results;
}
