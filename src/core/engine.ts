/**
 * LiteClaw - Task-driven agent engine
 *
 * The runtime now treats each user request as a goal run:
 * plan -> execute task by task -> synthesize final response.
 *
 * This keeps the existing one-tool-at-a-time execution primitive,
 * but adds explicit task state so smaller local models stay grounded.
 */

import { EventEmitter } from 'events';
import { ContextManager, estimateTokens } from './context.js';
import { LLMClient, LLMMessage, LLMToolCall, LLMToolDef, shouldUseNativeTools } from './llm.js';
import { MemoryStore } from './memory.js';
import { buildSkillPrompt, LoadedSkill, selectRelevantSkills } from './skills.js';
import {
  TaskItem,
  TaskPlan,
  TaskStatus,
  TaskUpdate,
  createFallbackTaskPlan,
  extractTaggedJson,
  formatTaskPlanForPrompt,
  normalizeTaskPlan,
  stripTaggedBlock,
} from './tasks.js';
import { ConfirmationManager } from './confirmation.js';
import { getConfig, loadSystemPrompt } from '../config.js';
import { createLogger } from '../logger.js';
import { toolRegistry, ToolContext, ToolDefinition, ToolResult } from './tools.js';
import { mcpManager } from './mcp.js';
import { WEBUI_FORMATTING_RULES } from './webui_format.js';

const log = createLogger('engine');

function usesNativeToolPrompt(llm: LLMClient, toolDefs: LLMToolDef[]): boolean {
  if (toolDefs.length === 0) return false;
  const provider = llm.getProviders()[0];
  if (!provider) return false;
  return shouldUseNativeTools(provider, toolDefs);
}

function buildToolUseInstructions(nativeToolsEnabled: boolean, includeTaskUpdate: boolean): string {
  const fileHandling = `FILE HANDLING:
- When modifying existing files, PREFER the "edit_file" tool over "write_file".
- Use "read_file" with "lineNumbers: true" for precise matching.
- DO NOT try to read binary files (e.g., .docx, .pdf, .zip, images). If you need to "see" them, ask the user to describe them or use specialized tools if available.`;

  if (nativeToolsEnabled) {
    const executionRules = includeTaskUpdate
      ? `CRITICAL: In every turn, you MUST emit either a native tool call or a <task_update>.
NEVER output plain text outside of structural tags when a <task_update> is required.
If you have the final answer for the user, you MUST put it in the "userFacing" field of a <task_update> block.

If the current task is complete, blocked, or failed, emit exactly:
<task_update>
{"status":"completed|blocked|failed","summary":"what happened","artifacts":[],"userFacing":"Put your final response to the user here","needsReplan":false}
</task_update>

If you need more tools to reach the objective, call a tool with the provider's native function-calling interface.
Do NOT emit <tool_call> XML or raw tool-call JSON in normal text.`
      : `To use a tool, call it with the provider's native function-calling interface.
Do NOT emit <tool_call> XML or raw tool-call JSON in normal text.

After a tool call, you will receive the tool result in the conversation. Use only ONE tool at a time.`;

    return `${executionRules}

${fileHandling}

AUTONOMOUS PLANNING: If the task is complex and requires a multi-step structured plan, emit <request_plan reason="brief reason" /> to switch to planning mode.`;
  }

  const executionRules = includeTaskUpdate
    ? `CRITICAL: In every turn, you MUST emit either a <tool_call> or a <task_update>.
NEVER output plain text outside of structural tags. If you have the final answer for the user, you MUST put it in the "userFacing" field of a <task_update> block.

If the current task is complete, blocked, or failed, emit exactly:
<task_update>
{"status":"completed|blocked|failed","summary":"what happened","artifacts":[],"userFacing":"Put your final response to the user here","needsReplan":false}
</task_update>

If you need more tools to reach the objective, emit a <tool_call> block.`
    : `To use a tool, output exactly this xml format:
<tool_call>
{"name": "tool_name", "arguments": {"param1": "value"}}
</tool_call>

CRITICAL: Always put your multi-step reasoning inside <think> tags before calling a tool. In the final response (outside tags), do NOT narrate your plan. No "I will now check...", no "I need to...". Emit the <tool_call> block immediately after your thoughts. Any text outside of <think> or <tool_call> tags while a tool is being used is forbidden.

After emitting a tool call, you will receive a <tool_result> message. Use only ONE tool at a time.`;

  return `${executionRules}

${fileHandling}

AUTONOMOUS PLANNING: If the task is complex and requires a multi-step structured plan, emit <request_plan reason="brief reason" /> to switch to planning mode.`;
}

export interface AgentAttachment {
  name: string;
  dataUrl: string;
}

export interface AgentRequest {
  message: string;
  images?: string[];
  attachments?: AgentAttachment[];
  sessionKey: string;
  disablePlanner?: boolean;
  disableReasoning?: boolean;
  channelType: 'webui' | 'discord' | 'whatsapp' | 'cli';
  channelTarget?: string;
  userIdentifier?: string;
  workingDir?: string;
  sendFile?: (filePath: string, fileName?: string) => Promise<void>;
  sendInteractiveChoice?: (request: import('./tools.js').InteractiveChoiceRequest) => Promise<string>;
  /** Override the system prompt entirely (e.g., for DnD GM mode) */
  systemPromptOverride?: string;
}

export interface MessageMetrics {
  tokens: number;
  durationMs: number;
  tokPerSec: number;
}

export interface AgentStreamEvent {
  type: 'thinking' | 'content' | 'tool_start' | 'tool_result' | 'confirmation' | 'plan' | 'task_update' | 'done' | 'error' | 'switch_to_plan';
  content?: string;
  toolName?: string;
  toolArgs?: Record<string, any>;
  toolResult?: ToolResult;
  confirmationId?: string;
  error?: string;
  metrics?: MessageMetrics;
  plan?: TaskPlan;
  taskId?: string;
  taskTitle?: string;
  taskStatus?: TaskStatus;
  taskIndex?: number;
  taskTotal?: number;
  taskSummary?: string;
}

interface PreparedRequestContext {
  systemPrompt: string;
  history: LLMMessage[];
  activeSkills: LoadedSkill[];
  selectedTools: ToolDefinition[];
  toolDefs: LLMToolDef[];
  toolGuidance: string;
}

interface ReplanResult {
  summary: string;
  tasks: TaskItem[];
  tokens: number;
  thinking: string;
}

interface TaskRunOutcome {
  status: Extract<TaskStatus, 'completed' | 'blocked' | 'failed'>;
  summary: string;
  artifacts: string[];
  userFacing?: string;
  needsReplan?: boolean;
  tokens: number;
  thinking: string;
}

type InternalPlanEvent =
  | AgentStreamEvent
  | { type: 'plan_result'; plan: TaskPlan; tokens: number; thinking: string };

type InternalTaskEvent =
  | AgentStreamEvent
  | ({ type: 'task_result'; } & TaskRunOutcome);

type InternalFinalEvent =
  | AgentStreamEvent
  | { type: 'final_result'; content: string };

type InternalReplanEvent =
  | AgentStreamEvent
  | { type: 'replan_result'; result: ReplanResult | null };

type InternalDirectEvent =
  | AgentStreamEvent
  | { type: 'final_result'; content: string }
  | { type: 'switch_to_plan'; plan?: TaskPlan };

export class AgentEngine extends EventEmitter {
  private llm: LLMClient;
  private context: ContextManager;
  private memory: MemoryStore;
  private confirmations: ConfirmationManager;
  private sessionLocks = new Map<string, Promise<void>>();

  constructor(
    llm: LLMClient,
    memory: MemoryStore,
    confirmations: ConfirmationManager,
  ) {
    super();
    this.llm = llm;
    this.context = new ContextManager(llm);
    this.memory = memory;
    this.confirmations = confirmations;
  }

  getLLMClient(): LLMClient {
    return this.llm;
  }

  getMemory(): MemoryStore {
    return this.memory;
  }

