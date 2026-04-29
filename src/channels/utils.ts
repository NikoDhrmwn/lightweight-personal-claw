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
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<thought>[\s\S]*/gi, '')
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
    .replace(/<\/?(tool_call|tool_result|task_update|think|thought|thinking)>/gi, '')
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

/**
 * Formats standard Markdown for WhatsApp's limited formatting.
 */
export function formatForWhatsApp(text: string): string {
  if (!text) return '';

  return text
    // 1. Convert headers (# Header) to *HEADER*
    .replace(/^#+\s+(.*)$/gm, '*$1*')

    // 2. Protect bold blocks (**text** or __text__) by converting to a marker
    .replace(/(\*\*|__)(.*?)\1/g, '@@BOLD@@$2@@BOLD@@')

    // 3. Convert single *italic* or _italic_ to _italic_
    .replace(/(^|[^\\])([*_])([^*\s_].*?)\2/g, '$1_$3_')

    // 4. Restore bold as *text*
    .replace(/@@BOLD@@(.*?)@@BOLD@@/g, '*$1*')

    // 5. Convert strikethrough (~~text~~) to ~text~
    .replace(/~~(.*?)~~/g, '~$1~')

    // 6. Convert blockquotes (> text) to _text_ (italic fallback)
    .replace(/^>\s+(.*)$/gm, '_$1_')

    // 7. Fix bullet points
    .replace(/^\s*[-*+]\s+/gm, '• ')

    // 8. Strip GIF URLs (Tenor, Giphy) - WhatsApp doesn't embed these well
    .replace(/https?:\/\/(?:www\.)?(?:tenor\.com\/view\/|giphy\.com\/gifs\/|gph\.is\/)\S+/gi, '')

    // 9. Cleanup extra spaces
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
