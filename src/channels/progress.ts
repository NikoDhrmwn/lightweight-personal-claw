import type { AgentStreamEvent } from '../core/engine.js';
import { formatForWhatsApp, sanitizeChannelContent, splitMessage } from './utils.js';

export type ChannelProgressStatus = 'starting' | 'thinking' | 'planning' | 'working' | 'done' | 'error';
export type ChannelTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked' | 'skipped';
export type ChannelProgressFlavor = 'discord' | 'whatsapp';

export interface ChannelProgressTask {
  id: string;
  title: string;
  status: ChannelTaskStatus;
  summary?: string;
}

export interface ChannelProgressState {
  startedAt: number;
  status: ChannelProgressStatus;
  planSummary?: string;
  tasks: ChannelProgressTask[];
  recentTools: string[];
  currentTaskLabel?: string;
  error?: string;
}

export interface OutgoingMessageOptions {
  replyStyle: 'single' | 'rapid';
  showToolProgress: boolean;
  maxLen: number;
  format?: 'plain' | 'whatsapp';
}

export function createChannelProgressState(): ChannelProgressState {
  return {
    startedAt: Date.now(),
    status: 'starting',
    planSummary: '',
    tasks: [],
    recentTools: [],
  };
}

export function applyEventToChannelProgress(progress: ChannelProgressState, event: AgentStreamEvent, flavor: ChannelProgressFlavor): void {
  switch (event.type) {
    case 'thinking':
      if (progress.status === 'starting') progress.status = 'thinking';
      break;
    case 'plan':
      progress.status = 'planning';
      progress.planSummary = event.plan?.summary ?? progress.planSummary;
      progress.tasks = (event.plan?.tasks ?? []).map((task, index) => ({
        id: task.id || `task_${index + 1}`,
        title: task.title || `Task ${index + 1}`,
        status: (task.status || 'pending') as ChannelTaskStatus,
        summary: task.summary,
      }));
      break;
    case 'task_update': {
      progress.status = event.taskStatus === 'in_progress' ? 'working' : progress.status;
      if (event.plan?.summary) progress.planSummary = event.plan.summary;

      const taskId = event.taskId || event.taskTitle || `task_${event.taskIndex ?? progress.tasks.length + 1}`;
      const title = event.taskTitle || 'Task';
      const existing = progress.tasks.find(task => task.id === taskId);
      if (existing) {
        existing.title = title;
        existing.status = (event.taskStatus || existing.status) as ChannelTaskStatus;
        existing.summary = event.taskSummary || existing.summary;
      } else {
        progress.tasks.push({
          id: taskId,
          title,
          status: (event.taskStatus || 'pending') as ChannelTaskStatus,
          summary: event.taskSummary,
        });
      }

      progress.currentTaskLabel = event.taskIndex && event.taskTotal
        ? `[${event.taskIndex}/${event.taskTotal}] ${title}`
        : title;
      break;
    }
    case 'tool_start':
      progress.status = 'working';
      pushRecentToolUpdate(progress, formatToolUpdate(flavor, event.toolName ?? 'tool', true, true));
      break;
    case 'tool_result':
      pushRecentToolUpdate(
        progress,
        formatToolUpdate(flavor, event.toolName ?? 'tool', false, Boolean(event.toolResult?.success)),
      );
      break;
    case 'error':
      progress.status = 'error';
      progress.error = event.error;
      break;
    case 'done':
      if (progress.status !== 'error') progress.status = 'done';
      break;
  }
}

export function getProgressCounts(progress: ChannelProgressState) {
  const completed = progress.tasks.filter(task => task.status === 'completed').length;
  const failed = progress.tasks.filter(task => task.status === 'failed' || task.status === 'blocked').length;
  const active = progress.tasks.filter(task => task.status === 'in_progress').length;
  const total = progress.tasks.length;
  const pending = Math.max(0, total - completed - failed - active);
  return { completed, failed, active, total, pending };
}

