/**
 * LiteClaw — Web Tools
 *
 * Free multi-backend web search with optional Google Grounding.
 * Default path uses zero-cost public search endpoints / HTML results.
 */

import { createHash } from 'crypto';
import { toolRegistry, ToolResult } from '../core/tools.js';
import { getConfig } from '../config.js';

const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SEARCH_TIMEOUT_MS = 12_000;
const searchCache = new Map<string, { expiresAt: number; output: string }>();

const DEFAULT_SEARXNG_INSTANCES = [
  'https://search.inetol.net',
  'https://priv.au',
  'https://northboot.xyz',
];

// ─── web_search (Google Grounding) ───────────────────────────────────

toolRegistry.register({
  name: 'web_search',
  description: 'Search the web and return source-rich results. Uses free backends by default, with optional Google Grounding.',
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
    const provider = String(config.tools?.web?.search?.provider ?? 'free-metasearch').toLowerCase();
    const query = String(args.query ?? '').trim();
    const maxResults = normalizeMaxResults(args.maxResults);

    if (!query) {
      return { success: false, output: 'No search query specified' };
    }

    const cacheKey = buildSearchCacheKey(provider, query, maxResults);
    const cached = searchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { success: true, output: cached.output };
    }

    try {
      let output = '';

      if (provider === 'google-grounding' && apiKey) {
        try {
          output = await googleGroundingSearch(query, apiKey, maxResults);
        } catch (err: any) {
          console.warn('Google Grounding failed, falling back to free search:', err.message);
          output = await freeWebSearch(query, maxResults, config.tools?.web?.search?.instances);
        }
      } else {
        output = await freeWebSearch(query, maxResults, config.tools?.web?.search?.instances);
      }

      searchCache.set(cacheKey, {
        expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
        output,
      });
      return { success: true, output };
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

async function freeWebSearch(query: string, maxResults: number, configuredInstances: unknown): Promise<string> {
  const errors: string[] = [];
  const instances = normalizeSearxngInstances(configuredInstances);

  for (const instance of instances) {
    try {
      const results = await searxngSearch(instance, query, maxResults);
      if (results.length > 0) {
        return formatSearchResults('SearXNG', query, results);
      }
      errors.push(`${instance}: empty results`);
    } catch (err: any) {
      errors.push(`${instance}: ${err.message}`);
    }
  }

  try {
    const liteResults = await duckDuckGoLiteSearch(query, maxResults);
    if (liteResults.length > 0) {
      return formatSearchResults('DuckDuckGo Lite', query, liteResults);
    }
    errors.push('DuckDuckGo Lite: empty results');
  } catch (err: any) {
    errors.push(`DuckDuckGo Lite: ${err.message}`);
  }

  try {
    const htmlResults = await duckDuckGoHtmlSearch(query, maxResults);
    if (htmlResults.length > 0) {
      return formatSearchResults('DuckDuckGo HTML', query, htmlResults);
    }
    errors.push('DuckDuckGo HTML: empty results');
  } catch (err: any) {
    errors.push(`DuckDuckGo HTML: ${err.message}`);
  }

  throw new Error(errors.length > 0 ? errors.join(' | ') : 'No free search backend returned results.');
}

type SearchHit = {
  title: string;
  url: string;
  snippet?: string;
  source?: string;
};

async function searxngSearch(instance: string, query: string, maxResults: number): Promise<SearchHit[]> {
  const base = instance.replace(/\/+$/, '');
  const url = new URL('/search', `${base}/`);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('categories', 'general');
  url.searchParams.set('language', 'auto');
  url.searchParams.set('safesearch', '0');

  const response = await fetch(url, {
    headers: { 'User-Agent': 'LiteClaw/0.1' },
    signal: AbortSignal.timeout(DEFAULT_SEARCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json() as any;
  const results = Array.isArray(data.results) ? data.results : [];

  return dedupeSearchHits(results
    .slice(0, maxResults * 2)
    .map((row: any) => ({
      title: String(row.title ?? '').trim(),
      url: String(row.url ?? '').trim(),
      snippet: String(row.content ?? row.description ?? '').trim(),
      source: String(row.engine ?? row.parsed_url?.[1] ?? '').trim(),
    }))
    .filter((row: SearchHit) => row.title && row.url))
    .slice(0, maxResults);
}

async function duckDuckGoLiteSearch(query: string, maxResults: number): Promise<SearchHit[]> {
  const response = await fetch('https://lite.duckduckgo.com/lite/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'LiteClaw/0.1',
    },
    body: new URLSearchParams({ q: query }).toString(),
    signal: AbortSignal.timeout(DEFAULT_SEARCH_TIMEOUT_MS),
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const html = await response.text();
  const hits = parseDuckDuckGoLiteResults(html);
  return dedupeSearchHits(hits).slice(0, maxResults);
}

async function duckDuckGoHtmlSearch(query: string, maxResults: number): Promise<SearchHit[]> {
  const response = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'LiteClaw/0.1',
    },
    body: new URLSearchParams({ q: query }).toString(),
    signal: AbortSignal.timeout(DEFAULT_SEARCH_TIMEOUT_MS),
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const html = await response.text();
  const hits = parseDuckDuckGoHtmlResults(html);
  return dedupeSearchHits(hits).slice(0, maxResults);
}

function parseDuckDuckGoLiteResults(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const rowRegex = /<a[^>]*href="([^"]+)"[^>]*class=['"][^'"]*result-link[^'"]*['"][^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class=['"][^'"]*result-link|<\/table>|$)/gi;

  let match: RegExpExecArray | null;
  while ((match = rowRegex.exec(html)) !== null) {
    const rawUrl = decodeHtmlEntities(match[1]);
    if (isDuckDuckGoAdUrl(rawUrl)) continue;
    const url = normalizeSearchResultUrl(rawUrl);
    const title = decodeHtmlEntities(stripHtml(match[2]));
    if (/^more info$/i.test(title)) continue;
    const tail = decodeHtmlEntities(stripHtml(match[3])).replace(/\s+/g, ' ').trim();
    const snippet = tail || undefined;

    if (title && url) {
      hits.push({ title, url, snippet, source: 'duckduckgo-lite' });
    }
  }

  return hits;
}

function parseDuckDuckGoHtmlResults(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const blockRegex = /<div class="result(?:__body)?">([\s\S]*?)<\/div>\s*<\/div>/gi;

  let block: RegExpExecArray | null;
  while ((block = blockRegex.exec(html)) !== null) {
    const body = block[1];
    const linkMatch = body.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    if (isDuckDuckGoAdUrl(linkMatch[1])) continue;
    const title = decodeHtmlEntities(stripHtml(linkMatch[2])).trim();
    if (/^more info$/i.test(title)) continue;
    const url = normalizeSearchResultUrl(decodeHtmlEntities(linkMatch[1]));
    const snippetMatch = body.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const snippetRaw = snippetMatch?.[1] ?? snippetMatch?.[2] ?? '';
    const snippet = decodeHtmlEntities(stripHtml(snippetRaw)).replace(/\s+/g, ' ').trim() || undefined;

    if (title && url) {
      hits.push({ title, url, snippet, source: 'duckduckgo-html' });
    }
  }

  return hits;
}

function normalizeSearchResultUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  try {
    const url = new URL(rawUrl, 'https://duckduckgo.com');
    const u3 = url.searchParams.get('u3');
    if (u3) return decodeURIComponent(u3);
    const wrapped = url.searchParams.get('uddg');
    if (wrapped) return decodeURIComponent(wrapped);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
  } catch {
    // ignore parse failure
  }
  return rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
}

function formatSearchResults(backend: string, query: string, hits: SearchHit[]): string {
  if (hits.length === 0) {
    return `No search results found for "${query}".`;
  }

  const lines = [
    `Search backend: ${backend}`,
    `Query: ${query}`,
    '',
    'Top results:',
  ];

  hits.forEach((hit, index) => {
    lines.push(`[${index + 1}] ${hit.title}`);
    lines.push(`URL: ${hit.url}`);
    if (hit.snippet) lines.push(`Snippet: ${hit.snippet}`);
    if (hit.source) lines.push(`Source: ${hit.source}`);
    lines.push('');
  });

  return lines.join('\n').trim();
}

function dedupeSearchHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const deduped: SearchHit[] = [];

  for (const hit of hits) {
    if (!isUsefulSearchHit(hit)) continue;
    const key = createHash('sha1').update(hit.url.trim().toLowerCase()).digest('hex');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(hit);
  }

  return deduped;
}

function normalizeSearxngInstances(input: unknown): string[] {
  const configured = Array.isArray(input)
    ? input.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];
  return [...new Set([...configured, ...DEFAULT_SEARXNG_INSTANCES])];
}

function normalizeMaxResults(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 5;
  return Math.max(1, Math.min(10, Math.floor(parsed)));
}

function buildSearchCacheKey(provider: string, query: string, maxResults: number): string {
  return `${provider}::${maxResults}::${query.trim().toLowerCase()}`;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&nbsp;/g, ' ');
}

function isUsefulSearchHit(hit: SearchHit): boolean {
  const url = hit.url.trim().toLowerCase();
  if (!url) return false;
  if (url.includes('duckduckgo.com/duckduckgo-help-pages/')) return false;
  if (url.includes('bing.com/aclick')) return false;
  if ((hit.snippet ?? '').toLowerCase().includes('sponsored link')) return false;
  return /^https?:\/\//.test(url);
}

function isDuckDuckGoAdUrl(rawUrl: string): boolean {
  const lowered = decodeHtmlEntities(rawUrl).toLowerCase();
  return lowered.includes('duckduckgo.com/y.js?') || lowered.includes('ad_provider=');
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