  private async acquireLock(sessionKey: string): Promise<() => void> {
    const currentLock = this.sessionLocks.get(sessionKey) || Promise.resolve();
    let release!: () => void;
    const nextLock = new Promise<void>(resolve => {
      release = resolve;
    });
    this.sessionLocks.set(sessionKey, currentLock.then(() => nextLock));
    log.debug({ sessionKey }, 'Attempting to acquire session lock');
    await currentLock;
    log.debug({ sessionKey }, 'Session lock acquired');
    return release;
  }

  async *processRequest(request: AgentRequest): AsyncGenerator<AgentStreamEvent> {
    const release = await this.acquireLock(request.sessionKey);
    try {
      yield* this._processRequest(request);
    } finally {
      log.debug({ sessionKey: request.sessionKey }, 'Releasing session lock');
      release();
    }
  }

  saveMessageSilent(request: AgentRequest): void {
    this.memory.saveMessage({
      sessionKey: request.sessionKey,
      role: 'user',
      content: request.message,
      timestamp: Date.now(),
      metadata: buildRequestMetadata(request),
    });
  }

  private async *_processRequest(request: AgentRequest): AsyncGenerator<AgentStreamEvent> {
    const startTime = Date.now();
    let totalTokens = 0;
    let allThinkingContent = '';
    const plannerConfig = getConfig().agent?.planner;
    const plannerEnabled = plannerConfig?.enabled !== false;
    const plannerMode = plannerConfig?.mode ?? 'auto';
    const maxReplans = getConfig().agent?.planner?.maxReplans ?? 2;

    const prepared = await this.prepareRequestContext(request);
    const usePlanner = !request.disablePlanner && plannerEnabled && (
      plannerMode === 'always' ||
      (plannerMode !== 'off' && shouldUseTaskPlanner(request.message, prepared.selectedTools))
    );

    if (!usePlanner) {
      let switchedToPlan = false;
      for await (const event of this.runAndSaveDirectConversation(request, prepared, startTime, totalTokens, allThinkingContent)) {
        if (event.type === 'switch_to_plan') {
          switchedToPlan = true;
          log.info({ session: request.sessionKey }, 'Model requested plan autonomously');
          break;
        }
        yield event;
      }

      if (!switchedToPlan) return;
    }

    let plan: TaskPlan | null = null;
    if (plannerEnabled) {
      for await (const event of this.generateTaskPlan(request, prepared)) {
        if (event.type === 'plan_result') {
          totalTokens += event.tokens;
          allThinkingContent += event.thinking;
          plan = event.plan;
          continue;
        }
        yield event;
      }
    }

    if (!plan || plan.tasks.length === 0) {
      // If the planner explicitly returned no tasks, or failed to return a plan,
      // and we don't want a fallback, switch to direct conversation.
      if (plan && plan.tasks.length === 0) {
        for await (const event of this.runAndSaveDirectConversation(request, prepared, startTime, totalTokens, allThinkingContent)) {
          yield event;
        }
        return;
      }

      plan = createFallbackTaskPlan(
        request.message,
        prepared.selectedTools.map(tool => tool.name),
        prepared.activeSkills.map(skill => skill.name),
      );
    }

    plan.status = 'in_progress';
    plan.updatedAt = Date.now();
    this.memory.saveTaskPlan(request.sessionKey, plan);
    yield { type: 'plan', plan };

    let failure: { task: TaskItem; summary: string } | null = null;
    const taskHints: string[] = [];
    let replanCount = 0;

    for (let index = 0; index < plan.tasks.length;) {
      const task = plan.tasks[index];
      task.status = 'in_progress';
      task.attempts += 1;
      plan.currentTaskId = task.id;
      plan.updatedAt = Date.now();
      this.memory.saveTaskPlan(request.sessionKey, plan);

      yield {
        type: 'task_update',
        plan,
        taskId: task.id,
        taskTitle: task.title,
        taskStatus: task.status,
        taskIndex: index + 1,
        taskTotal: plan.tasks.length,
      };

      let outcome: TaskRunOutcome | null = null;
      for await (const event of this.executeTask(request, prepared, plan, task, index)) {
        if (event.type === 'task_result') {
          totalTokens += event.tokens;
          allThinkingContent += event.thinking;
          outcome = event;
          continue;
        }
        yield event;
      }

      if (!outcome) {
        outcome = {
          status: 'failed',
          summary: `Task "${task.title}" ended unexpectedly.`,
          artifacts: [],
          tokens: 0,
          thinking: '',
        };
      }

      task.status = outcome.status;
      task.summary = outcome.summary;
      task.artifacts = outcome.artifacts;
      plan.updatedAt = Date.now();
      this.memory.saveTaskPlan(request.sessionKey, plan);

      yield {
        type: 'task_update',
        plan,
        taskId: task.id,
        taskTitle: task.title,
        taskStatus: task.status,
        taskIndex: index + 1,
        taskTotal: plan.tasks.length,
        taskSummary: task.summary,
      };

      if (outcome.userFacing?.trim()) {
        taskHints.push(outcome.userFacing.trim());
      }

      if (outcome.status !== 'completed') {
        const shouldReplan = plannerEnabled && replanCount < maxReplans && outcome.needsReplan !== false;
        if (shouldReplan) {
          let replan: ReplanResult | null = null;
          for await (const event of this.replanRemainingTasks(request, prepared, plan, task, outcome, index)) {
            if (event.type === 'replan_result') {
              if (event.result) {
                totalTokens += event.result.tokens;
                allThinkingContent += event.result.thinking;
              }
              replan = event.result;
              continue;
            }
            yield event;
          }

          if (replan && replan.tasks.length > 0) {
            replanCount++;
            const priorTasks = plan.tasks.slice(0, index + 1);
            plan.tasks = [
              ...priorTasks,
              ...replan.tasks.map((nextTask, offset) => ({
                ...nextTask,
                id: normalizeTaskId(nextTask.id, priorTasks.length + offset + 1),
              })),
            ];
            plan.summary = replan.summary || plan.summary;
            plan.updatedAt = Date.now();
            this.memory.saveTaskPlan(request.sessionKey, plan);
            yield { type: 'plan', plan };
            index++;
            continue;
          }
        }

        failure = { task, summary: outcome.summary };
        break;
      }

      index++;
    }

    plan.currentTaskId = undefined;
    plan.status = failure ? 'failed' : 'completed';
    plan.updatedAt = Date.now();
    this.memory.saveTaskPlan(request.sessionKey, plan);

    let finalResponse = '';
    let streamedFinalContent = false;
    for await (const event of this.generateFinalResponse(request, prepared, plan, failure, taskHints)) {
      if (event.type === 'final_result') {
        finalResponse = event.content;
        continue;
      }

      if (event.type === 'thinking' && event.content) {
        totalTokens += estimateTokens(event.content);
        allThinkingContent += event.content;
      } else if (event.type === 'content' && event.content) {
        totalTokens += estimateTokens(event.content);
        streamedFinalContent = true;
      }
      yield event;
    }

    if (finalResponse.trim() && !streamedFinalContent) {
      totalTokens += estimateTokens(finalResponse);
      yield { type: 'content', content: finalResponse };
    }

    const contentToSave = allThinkingContent
      ? `<think>${allThinkingContent}</think>\n\n${finalResponse}`
      : finalResponse;

    this.memory.saveMessage({
      sessionKey: request.sessionKey,
      role: 'assistant',
      content: finalResponse,
      reasoningContent: allThinkingContent || undefined,
      timestamp: Date.now(),
    });

    const durationMs = Date.now() - startTime;
    const tokPerSec = durationMs > 0 ? totalTokens / (durationMs / 1000) : 0;

    yield {
      type: 'done',
      metrics: {
        tokens: totalTokens,
        durationMs,
        tokPerSec,
      },
    };
  }