export function formatProgressStatusLabel(status: ChannelProgressStatus, flavor: ChannelProgressFlavor): string {
  if (flavor === 'whatsapp') {
    switch (status) {
      case 'thinking': return '🧠 Thinking';
      case 'planning': return '🗺 Planning';
      case 'working': return '⚙ Working';
      case 'done': return '✅ Complete';
      case 'error': return '❌ Error';
      case 'starting':
      default:
        return '👀 Starting';
    }
  }

  switch (status) {
    case 'thinking': return '🧠 Thinking';
    case 'planning': return '🗺️ Planning';
    case 'working': return '⚙️ Working';
    case 'done': return '✅ Complete';
    case 'error': return '❌ Error';
    case 'starting':
    default:
      return '👀 Starting';
  }
}

export function formatTaskStatusIcon(status: string, flavor: ChannelProgressFlavor): string {
  if (flavor === 'whatsapp') {
    switch (status) {
      case 'completed': return '✅';
      case 'in_progress': return '🟡';
      case 'failed': return '❌';
      case 'blocked': return '⚠';
      case 'skipped': return '⏭';
      default: return '⏳';
    }
  }

  switch (status) {
    case 'completed': return '✅';
    case 'in_progress': return '🔵';
    case 'failed': return '❌';
    case 'blocked': return '⚠️';
    default: return '⏳';
  }
}

export function formatDurationShort(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function formatProgressPreview(finalContent: string | undefined, flavor: ChannelProgressFlavor, maxLen: number): string {
  const sanitized = sanitizeChannelContent(finalContent || '');
  const formatted = flavor === 'whatsapp' ? formatForWhatsApp(sanitized) : sanitized;
  const preview = formatted.slice(0, maxLen);
  return preview ? `${preview}${formatted.length > maxLen ? '...' : ''}` : '';
}

export function buildOutgoingMessages(content: string, toolUpdates: string[], options: OutgoingMessageOptions): string[] {
  const sanitized = sanitizeChannelContent(content).trim();
  const cleanedContent = options.format === 'whatsapp' ? formatForWhatsApp(sanitized) : sanitized;
  const toolSummary = (options.showToolProgress || !cleanedContent) && toolUpdates.length > 0
    ? toolUpdates.join('\n').trim()
    : '';
  const fullText = [toolSummary, cleanedContent].filter(Boolean).join('\n\n').trim() || '(No response)';

  if (options.replyStyle === 'rapid') {
    return splitRapidMessages(fullText, options.maxLen);
  }

  return splitMessage(fullText, options.maxLen);
}

function pushRecentToolUpdate(progress: ChannelProgressState, text: string): void {
  progress.recentTools.push(text);
  if (progress.recentTools.length > 5) {
    progress.recentTools = progress.recentTools.slice(-5);
  }
}

function formatToolUpdate(flavor: ChannelProgressFlavor, toolName: string, isStart: boolean, success: boolean): string {
  if (flavor === 'whatsapp') {
    if (isStart) return `⚙ _${toolName}_...`;
    return `${success ? '✓' : '✗'} _${toolName}_`;
  }

  if (isStart) return `Running ${toolName}...`;
  return `${success ? 'Done' : 'Failed'} ${toolName}`;
}

function splitRapidMessages(text: string, maxLen: number): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean);

  const bursts: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= Math.min(maxLen, 500)) {
      bursts.push(paragraph);
      continue;
    }

    const pieces = paragraph
      .split(/(?<=[.!?])\s+|\n/)
      .map(p => p.trim())
      .filter(Boolean);

    let current = '';
    for (const piece of pieces) {
      const candidate = current ? `${current} ${piece}` : piece;
      if (candidate.length > Math.min(maxLen, 500)) {
        if (current) bursts.push(current);
        if (piece.length > Math.min(maxLen, 500)) {
          bursts.push(...splitMessage(piece, Math.min(maxLen, 500)));
          current = '';
        } else {
          current = piece;
        }
      } else {
        current = candidate;
      }
    }

    if (current) bursts.push(current);
  }

  return bursts.length > 0 ? bursts : ['(No response)'];
}
