/**
 * LiteClaw — Web Tools
 * 
 * Google Grounding for search (same as OpenClaw) + web fetch.
 * Falls back to DuckDuckGo if Google API key not available.
 */

import { toolRegistry, ToolResult } from '../core/tools.js';
import { getConfig } from '../config.js';

// ─── web_search (Google Grounding) ───────────────────────────────────

toolRegistry.register({
  name: 'web_search',
  description: 'Search the web using Google Grounding. Returns summarized results with sources.',
  category: 'web',
  parameters: [
    { name: 'query', type: 'string', description: 'The search query', required: true },
    { name: 'maxResults', type: 'number', description: 'Maximum results to return (default: 5)' },
  ],
  usageNotes: [
    'Use this for latest information, news, or facts that may have changed recently.',
    'The query should be a plain search phrase, not a URL.',
    'If you already have a specific URL, use web_fetch instead.'
  ],
  examples: [
    { userIntent: 'latest ai news', arguments: { query: 'latest AI news', maxResults: 5 } },
  ],
  keywords: ['search', 'google', 'web', 'find', 'lookup', 'look up', 'information', 'news', 'latest', 'what is', 'who is', 'how to'],
  handler: async (args): Promise<ToolResult> => {
    const config = getConfig();
    const apiKey = config.tools?.web?.search?.apiKey ?? process.env.GOOGLE_API_KEY;
    const query = args.query;

    if (!query) {
      return { success: false, output: 'No search query specified' };
    }

    // Try Google Grounding first
    if (apiKey) {
      try {
        const result = await googleGroundingSearch(query, apiKey, args.maxResults ?? 5);
        return { success: true, output: result };
      } catch (err: any) {
        // Fall through to DuckDuckGo
        console.warn('Google Grounding failed, falling back to DuckDuckGo:', err.message);
      }
    }

    // Fallback: DuckDuckGo instant answers
    try {
      const result = await duckDuckGoSearch(query);
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, output: `Search failed: ${err.message}` };
    }
  },
});

/**
 * Google Grounding Search via Gemini API
 * Uses the generateContent endpoint with grounding enabled.
 */
async function googleGroundingSearch(query: string, apiKey: string, maxResults: number): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: query }] }],
      tools: [{
        google_search: {},
      }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Google API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as any;

  // Extract grounded response
  const candidate = data.candidates?.[0];
  if (!candidate) {
    throw new Error('No response from Google Grounding');
  }

  let resultText = '';

  // Get the generated text
  const textPart = candidate.content?.parts?.find((p: any) => p.text);
  if (textPart) {
    resultText = textPart.text;
  }

  // Extract grounding metadata (sources)
  const groundingMeta = candidate.groundingMetadata;
  if (groundingMeta?.groundingChunks) {
    const sources = groundingMeta.groundingChunks
      .slice(0, maxResults)
      .map((chunk: any, i: number) => {
        const web = chunk.web;
        return web ? `[${i + 1}] ${web.title ?? 'Source'}: ${web.uri ?? ''}` : '';
      })
      .filter(Boolean);

    if (sources.length > 0) {
      resultText += '\n\nSources:\n' + sources.join('\n');
    }
  }

  return resultText || 'No results found.';
}

/**
 * DuckDuckGo Instant Answer API fallback
 */
async function duckDuckGoSearch(query: string): Promise<string> {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    no_redirect: '1',
    no_html: '1',
  });

  const response = await fetch(`https://api.duckduckgo.com/?${params}`, {
    headers: { 'User-Agent': 'LiteClaw/0.1' },
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo API error: ${response.status}`);
  }

  const data = await response.json() as any;

  const results: string[] = [];

  if (data.Abstract) {
    results.push(`${data.Abstract}\nSource: ${data.AbstractURL ?? ''}`);
  }

  if (data.RelatedTopics) {
    for (const topic of data.RelatedTopics.slice(0, 5)) {
      if (topic.Text) {
        results.push(`• ${topic.Text}`);
      }
    }
  }

  return results.length > 0
    ? results.join('\n\n')
    : `No instant results for "${query}". Try a more specific query.`;
}

// ─── web_fetch ───────────────────────────────────────────────────────

toolRegistry.register({
  name: 'web_fetch',
  description: 'Fetch a web page and return its text content (HTML stripped to plain text).',
  category: 'web',
  parameters: [
    { name: 'url', type: 'string', description: 'The URL to fetch', required: true },
    { name: 'maxChars', type: 'number', description: 'Maximum characters to return (default: 5000)' },
  ],
  usageNotes: [
    'Use this when you already have a specific URL and need the page contents.',
    'Do not use this for general search tasks; use web_search first.',
    'Keep maxChars modest when you only need a quick inspection.'
  ],
  examples: [
    { userIntent: 'fetch this article', arguments: { url: 'https://example.com', maxChars: 4000 } },
  ],
  keywords: ['fetch', 'url', 'website', 'page', 'http', 'download', 'get', 'load', 'scrape'],
  handler: async (args): Promise<ToolResult> => {
    const url = args.url;
    if (!url) {
      return { success: false, output: 'No URL specified' };
    }

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'LiteClaw/0.1 (Local AI Agent)',
          'Accept': 'text/html,text/plain,application/json',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        return { success: false, output: `HTTP ${response.status}: ${response.statusText}` };
      }

      const contentType = response.headers.get('content-type') ?? '';
      let text: string;

      if (contentType.includes('json')) {
        const json = await response.json();
        text = JSON.stringify(json, null, 2);
      } else {
        const html = await response.text();
        text = stripHtml(html);
      }

      const maxChars = args.maxChars ?? 5000;
      if (text.length > maxChars) {
        text = text.slice(0, maxChars) + `\n\n... [truncated, ${text.length} total chars]`;
      }

      return {
        success: true,
        output: `URL: ${url}\n\n${text}`,
      };
    } catch (err: any) {
      return { success: false, output: `Fetch error: ${err.message}` };
    }
  },
});

/**
 * Strip HTML to plain text (lightweight, no dependency).
 */
function stripHtml(html: string): string {
  return html
    // Remove script/style content
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Replace common block elements with newlines
    .replace(/<\/?(p|div|br|h[1-6]|li|tr|td|th)[^>]*>/gi, '\n')
    // Remove all remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Clean whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
