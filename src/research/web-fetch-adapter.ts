/**
 * WebFetchAdapter — 用 Node.js 原生 fetch 抓取 URL 并提取文本。
 * 实现 ResearchExecutorAdapter 接口，可直接注入 ResearchExecutor。
 *
 * 支持的 step.method: 'web_search'（将 query 视为 URL）、'document_read'。
 * 不支持的 method 返回空 artifacts。
 */

import type { ResearchExecutorAdapter } from './research-executor.js';
import type { ResearchStep, ResearchStepResult, ResearchTask, ResearchArtifact } from './research-task-types.js';

/**
 * 宿主环境 web search 回调返回的单条搜索结果。
 * 宿主可对接 Tavily、Bing、Google 等任意搜索后端。
 */
export interface WebSearchResult {
  url: string;
  title: string;
  content: string;
}

export interface WebFetchAdapterOptions {
  /** fetch 超时毫秒数，默认 10_000 */
  timeoutMs?: number;
  /** 自定义 User-Agent */
  userAgent?: string;
  /** 可注入自定义 fetch 实现（测试用） */
  fetchFn?: typeof globalThis.fetch;
  /**
   * 宿主环境提供的 web search 回调。
   * 当 step.method 为 'web_search' 且 query 中不含 URL 时调用。
   * 未提供时，自然语言查询将返回空结果。
   */
  searchFn?: (query: string, limit: number) => Promise<WebSearchResult[]>;
}

export class WebFetchAdapter implements ResearchExecutorAdapter {
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly searchFn?: (query: string, limit: number) => Promise<WebSearchResult[]>;

  constructor(options: WebFetchAdapterOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.userAgent = options.userAgent ?? 'KIVO-WebFetchAdapter/1.0';
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.searchFn = options.searchFn;
  }

  async execute(step: ResearchStep, task: ResearchTask): Promise<ResearchStepResult> {
    const urls = extractUrls(step.query);

    // 自然语言查询（无 URL）且宿主提供了 searchFn → 委托宿主搜索
    if (urls.length === 0 && step.method === 'web_search' && this.searchFn) {
      return this.executeHostSearch(step, task);
    }

    if (urls.length === 0) {
      return { artifacts: [], apiCallsUsed: 0 };
    }

    const artifacts: ResearchArtifact[] = [];
    let apiCalls = 0;
    const limit = step.limit ?? urls.length;

    for (const url of urls.slice(0, limit)) {
      apiCalls++;
      try {
        const text = await this.fetchAndExtract(url);
        if (text.length > 0) {
          artifacts.push({
            id: `webfetch-${task.id}-${artifacts.length}`,
            method: step.method,
            title: titleFromUrl(url),
            content: text,
            reference: url,
            metadata: { fetchedAt: new Date().toISOString(), contentLength: text.length },
          });
        }
      } catch {
        // 单个 URL 失败不阻断整个步骤
      }
    }

    return { artifacts, apiCallsUsed: apiCalls };
  }

  /**
   * 通过宿主 searchFn 执行 web search，将结果转为 ResearchArtifact。
   */
  private async executeHostSearch(step: ResearchStep, task: ResearchTask): Promise<ResearchStepResult> {
    const limit = step.limit ?? 5;
    const results = await this.searchFn!(step.query, limit);

    const artifacts: ResearchArtifact[] = results.map((r, i) => ({
      id: `search-${task.id}-${i}`,
      method: step.method,
      title: r.title,
      content: r.content,
      reference: r.url,
      metadata: { searchQuery: step.query },
    }));

    return { artifacts, apiCallsUsed: 1 };
  }

  /** 抓取 URL 并提取纯文本 */
  private async fetchAndExtract(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(url, {
        signal: controller.signal,
        headers: { 'User-Agent': this.userAgent, Accept: 'text/html, text/plain, */*' },
        redirect: 'follow',
      });

      if (!response.ok) {
        return '';
      }

      const contentType = response.headers.get('content-type') ?? '';
      const body = await response.text();

      if (contentType.includes('text/html')) {
        return extractTextFromHtml(body);
      }
      // plain text / markdown / json — 直接返回
      return body.slice(0, 100_000);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────

/** 从查询字符串中提取所有 URL */
export function extractUrls(query: string): string[] {
  const urlPattern = /https?:\/\/[^\s"'<>)\]]+/g;
  const matches = query.match(urlPattern);
  return matches ? [...new Set(matches)] : [];
}

/** 从 HTML 中提取可读文本（轻量实现，无外部依赖） */
export function extractTextFromHtml(html: string): string {
  let text = html;

  // 移除 script / style / noscript 块
  text = text.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');

  // 移除 HTML 注释
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // 块级标签转换行
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br|hr|blockquote|pre|section|article|header|footer|nav|aside|main)[^>]*>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // 移除所有剩余标签
  text = text.replace(/<[^>]+>/g, '');

  // 解码常见 HTML 实体
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));

  // 压缩空白
  text = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');

  return text.slice(0, 100_000);
}

/** 从 URL 生成简短标题 */
function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, '');
    const last = path.split('/').pop();
    return last ? decodeURIComponent(last).replace(/[-_]/g, ' ') : u.hostname;
  } catch {
    return url.slice(0, 60);
  }
}
