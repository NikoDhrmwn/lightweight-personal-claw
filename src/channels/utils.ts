/**
 * LiteClaw — Channel Utilities
 * 
 * Shared logic for formatting and sanitizing content before sending
 * to user-facing channels like Discord and WhatsApp.
 */

/**
 * Strips internal agent tags and artifacts from content.
 * Prevents leaking <think>, <task_update>, <tool_call>, etc. to users.
 */
export function sanitizeChannelContent(text: string): string {
  if (!text) return '';

  return text
    // 1. Strip thinking blocks completely
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*/gi, '') // Handle unclosed think tags
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<thinking>[\s\S]*/gi, '') // Handle unclosed thinking tags
    
    // 2. Strip task updates
    .replace(/<task_update>[\s\S]*?<\/task_update>/gi, '')
    .replace(/<task_update>[\s\S]*/gi, '')
    
    // 3. Strip tool calls and results (internal XML)
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<call_tool\b[\s\S]*?(?:\/>|<\/call_tool>)/gi, '')
    .replace(/<function=[\s\S]*?<\/function>/gi, '')
    .replace(/<tool_result>[\s\S]*?<\/tool_result>/gi, '')
    .replace(/<\/?(tool_call|tool_result|task_update|think|thinking)>/gi, '')
    .replace(/^\s*<call_tool\b.*$/gim, '')
    .replace(/^\s*<function=.*$/gim, '')

    // 4. Clean up whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Splits text into bursts or chunks based on length limits.
 * Handles paragraph and sentence boundaries.
 */
export function splitMessage(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