  private async prepareRequestContext(request: AgentRequest): Promise<PreparedRequestContext> {
    const config = getConfig();
    let systemPrompt = request.systemPromptOverride ?? loadSystemPrompt();

    // Inject WebUI-specific formatting rules if the request is coming from the WebUI
    if (request.channelType === 'webui') {
      systemPrompt += `\n\n${WEBUI_FORMATTING_RULES}`;
    }

    const mcpInstructions = mcpManager.getPromptAppendix();
    if (mcpInstructions) {
      systemPrompt += `\n\n# MCP Integrations\n${mcpInstructions}`;
    }

    const activeSkills = config.agent?.skills?.enabled === false
      ? []
      : selectRelevantSkills(request.message, config.agent?.skills?.maxInjected);

    const userMessage = this.buildUserMessage(request);
    const historyLimit = config.agent?.historyMessageLimit ?? 30;
    const rawHistory = this.memory.getHistory(request.sessionKey, historyLimit);
    let history: LLMMessage[] = rawHistory.map(entry => {
      const message: LLMMessage = {
        role: entry.role as 'user' | 'assistant',
        content: entry.content,
      };

      if (entry.reasoningContent) {
        message.reasoning_content = entry.reasoningContent;
      }

      if (entry.role === 'user' && entry.metadata) {
        try {
          const meta = JSON.parse(entry.metadata);
          // Restore images if they exist in metadata
          if (meta.attachments || meta.images) {
            const atts = meta.attachments || meta.images;
            const content: any[] = [{ type: 'text', text: entry.content }];
            for (const att of atts) {
              const url = typeof att === 'string' ? att : att.dataUrl;
              if (url.startsWith('data:image/')) {
                content.push({
                  type: 'image_url',
                  image_url: { url, detail: 'auto' },
                });
              }
            }
            message.content = content;
          }
        } catch (e) {
          log.warn({ id: entry.id }, 'Failed to parse message metadata during history restoration');
        }
      }

      return message;
    });

    if (this.context.shouldCompact(history)) {
      log.info({ session: request.sessionKey }, 'Triggering context compaction');
      const { summary, remaining } = await this.context.compactHistory(history);
      history = remaining;
      if (summary.content) {
        history.unshift(summary);
        this.memory.saveSummary(
          request.sessionKey,
          typeof summary.content === 'string' ? summary.content : '',
          rawHistory.length - remaining.length,
        );
      }
    }

    history.push(userMessage);

    this.memory.saveMessage({
      sessionKey: request.sessionKey,
      role: 'user',
      content: request.message,
      timestamp: Date.now(),
      metadata: buildRequestMetadata(request),
    });

    const toolLoading = config.agent?.toolLoading ?? 'lazy';
    const allTools = toolRegistry.getAll();
    const selectedTools = toolLoading === 'lazy'
      ? toolRegistry.selectRelevant(request.message, 12)
      : allTools;
    const toolDefs = toolRegistry.toLLMToolDefs(selectedTools);
    const toolGuidance = toolRegistry.buildToolGuidance(selectedTools, request.message);

    const systemTokens = estimateTokens(systemPrompt);
    const toolTokens = estimateTokens(JSON.stringify(toolDefs));
    history = this.context.trimHistory(history, systemTokens, toolTokens);

    return {
      systemPrompt,
      history,
      activeSkills,
      selectedTools,
      toolDefs,
      toolGuidance,
    };
  }

  private async *runAndSaveDirectConversation(
    request: AgentRequest,
    prepared: PreparedRequestContext,
    startTime: number,
    totalTokens: number,
    allThinkingContent: string,
  ): AsyncGenerator<AgentStreamEvent> {
    let finalResponse = '';
    let streamedContent = false;
    for await (const event of this.runDirectConversation(request, prepared)) {
      if (event.type === 'final_result') {
        finalResponse = event.content;
        continue;
      }

      if (event.type === 'thinking' && event.content) {
        totalTokens += estimateTokens(event.content);
        allThinkingContent += event.content;
      } else if (event.type === 'content' && event.content) {
        totalTokens += estimateTokens(event.content);
        streamedContent = true;
      }
      yield event;
    }

    if (finalResponse.trim() && !streamedContent) {
      totalTokens += estimateTokens(finalResponse);
      yield { type: 'content', content: finalResponse };
    }

    const contentToSave = allThinkingContent
      ? `<think>${allThinkingContent}</think>\n\n${finalResponse}`
      : finalResponse;

    this.memory.saveMessage({
      sessionKey: request.sessionKey,
      role: 'assistant',
      content: finalResponse,
      reasoningContent: allThinkingContent || undefined,
      timestamp: Date.now(),
    });

    const durationMs = Date.now() - startTime;
    const tokPerSec = durationMs > 0 ? totalTokens / (durationMs / 1000) : 0;

    yield {
      type: 'done',
      metrics: {
        tokens: totalTokens,
        durationMs,
        tokPerSec,
      },
    };
  }

  private async *runDirectConversation(
    request: AgentRequest,
    prepared: PreparedRequestContext,
  ): AsyncGenerator<InternalFinalEvent> {
    const config = getConfig();
    const maxIterations = config.agent?.maxTurns ?? 20;
    const skillPrompt = buildSkillPrompt(prepared.activeSkills);
    const toolDefs = [...prepared.toolDefs];
    const nativeToolsEnabled = usesNativeToolPrompt(this.llm, toolDefs);

    let systemPrompt = prepared.systemPrompt;
    if (skillPrompt) {
      systemPrompt += `\n\n---\n\n${skillPrompt}`;
    }
    if (toolDefs.length > 0) {
      if (!nativeToolsEnabled) {
        systemPrompt += `\n\n# Available Tools\nYou have access to the following tools:\n<tools>\n`;
        systemPrompt += JSON.stringify(toolDefs, null, 2);
        systemPrompt += `\n</tools>`;
      } else {
        systemPrompt += `\n\n# Tools\nThe runtime has attached tool schemas through the provider's native function-calling interface.`;
      }
      if (prepared.toolGuidance) {
        systemPrompt += `\n\n${prepared.toolGuidance}`;
      }
      systemPrompt += `\n\n${buildToolUseInstructions(nativeToolsEnabled, false)}`;
    }

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...prepared.history,
    ];

    let iterations = 0;
    let repairAttempts = 0;
    let consecutiveFailures = 0;
    let fullResponse = '';
    const toolCallHistory = new Set<string>();

