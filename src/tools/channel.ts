/**
 * LiteClaw - Channel-native interaction tools
 *
 * These tools let the agent create richer chat UX in channels that support it.
 */

import { toolRegistry, ToolContext, ToolResult, type InteractiveChoiceRequest } from '../core/tools.js';

toolRegistry.register({
  name: 'send_interactive_choices',
  description: 'Send an interactive multi-choice message in the current chat. Best for Discord button choices.',
  category: 'channel',
  parameters: [
    {
      name: 'prompt',
      type: 'string',
      description: 'The question or invitation shown above the buttons.',
      required: true,
    },
    {
      name: 'options',
      type: 'array',
      description: 'Up to 5 short button labels users can choose from.',
      required: true,
      items: { type: 'string' },
    },
    {
      name: 'responses',
      type: 'object',
      description: 'Optional map from option label to the follow-up message that should be sent when a user picks it.',
      properties: {},
      additionalProperties: { type: 'string' },
    },
  ],
  keywords: ['discord', 'interactive', 'button', 'buttons', 'choose', 'choice', 'choices', 'select', 'poll', 'vote'],
  handler: async (args, context): Promise<ToolResult> => {
    if (!context.sendInteractiveChoice) {
      return {
        success: false,
        output: 'Interactive choices are not available in the current channel.',
      };
    }

    const request = normalizeInteractiveChoiceArgs(args);
    if (!request) {
      return {
        success: false,
        output: 'Invalid interactive choice arguments. Expected a prompt and 1-5 options.',
      };
    }

    const interactionId = await context.sendInteractiveChoice(request);
    return {
      success: true,
      output: `Interactive choice posted with id ${interactionId}. Users can now pick: ${request.options.join(', ')}`,
    };
  },
});

function normalizeInteractiveChoiceArgs(args: Record<string, any>): InteractiveChoiceRequest | null {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  const rawOptions = Array.isArray(args.options)
    ? args.options
    : typeof args.options === 'string'
      ? safeParseArray(args.options)
      : [];
  const options = rawOptions
    .map(item => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)
    .slice(0, 5);

  if (!prompt || options.length === 0) {
    return null;
  }

  const responses = normalizeResponses(args.responses);
  return { prompt, options, responses };
}

function normalizeResponses(value: unknown): Record<string, string> | undefined {
  const parsed = typeof value === 'string' ? safeParseObject(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

  const normalized = Object.fromEntries(
    Object.entries(parsed)
      .filter(([, response]) => typeof response === 'string' && response.trim().length > 0)
      .map(([option, response]) => [option.trim(), String(response).trim()])
  );

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function safeParseArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return raw.split(',').map(part => part.trim()).filter(Boolean);
  }
}

function safeParseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