    while (iterations < maxIterations) {
      iterations++;

      let assistantContent = '';
      let thinkingContent = '';
      const toolCalls: LLMToolCall[] = [];

      const llmDefaults = config.llm?.defaults;
      for await (const chunk of this.llm.streamChat(messages, toolDefs, {
        temperature: llmDefaults?.temperature,
        topP: llmDefaults?.topP,
        topK: llmDefaults?.topK,
        maxTokens: llmDefaults?.maxOutputTokens,
        disableReasoning: request.disableReasoning
      })) {
        if (chunk.type === 'thinking' && chunk.content) {
          thinkingContent += chunk.content;
          yield { type: 'thinking', content: chunk.content };
        } else if (chunk.type === 'content' && chunk.content) {
          assistantContent += chunk.content;
        } else if (chunk.type === 'tool_call' && chunk.toolCall) {
          toolCalls.push(chunk.toolCall);
        } else if (chunk.type === 'error') {
          yield { type: 'error', error: chunk.error };
          return;
        }
      }

      const requestPlanMatch = assistantContent.match(/([\s\S]*?)<request_plan\b[\s\S]*?\/>/i);
      if (requestPlanMatch) {
        const preamble = requestPlanMatch[1]?.trim() ?? '';
        if (preamble) {
          yield {
            type: isLikelyHiddenReasoning(preamble) ? 'thinking' : 'content',
            content: preamble,
          };
        }
        yield { type: 'switch_to_plan' };
        return;
      }

      if (toolCalls.length === 0) {
        const recovered = extractEmbeddedToolCalls([assistantContent, thinkingContent], toolDefs);
        if (recovered.length > 0) {
          toolCalls.push(...recovered);
          assistantContent = stripEmbeddedToolCalls(assistantContent);
        }
      }

      if (toolCalls.length === 0) {
        const inferred = inferSafeToolCall(thinkingContent, request.message, toolDefs);
        if (inferred) toolCalls.push(inferred);
      }

      if (toolCalls.length > 0 && assistantContent.trim()) {
        const visible = stripEmbeddedToolCalls(assistantContent).trim();
        if (visible) {
          yield {
            type: isLikelyHiddenReasoning(visible) ? 'thinking' : 'content',
            content: visible,
          };
          if (isLikelyHiddenReasoning(visible)) {
            thinkingContent += `\n${visible}`;
          }
          assistantContent = '';
        }
      }

      if (toolCalls.length === 0) {
        if (assistantContent.trim() && isLikelyHiddenReasoning(assistantContent)) {
          thinkingContent += `${thinkingContent ? '\n' : ''}${assistantContent.trim()}`;
          assistantContent = '';
        }

        if (!assistantContent.trim() && thinkingContent.trim()) {
          if (repairAttempts < 2) {
            repairAttempts++;
            const previousThoughts = thinkingContent.trim();
            messages.push({
              role: 'user',
              content: `[SYSTEM REPAIR: Your previous attempt stalled after planning. Use your previous thoughts to recover and provide the final answer or tool call immediately:\n"${previousThoughts}"]`,
            });
            continue;
          }

          yield { type: 'error', error: 'Model reached stagnation after multiple planning attempts without action.' };
          yield { type: 'final_result', content: assistantContent };
          return;
        }

        if (assistantContent.trim()) {
          yield { type: 'content', content: assistantContent };
        }
        fullResponse = assistantContent;
        break;
      }

      repairAttempts = 0;

      const deduped: LLMToolCall[] = [];
      for (const tc of toolCalls) {
        const sig = `${tc.function.name}:${tc.function.arguments}:${JSON.stringify(tc.extra_content ?? {})}`;
        if (toolCallHistory.has(sig)) continue;
        toolCallHistory.add(sig);
        deduped.push(tc);
      }

      if (deduped.length === 0) {
        fullResponse = assistantContent;
        break;
      }

      if (assistantContent.trim().length > 500 && iterations > 2) {
        fullResponse = assistantContent;
        break;
      }

      messages.push({
        role: 'assistant',
        content: assistantContent || '',
        tool_calls: deduped,
      });

      let iterationFailures = 0;
      for (const tc of deduped) {
        yield {
          type: 'tool_start',
          toolName: tc.function.name,
          toolArgs: safeParseJSON(tc.function.arguments),
        };

        const toolContext: ToolContext = {
          channelType: request.channelType,
          channelTarget: request.channelTarget,
          workingDir: request.workingDir ?? process.cwd(),
          sendFile: request.sendFile,
          sendInteractiveChoice: request.sendInteractiveChoice,
          requestConfirmation: async (description: string) => {
            return this.confirmations.requestConfirmation(
              tc.function.name,
              description,
              request.channelType,
              request.channelTarget,
            );
          },
        };

        const result = await toolRegistry.execute(tc, toolContext);
        yield { type: 'tool_result', toolName: tc.function.name, toolResult: result };

        if (!result.success) iterationFailures++;

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: formatToolResultForModel(tc.function.name, result),
        });
      }

      if (iterationFailures === deduped.length) {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          messages.push({
            role: 'user',
            content: '[SYSTEM: All recent tool attempts have failed. Do NOT call any more tools. Provide your best answer directly based on what you already know.]',
          });
          toolDefs.length = 0;
          continue;
        }
      } else {
        consecutiveFailures = 0;
      }

      const historyPortion = messages.slice(1);
      const trimmed = this.context.trimHistory(
        historyPortion,
        estimateTokens(prepared.systemPrompt),
        estimateTokens(JSON.stringify(toolDefs)),
      );
      messages.length = 1;
      messages.push(...trimmed);
    }

    // Only emit a fallback message if no meaningful interaction occurred.
    // If tool calls were executed, the user already saw the results — no need for a redundant summary.
    if (!fullResponse.trim() && toolCallHistory.size === 0) {
      fullResponse = "I'm not sure how to respond to that. Could you please provide more details?";
    }

    yield { type: 'final_result', content: fullResponse };
  }

  private async *generateTaskPlan(
    request: AgentRequest,
    prepared: PreparedRequestContext,
  ): AsyncGenerator<InternalPlanEvent> {
    const skillNames = prepared.activeSkills.map(skill => skill.name);
    const toolNames = prepared.selectedTools.map(tool => tool.name);

    const plannerPrompt = [
      prepared.systemPrompt,
      '# Internal Planner',
      'You are planning an internal task list for an autonomous agent runtime.',
      'This model is expected to reason with <think> tags and work well in structured agent stacks.',
      'Return ONLY a <task_plan> JSON block.',
      'Do not narrate. Do not answer the user directly.',
      'Each task must be semantic, not a raw tool call.',
      'Good task titles: "Inspect the document", "Apply the requested edits", "Deliver the result".',
      'Bad task titles: "call read_file", "use write_file".',
      'Keep the plan concise, sequential, and executable.',
      'Include suggestedTools only when genuinely useful and only from the available tools list.',
      'Include relevantSkills only when genuinely useful and only from the available skills list.',
      'CRITICAL: If the user request is purely conversational, a simple greeting, informational, or does not require a multi-step plan (e.g., just a quick question that can be answered directly), return a plan with an EMPTY tasks list: {"summary":"Conversational response needed","tasks":[]}.',
      '',
      `Available tools: ${toolNames.join(', ') || 'none'}`,
      `Available skills: ${skillNames.join(', ') || 'none'}`,
      '',
      'Schema:',
      '<task_plan>',
      '{"summary":"string","tasks":[{"id":"task_1","title":"string","objective":"string","acceptance":"string","suggestedTools":["tool_name"],"relevantSkills":["skill_name"]}]}',
      '</task_plan>',
    ].join('\n');

    const messages: LLMMessage[] = [
      { role: 'system', content: plannerPrompt },
      ...prepared.history,
    ];

    let assistantContent = '';
    let thinkingContent = '';
    let tokens = 0;

    const llmDefaults = getConfig().llm?.defaults;
    for await (const chunk of this.llm.streamChat(messages, undefined, {
      temperature: 0.2, // Planner remains low temp for structure
      topP: llmDefaults?.topP,
      topK: llmDefaults?.topK,
      maxTokens: 1200
    })) {
      if (chunk.type === 'thinking' && chunk.content) {
        thinkingContent += chunk.content;
        tokens += estimateTokens(chunk.content);
        yield { type: 'thinking', content: chunk.content };
      } else if (chunk.type === 'content' && chunk.content) {
        assistantContent += chunk.content;
        tokens += estimateTokens(chunk.content);
      } else if (chunk.type === 'error') {
        yield { type: 'error', error: chunk.error ?? 'Planner error.' };
        break;
      }
    }

    const parsed = extractTaggedJson<Record<string, unknown>>(
      [assistantContent, thinkingContent],
      'task_plan',
    );

    const plan = parsed
      ? normalizeTaskPlan(parsed, request.message, toolNames, skillNames)
      : createFallbackTaskPlan(request.message, toolNames, skillNames);

    yield { type: 'plan_result', plan, tokens, thinking: thinkingContent };
  }

  private async *executeTask(
    request: AgentRequest,
    prepared: PreparedRequestContext,
    plan: TaskPlan,
    task: TaskItem,
    taskIndex: number,
  ): AsyncGenerator<InternalTaskEvent> {
    const config = getConfig();
    const maxIterations = config.agent?.maxTurns ?? 20;
    const relevantSkills = this.resolveTaskSkills(prepared, task, request.message);
    const skillPrompt = buildSkillPrompt(relevantSkills);
    const selectedTools = this.resolveTaskTools(prepared, task, request.message);
    const toolDefs = toolRegistry.toLLMToolDefs(selectedTools);
    const toolGuidance = toolRegistry.buildToolGuidance(selectedTools, `${request.message}\n${task.title}\n${task.objective}`);
    const nativeToolsEnabled = usesNativeToolPrompt(this.llm, toolDefs);

    let systemPrompt = prepared.systemPrompt;
    if (skillPrompt) {
      systemPrompt += `\n\n---\n\n${skillPrompt}`;
    }
    if (toolDefs.length > 0) {
      if (!nativeToolsEnabled) {
        systemPrompt += `\n\n# Available Tools\nYou have access to the following tools:\n<tools>\n`;
        systemPrompt += JSON.stringify(toolDefs, null, 2);
        systemPrompt += `\n</tools>`;
      } else {
        systemPrompt += `\n\n# Tools\nThe runtime has attached tool schemas through the provider's native function-calling interface.`;
      }
      if (toolGuidance) {
        systemPrompt += `\n\n${toolGuidance}`;
      }
    }

    systemPrompt += `\n\n# Task Execution Rules
You are executing one task inside an internal task plan.
Stay focused on the current task only.
Use one tool at a time when needed.
Do not answer the user directly during task execution.

${buildToolUseInstructions(nativeToolsEnabled, true)}
Do not expose the internal plan outside tags.`;

    const completedTaskSummaries = plan.tasks
      .slice(0, taskIndex)
      .filter(item => item.summary)
      .map(item => `- ${item.title}: ${item.summary}`)
      .join('\n');

    const taskContextMessage = [
      '[TASK CONTEXT]',
      `Goal: ${plan.goal}`,
      `Plan summary: ${plan.summary}`,
      `Current task (${taskIndex + 1}/${plan.tasks.length}): ${task.title}`,
      `Objective: ${task.objective}`,
      `Acceptance: ${task.acceptance}`,
      `Suggested tools: ${task.suggestedTools.join(', ') || 'none'}`,
      `Relevant skills: ${task.relevantSkills.join(', ') || 'none'}`,
      completedTaskSummaries
        ? `Completed tasks so far:\n${completedTaskSummaries}`
        : 'Completed tasks so far:\n- none',
    ].join('\n');

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...prepared.history,
      { role: 'user', content: taskContextMessage },
    ];

    let iterations = 0;
    let repairAttempts = 0;
    let consecutiveFailures = 0;
    let tokens = 0;
    let allThinking = '';
    const artifacts = new Set<string>();
    const toolCallHistory = new Set<string>();

    log.info({ taskId: task.id, title: task.title }, 'Starting task execution');

    while (iterations < maxIterations) {
      iterations++;
      log.debug({ taskId: task.id, iteration: iterations }, 'Task iteration start');

      let assistantContent = '';
      let thinkingContent = '';
      const toolCalls: LLMToolCall[] = [];

      const llmDefaults = getConfig().llm?.defaults;
      for await (const chunk of this.llm.streamChat(messages, toolDefs, {
        temperature: llmDefaults?.temperature,
        topP: llmDefaults?.topP,
        topK: llmDefaults?.topK,
        maxTokens: llmDefaults?.maxOutputTokens,
        disableReasoning: request.disableReasoning
      })) {
        if (chunk.type === 'thinking' && chunk.content) {
          thinkingContent += chunk.content;
          allThinking += chunk.content;
          tokens += estimateTokens(chunk.content);
          yield { type: 'thinking', content: chunk.content };
        } else if (chunk.type === 'content' && chunk.content) {
          assistantContent += chunk.content;
          tokens += estimateTokens(chunk.content);
        } else if (chunk.type === 'tool_call' && chunk.toolCall) {
          toolCalls.push(chunk.toolCall);
        } else if (chunk.type === 'error') {
          yield { type: 'error', error: chunk.error };
          yield {
            type: 'task_result',
            status: 'failed',
            summary: chunk.error ?? 'Task execution failed.',
            artifacts: Array.from(artifacts),
            tokens,
            thinking: allThinking,
          };
          return;
        }
      }

      log.debug({
        iteration: iterations,
        assistantLength: assistantContent.length,
        thinkingLength: thinkingContent.length,
        assistantTail: assistantContent.slice(-100),
        hasTaskUpdate: assistantContent.includes('<task_update>') || thinkingContent.includes('<task_update>'),
        hasToolCall: assistantContent.includes('<tool_call>')
      }, 'Task iteration complete');

      const taskUpdate = extractTaggedJson<TaskUpdate>([assistantContent, thinkingContent], 'task_update');
      assistantContent = stripTaggedBlock(assistantContent, 'task_update');

      if (toolCalls.length === 0) {
        const recovered = extractEmbeddedToolCalls([assistantContent, thinkingContent], toolDefs);
        if (recovered.length > 0) {
          toolCalls.push(...recovered);
          assistantContent = stripEmbeddedToolCalls(assistantContent);
        }
      }

      if (toolCalls.length === 0) {
        const inferred = inferSafeToolCall(thinkingContent, `${request.message}\n${task.objective}`, toolDefs);
        if (inferred) {
          toolCalls.push(inferred);
        }
      }

      if (toolCalls.length === 0) {
        if (taskUpdate?.status) {
          yield {
            type: 'task_result',
            status: taskUpdate.status,
            summary: taskUpdate.summary || `${task.title} ${taskUpdate.status}.`,
            artifacts: [
              ...Array.from(artifacts),
              ...(Array.isArray(taskUpdate.artifacts) ? taskUpdate.artifacts.filter(Boolean) : []),
            ],
            userFacing: taskUpdate.userFacing,
            needsReplan: taskUpdate.needsReplan,
            tokens,
            thinking: allThinking,
          };
          return;
        }

        if (repairAttempts < 2) {
          repairAttempts++;
          const recoveryNudge = assistantContent.trim()
            ? '[SYSTEM REPAIR: You must wrap your answer in a <task_update> block. Plain text outside tags is forbidden. Emit <task_update> with "status":"completed" and your answer in "userFacing".]'
            : '[SYSTEM REPAIR: You stopped without a tool call or <task_update>. Use the information above to either call another tool or finish the task with a <task_update> block.]';
          messages.push({ role: 'user', content: recoveryNudge });
          continue;
        }

        yield {
          type: 'task_result',
          status: 'failed',
          summary: `The agent could not complete task "${task.title}" because it stopped without a valid tool call or task update.`,
          artifacts: Array.from(artifacts),
          tokens,
          thinking: allThinking,
        };
        return;
      }

      repairAttempts = 0;

      const deduped: LLMToolCall[] = [];
      for (const call of toolCalls) {
        const signature = `${call.function.name}:${call.function.arguments}:${JSON.stringify(call.extra_content ?? {})}`;
        if (toolCallHistory.has(signature)) continue;
        toolCallHistory.add(signature);
        deduped.push(call);
      }

      if (deduped.length === 0) {
        messages.push({
          role: 'user',
          content: '[SYSTEM: You repeated the same tool call. Pick a different next action or emit <task_update> with blocked/failed.]',
        });
        continue;
      }

      messages.push({
        role: 'assistant',
        content: assistantContent || '',
        tool_calls: deduped,
      });

      let iterationFailures = 0;
      for (const call of deduped) {
        yield {
          type: 'tool_start',
          toolName: call.function.name,
          toolArgs: safeParseJSON(call.function.arguments),
        };

        const toolContext: ToolContext = {
          channelType: request.channelType,
          channelTarget: request.channelTarget,
          workingDir: request.workingDir ?? process.cwd(),
          sendFile: request.sendFile,
          sendInteractiveChoice: request.sendInteractiveChoice,
          requestConfirmation: async (description: string) => {
            return this.confirmations.requestConfirmation(
              call.function.name,
              description,
              request.channelType,
              request.channelTarget,
            );
          },
        };

        const result = await toolRegistry.execute(call, toolContext);
        if (result.filePath) artifacts.add(result.filePath);
        if (!result.success) iterationFailures++;

        yield {
          type: 'tool_result',
          toolName: call.function.name,
          toolResult: result,
        };

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: formatToolResultForModel(call.function.name, result),
        });
      }

      if (iterationFailures === deduped.length) {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          messages.push({
            role: 'user',
            content: '[SYSTEM: Multiple tool attempts failed. Stop retrying blindly. Either choose a new strategy or emit <task_update> with blocked or failed.]',
          });
        }
      } else {
        consecutiveFailures = 0;
      }

      const historyPortion = messages.slice(1);
      const trimmed = this.context.trimHistory(
        historyPortion,
        estimateTokens(systemPrompt),
        estimateTokens(JSON.stringify(toolDefs)),
      );
      messages.length = 1;
      messages.push(...trimmed);
    }

    yield {
      type: 'task_result',
      status: 'failed',
      summary: `Task "${task.title}" reached the maximum iteration limit.`,
      artifacts: Array.from(artifacts),
      tokens,
      thinking: allThinking,
    };
    return;
  }

  private async *generateFinalResponse(
    request: AgentRequest,
    prepared: PreparedRequestContext,
    plan: TaskPlan,
    failure: { task: TaskItem; summary: string } | null,
    taskHints: string[],
  ): AsyncGenerator<InternalFinalEvent> {
    const outcomeLines = plan.tasks.map((task, index) => (
      `${index + 1}. ${task.title} [${task.status}]${task.summary ? ` - ${task.summary}` : ''}`
    ));

    const prompt = [
      prepared.systemPrompt,
      '# Final Response',
      'Write the final user-facing reply after the internal task run.',
      'Do not mention internal task IDs, internal planning, or hidden reasoning.',
      'Be concise and direct.',
      'If a file was sent, say so plainly.',
      failure
        ? 'The run did not fully complete. Explain what was completed and what blocked the rest.'
        : 'The run completed successfully. Confirm the outcome clearly.',
    ].join('\n');

    const userMessage = [
      `Original user request: ${request.message}`,
      `Plan summary: ${plan.summary}`,
      'Task outcomes:',
      ...outcomeLines,
      taskHints.length > 0 ? `Helpful notes:\n${taskHints.map(note => `- ${note}`).join('\n')}` : '',
      failure ? `Failure point: ${failure.task.title} - ${failure.summary}` : 'Failure point: none',
    ].filter(Boolean).join('\n');

    let content = '';
    const llmDefaults = getConfig().llm?.defaults;
    for await (const chunk of this.llm.streamChat([
      { role: 'system', content: prompt },
      { role: 'user', content: userMessage },
    ], undefined, {
      temperature: llmDefaults?.temperature,
      topP: llmDefaults?.topP,
      topK: llmDefaults?.topK,
      maxTokens: llmDefaults?.maxOutputTokens ?? 800
    })) {
      if (chunk.type === 'thinking' && chunk.content) {
        yield { type: 'thinking', content: chunk.content };
      } else if (chunk.type === 'content' && chunk.content) {
        content += chunk.content;
        yield { type: 'content', content: chunk.content };
      }
    }

    if (content.trim()) {
      yield { type: 'final_result', content };
      return;
    }

    if (failure) {
      yield { type: 'final_result', content: `I completed part of the task, but got blocked at "${failure.task.title}". ${failure.summary}` };
      return;
    }

    yield { type: 'final_result', content: 'The task is complete.' };
  }

  private async *replanRemainingTasks(
    request: AgentRequest,
    prepared: PreparedRequestContext,
    plan: TaskPlan,
    failedTask: TaskItem,
    outcome: TaskRunOutcome,
    failedIndex: number,
  ): AsyncGenerator<InternalReplanEvent> {
    const toolNames = prepared.selectedTools.map(tool => tool.name);
    const skillNames = prepared.activeSkills.map(skill => skill.name);

    const prompt = [
      prepared.systemPrompt,
      '# Internal Replanner',
      'You are revising the remaining task list for an autonomous agent runtime.',
      'A previous task was blocked or failed, but the agent should keep working toward the user goal if possible.',
      'Return ONLY a <task_plan> JSON block describing the remaining tasks from now on.',
      'Do not repeat completed tasks.',
      'You may insert a recovery step first if needed.',
      'Tasks must stay semantic, not raw tool calls.',
      `Available tools: ${toolNames.join(', ') || 'none'}`,
      `Available skills: ${skillNames.join(', ') || 'none'}`,
      '',
      'Schema:',
      '<task_plan>',
      '{"summary":"string","tasks":[{"id":"task_1","title":"string","objective":"string","acceptance":"string","suggestedTools":["tool_name"],"relevantSkills":["skill_name"]}]}',
      '</task_plan>',
    ].join('\n');

    const replanContext = [
      '[REPLAN CONTEXT]',
      `Goal: ${plan.goal}`,
      `Current plan:\n${formatTaskPlanForPrompt(plan)}`,
      `Failed task index: ${failedIndex + 1}`,
      `Failed task: ${failedTask.title}`,
      `Failure status: ${outcome.status}`,
      `Failure summary: ${outcome.summary}`,
      `Failure artifacts: ${(outcome.artifacts || []).join(', ') || 'none'}`,
      'Generate only the remaining tasks needed from this point onward.',
    ].join('\n');

    let assistantContent = '';
    let thinkingContent = '';
    let tokens = 0;

    const llmDefaults = getConfig().llm?.defaults;
    for await (const chunk of this.llm.streamChat([
      { role: 'system', content: prompt },
      ...prepared.history,
      { role: 'user', content: replanContext },
    ], undefined, {
      temperature: 0.2, // Replanner low temp
      topP: llmDefaults?.topP,
      topK: llmDefaults?.topK,
      maxTokens: 1200
    })) {
      if (chunk.type === 'thinking' && chunk.content) {
        thinkingContent += chunk.content;
        tokens += estimateTokens(chunk.content);
        yield { type: 'thinking', content: chunk.content };
      } else if (chunk.type === 'content' && chunk.content) {
        assistantContent += chunk.content;
        tokens += estimateTokens(chunk.content);
      } else if (chunk.type === 'error') {
        yield { type: 'error', error: chunk.error ?? 'Replanner error.' };
        yield { type: 'replan_result', result: null };
        return;
      }
    }

    const parsed = extractTaggedJson<Record<string, unknown>>(
      [assistantContent, thinkingContent],
      'task_plan',
    );

    if (!parsed) {
      yield { type: 'replan_result', result: null };
      return;
    }

    const normalized = normalizeTaskPlan(parsed, request.message, toolNames, skillNames);
    yield {
      type: 'replan_result',
      result: {
        summary: normalized.summary,
        tasks: normalized.tasks,
        tokens,
        thinking: thinkingContent,
      },
    };
  }

  private resolveTaskSkills(
    prepared: PreparedRequestContext,
    task: TaskItem,
    userMessage: string,
  ): LoadedSkill[] {
    if (task.relevantSkills.length > 0) {
      const requested = new Set(task.relevantSkills.map(skill => skill.toLowerCase()));
      const matched = prepared.activeSkills.filter(skill => requested.has(skill.name.toLowerCase()));
      if (matched.length > 0) return matched;
    }

    return selectRelevantSkills(`${userMessage}\n${task.title}\n${task.objective}`, 2);
  }

  private resolveTaskTools(
    prepared: PreparedRequestContext,
    task: TaskItem,
    userMessage: string,
  ): ToolDefinition[] {
    const selectedByTask = toolRegistry.selectRelevant(
      `${userMessage}\n${task.title}\n${task.objective}\n${task.suggestedTools.join(' ')}`,
      12,
    );

    if (selectedByTask.length > 0) return selectedByTask;
    return prepared.selectedTools;
  }

  private buildUserMessage(request: AgentRequest): LLMMessage {
    if (request.images && request.images.length > 0) {
      const content: any[] = [{ type: 'text', text: request.message }];

      for (const img of request.images) {
        content.push({
          type: 'image_url',
          image_url: {
            url: img.startsWith('data:') ? img : `data:image/jpeg;base64,${img}`,
            detail: 'auto',
          },
        });
      }

      return { role: 'user', content };
    }

    return { role: 'user', content: request.message };
  }
}

function buildRequestMetadata(request: AgentRequest): string | undefined {
  const metadata: Record<string, unknown> = {};
  if (request.userIdentifier) metadata.userIdentifier = request.userIdentifier;
  if (request.images?.length) metadata.imageCount = request.images.length;
  if (request.attachments?.length) metadata.attachments = request.attachments;
  return Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : undefined;
}

function safeParseJSON(str: string): Record<string, any> {
  try {
    return JSON.parse(str);
  } catch {
    return { raw: str };
  }
}

function extractEmbeddedToolCalls(
  sources: string[],
  toolDefs: Array<{ function: { name: string } }>,
): LLMToolCall[] {
  const toolNames = new Set(toolDefs.map(td => td.function.name));
  const calls: LLMToolCall[] = [];

  for (const source of sources) {
    if (!source) continue;

    const matchers = [
      { regex: /<tool_call>([\s\S]*?)<\/tool_call>/g, group: 1 },
      { regex: /<\|tool_call\|>call:\s*([a-z0-9_-]+)({[\s\S]*?})(?:<\/tool_call>|<tool_call\|>|(?:\n|$))/gi, group: 0, complex: true },
      { regex: /<\|tool_call>call:\s*([a-z0-9_-]+)({[\s\S]*?})(?:<\/tool_call>|<tool_call\|>|(?:\n|$))/gi, group: 0, complex: true },
      { regex: /<tool_call>\s*(<function=[\s\S]*?<\/function>)\s*<\/tool_call>/gi, group: 1, functionStyle: true },
      { regex: /<[|｜]DSML[|｜]tool_calls[\s\S]*?<\/[|｜]DSML[|｜]tool_calls>/gi, group: 0, dsml: true },
      { regex: /```(?:json)?\s*({[\s\S]*?})\s*```/g, group: 1 },
    ];

    for (const matcher of matchers) {
      if ((matcher as any).dsml) {
        const matches = source.matchAll(matcher.regex);
        for (const match of matches) {
          const dsmlCalls = parseDsmlToolCalls(match[0].trim(), toolNames);
          for (const call of dsmlCalls) {
            if (!calls.some(existing => existing.function.name === call.function.name && existing.function.arguments === call.function.arguments)) {
              calls.push(call);
            }
          }
        }
        continue;
      }

      if ((matcher as any).functionStyle) {
        const matches = source.matchAll(matcher.regex);
        for (const match of matches) {
          const parsed = parseFunctionStyleToolCall(match[matcher.group].trim());
          if (!parsed?.name || !toolNames.has(parsed.name)) continue;
          const argsStr = JSON.stringify(parsed.arguments ?? {});
          if (!calls.some(call => call.function.name === parsed.name && call.function.arguments === argsStr)) {
            calls.push({
              id: `embedded_${Date.now()}_${calls.length}`,
              type: 'function',
              function: { name: parsed.name, arguments: argsStr },
            });
          }
        }
        continue;
      }

      if (matcher.complex) {
        const matches = source.matchAll(matcher.regex);
        for (const match of matches) {
          const name = match[1];
          const rawArgs = match[2];
          if (name && toolNames.has(name)) {
            const args = safeParseToolArgs(rawArgs);
            const argsStr = JSON.stringify(args);
            if (!calls.some(call => call.function.name === name && call.function.arguments === argsStr)) {
              calls.push({
                id: `embedded_${Date.now()}_${calls.length}`,
                type: 'function',
                function: { name, arguments: argsStr },
              });
            }
          }
        }
        continue;
      }

      const matches = source.matchAll(matcher.regex);
      for (const match of matches) {
        const rawJson = match[matcher.group].trim();
        try {
          const parsed = JSON.parse(rawJson);

          if (parsed?.name && toolNames.has(parsed.name)) {
            const argsStr = JSON.stringify(parsed.arguments ?? {});
            if (!calls.some(call => call.function.name === parsed.name && call.function.arguments === argsStr)) {
              calls.push({
                id: `embedded_${Date.now()}_${calls.length}`,
                type: 'function',
                function: { name: parsed.name, arguments: argsStr },
              });
            }
          }
        } catch {
          // If it fails as JSON, try to extract it as a name/args pair if it looks like one
          const nameMatch = rawJson.match(/^\s*["']?name["']?\s*:\s*["'](\w+)["']/);
          const argsMatch = rawJson.match(/["']?arguments["']?\s*:\s*({[\s\S]*?})\s*$/);

          if (nameMatch?.[1] && argsMatch?.[1] && toolNames.has(nameMatch[1])) {
            const args = safeParseToolArgs(argsMatch[1]);
            calls.push({
              id: `embedded_${Date.now()}_${calls.length}`,
              type: 'function',
              function: { name: nameMatch[1], arguments: JSON.stringify(args) },
            });
          }
        }
      }
    }
  }

  return calls;
}

function stripEmbeddedToolCalls(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<\|tool_call\|?>[\s\S]*?(?:<\/tool_call>|<tool_call\|>|(?:\n|$))/gi, '')
    .replace(/<tool_call>\s*<function=[\s\S]*?<\/function>\s*<\/tool_call>/gi, '')
    .replace(/<[|｜]DSML[|｜]tool_calls[\s\S]*?<\/[|｜]DSML[|｜]tool_calls>/gi, '')
    .replace(/```(?:json)?\s*{[\s\S]*?}\s*```/g, '')
    .replace(/<\/?task_update>/gi, '')
    .replace(/<\/?(think|thinking|thought)>/gi, '')
    .trim();
}

function safeParseToolArgs(raw: string): Record<string, any> {
  try {
    return JSON.parse(raw);
  } catch {
    // Attempt to extract key-value pairs from malformed JSON
    const args: Record<string, any> = {};
    // Matches key: "value", key: 'value', or key: value
    const kvPattern = /["']?(\w+)["']?\s*[:=]\s*(?:["']([^"']*?)["']|(\d+)|(true|false|null))/g;
    let match;
    while ((match = kvPattern.exec(raw)) !== null) {
      const key = match[1];
      const val = match[2] ?? (match[3] ? Number(match[3]) : match[4] === 'true' ? true : match[4] === 'false' ? false : null);
      args[key] = val;
    }

    if (Object.keys(args).length === 0 && raw.trim()) {
      args['input'] = raw.trim().replace(/^["']|["']$/g, '');
    }
    return args;
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

function parseDsmlToolCalls(dsml: string, toolNames: Set<string>): LLMToolCall[] {
  const calls: LLMToolCall[] = [];
  const invokeRegex = /<[|｜]DSML[|｜]invoke\s+name="([^"]+)">([\s\S]*?)<\/[|｜]DSML[|｜]invoke>/gi;
  const paramRegex = /<[|｜]DSML[|｜]parameter\s+name="([^"]+)"\s+string="(true|false)">([\s\S]*?)<\/[|｜]DSML[|｜]parameter>/gi;

  let invokeMatch: RegExpExecArray | null;
  while ((invokeMatch = invokeRegex.exec(dsml)) !== null) {
    const name = invokeMatch[1];
    if (!toolNames.has(name)) continue;

    const body = invokeMatch[2] ?? '';
    const args: Record<string, unknown> = {};
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = paramRegex.exec(body)) !== null) {
      const key = paramMatch[1];
      const asString = paramMatch[2] === 'true';
      const rawValue = (paramMatch[3] ?? '').trim();

      if (asString) {
        args[key] = rawValue;
        continue;
      }

      try {
        args[key] = JSON.parse(rawValue);
      } catch {
        args[key] = rawValue;
      }
    }

    calls.push({
      id: `embedded_dsml_${Date.now()}_${calls.length}`,
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(args),
      },
    });
  }

  return calls;
}

function inferSafeToolCall(
  thinkingContent: string,
  userMessage: string,
  toolDefs: Array<{ function: { name: string } }>,
): LLMToolCall | null {
  const available = new Set(toolDefs.map(td => td.function.name));
  const combined = `${thinkingContent}\n${userMessage}`;

  const makeCall = (name: string, args: Record<string, unknown>): LLMToolCall => ({
    id: `inferred_${Date.now()}_${name}`,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  });

  if (available.has('read_file') && /read_file/i.test(combined)) {
    const pathMatch =
      combined.match(/`([^`\r\n]+?\.[a-z0-9]+)`/i) ||
      combined.match(/"([^"\r\n]+?\.[a-z0-9]+)"/i) ||
      combined.match(/\b([A-Za-z0-9._/-]+\.[A-Za-z0-9]+)\b/);
    if (pathMatch?.[1]) {
      return makeCall('read_file', { path: pathMatch[1] });
    }
  }

  if (available.has('list_dir') && /list_dir/i.test(combined)) {
    const pathMatch =
      combined.match(/current directory/i) ? '.' :
        combined.match(/`([^`\r\n]+)`/)?.[1] ??
        combined.match(/"([^"\r\n]+)"/)?.[1];
    return makeCall('list_dir', { path: pathMatch || '.' });
  }

  if (available.has('web_search') && /web_search/i.test(combined)) {
    const queryMatch =
      combined.match(/query like "([^"]+)"/i) ||
      combined.match(/query "([^"]+)"/i) ||
      combined.match(/latest [^"\r\n]+/i);
    if (queryMatch?.[1] || queryMatch?.[0]) {
      return makeCall('web_search', { query: queryMatch[1] ?? queryMatch[0], maxResults: 5 });
    }
  }

  if (available.has('web_fetch') && /web_fetch/i.test(combined)) {
    const urlMatch = combined.match(/https?:\/\/\S+/i);
    if (urlMatch?.[0]) {
      return makeCall('web_fetch', { url: urlMatch[0] });
    }
  }

  return null;
}

function truncateToolOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output;
  const half = Math.floor(maxChars / 2);
  return `${output.slice(0, half)}\n\n... [truncated ${output.length - maxChars} chars] ...\n\n${output.slice(-half)}`;
}

function formatToolResultForModel(toolName: string, result: ToolResult): string {
  const output = truncateToolOutput(result.output, 2000);
  let content = `<tool_result>\n{"tool":"${toolName}","success":${result.success ? 'true' : 'false'}}\n</tool_result>\n\n${output}`;

  if (!result.success) {
    content += `\n\n[RECOVERY NUDGE: The tool "${toolName}" failed. Analyze the output above, identify the error, and emit a corrected tool call or a task_update explaining the blocker.]`;
  } else {
    content += `\n\n[SYSTEM: The tool "${toolName}" succeeded. Use the results above to continue the task or emit a <task_update> if the objective is now met.]`;
  }

  return content;
}

function normalizeTaskId(id: string, fallbackIndex: number): string {
  const trimmed = id?.trim();
  if (!trimmed) return `task_${fallbackIndex}`;
  return /^task_\d+$/i.test(trimmed) ? `task_${fallbackIndex}` : trimmed;
}

function shouldUseTaskPlanner(message: string, selectedTools: ToolDefinition[]): boolean {
  const lowered = message.toLowerCase().trim();

  if (!lowered) return false;

  // 1. Direct conversational bail-out for common greetings/reactions
  const conversationalPrefixes = /^(hi|hello|hey|yo|sup|how are you|what's up|thanks|thank you|lol|lmao|bruh|omg|wow|cool|nice|ok|okay|yep|yeah|no|yes|nah|well|anyway|btw)\b/;
  if (conversationalPrefixes.test(lowered) && lowered.split(/\s+/).length < 10) {
    return false;
  }

  const toolNames = new Set(selectedTools.map(tool => tool.name));

  // 2. Detect strong "Task" intent (Explicit request for multi-step or complex operations)
  const multiStepSignals = [
    /\band then\b/,
    /\bthen\b/,
    /\bafter that\b/,
    /\bafterwards\b/,
    /\bbefore\b/,
    /\bfirst\b.*\bthen\b/,
    /\bnext\b/,
    /\bfinally\b/,
    /\b(sequence|steps|list|plan|process|workflow)\b/,
  ];

  const complexActionSignals = [
    /\b(implement|build|refactor|restructure|integrate|deploy|automate|rewrite|optimize)\b/,
    /\b(research|analyze|investigate|evaluate|compare|audit)\b/,
    /\b(create|generate|draft)\b.*\b(document|report|script|file|system|application)\b/,
  ];

  const operationalSignals = [
    /\b(read|inspect|check|review|open)\b.*\b(all|multiple|every|each|files|directory|folder)\b/,
    /\b(fix|update|modify|change)\b.*\b(everything|all cases|multiple places)\b/,
  ];

  let score = 0;
  if (multiStepSignals.some(pattern => pattern.test(lowered))) score += 3;
  if (complexActionSignals.some(pattern => pattern.test(lowered))) score += 3;
  if (operationalSignals.some(pattern => pattern.test(lowered))) score += 2;

  // Basic action signals (lower weight)
  const basicActionSignals = [
    /\b(edit|update|modify|fix|change|make)\b/,
    /\b(search|find|fetch|look up|get|run|execute)\b/,
  ];
  if (basicActionSignals.some(pattern => pattern.test(lowered))) score += 1;

  // Artifact signals (files, external platforms)
  const artifactSignals = [
    /\b[a-z0-9._/-]+\.[a-z0-9]{2,6}\b/i, // Matches filenames with extensions
    /\b(docx|pdf|spreadsheet|word document|discord|whatsapp|file|folder|directory|repository|repo)\b/,
  ];
  if (artifactSignals.some(pattern => pattern.test(lowered))) score += 1;

  // 3. Negative signals (Conversational / Non-Task)
  const conversationalMarkers = [
    /\b(dawg|bro|dude|man|lol|lmao|lmfao|joke|funny|fire|crazy|wild)\b/,
    /\b(i think|i feel|i guess|maybe|just saying)\b/,
    /\b(what do you think|your opinion|how about)\b/,
  ];
  if (conversationalMarkers.some(pattern => pattern.test(lowered))) score -= 2;

  // 4. Final Decision
  const isShort = lowered.length < 120;
  const hasPlanKeywords = /\b(plan|steps|sequence)\b/.test(lowered);

  // If it's a short message or conversational remark, avoid planning unless it specifically asks for a plan.
  if (isShort && score < 4 && !hasPlanKeywords) {
    return false;
  }

  // Threshold: 4 is a "complex" task
  return score >= 4;
}

function isLikelyHiddenReasoning(text: string): boolean {
  const cleaned = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return false;

  if (/^`[\s\S]{0,800}$/m.test(text) && /\b(import |def |subprocess|requests?|python|bash|powershell|curl)\b/i.test(text)) {
    return true;
  }

  if (/^\s*(task plan|searching for|thought process|reasoning:)\b/i.test(cleaned)) {
    return true;
  }

  return [
    /^i need to\b/i,
    /^let me\b/i,
    /^i(?:'|’)ll\b/i,
    /^i will\b/i,
    /^i should\b/i,
    /^i(?:'|’)m going to\b/i,
    /^first[, ]/i,
    /^to answer this[, ]/i,
    /\buse (?:the )?[a-z0-9_]+\b/i,
    /\b(search|check|look up|inspect|compare|analyze|review|read|open|fetch)\b.+\b(first|before|then)\b/i,
    /\bthe agent could not complete\b/i,
    /\b(searching for|researching|cross[- ]?checking|looking up)\b/i,
    /\bimport subprocess\b/i,
    /\bdef [a-z_]+\(/i,
  ].some((pattern) => pattern.test(cleaned));
}
