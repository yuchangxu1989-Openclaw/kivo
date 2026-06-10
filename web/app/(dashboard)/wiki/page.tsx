import Link from 'next/link';
import { Search } from 'lucide-react';
import { slugify } from '@kivo/wiki/admission-pipeline';
import type { WikiEntryRecord } from '@kivo/wiki/index';
import { getWikiRepository } from '@/lib/wiki-engine';

type WikiPageSearchParams = {
  q?: string | string[];
};

function getSearchValue(searchParams?: WikiPageSearchParams | Promise<WikiPageSearchParams | undefined>): Promise<string> {
  return Promise.resolve(searchParams).then((params) => {
    const raw = params?.q;
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === 'string' ? value.trim() : '';
  });
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*]\([^)]*\)/g, (match) => match.replace(/^\[|\]\([^)]*\)$/g, ''))
    .replace(/[#>*_`~|[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildDescription(page: WikiEntryRecord): string {
  const summary = stripMarkdown(page.summary);
  if (summary) return summary;
  const content = stripMarkdown(page.content);
  return content || '暂无描述';
}

function getPageSlug(page: WikiEntryRecord): string {
  const extra = page.metadata.extra ?? {};
  const rawSlug = extra.slug ?? extra.aggregateSlug;
  return typeof rawSlug === 'string' && rawSlug.trim() ? rawSlug : slugify(page.title);
}

function getVisiblePages(pages: WikiEntryRecord[], query: string): WikiEntryRecord[] {
  if (!query) return pages;
  const normalized = query.toLowerCase();
  return pages.filter((page) => {
    const text = [page.title, page.summary, page.content, ...page.tags].join(' ').toLowerCase();
    return text.includes(normalized);
  });
}

export default async function WikiPage({
  searchParams,
}: {
  searchParams?: WikiPageSearchParams | Promise<WikiPageSearchParams | undefined>;
}) {
  const query = await getSearchValue(searchParams);
  const repo = getWikiRepository();
  const pages = getVisiblePages(repo.listAllPages(), query);

  return (
    <main className="min-h-screen bg-white px-4 py-8 text-black md:px-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight text-black">领域 wiki</h1>
          <p className="text-sm text-slate-600">共 {pages.length} 条知识</p>
        </header>

        <form action="/kivo/wiki" className="relative max-w-2xl">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            aria-label="搜索 wiki 知识"
            name="q"
            type="search"
            defaultValue={query}
            placeholder="搜索标题或描述"
            className="h-11 w-full rounded-md border border-slate-300 bg-white pl-10 pr-3 text-sm text-black outline-none transition-colors placeholder:text-slate-400 focus:border-slate-700"
          />
        </form>

        {pages.length === 0 ? (
          <section className="rounded-md border border-slate-200 bg-white px-5 py-10 text-sm text-slate-600">
            {query ? `没有找到与“${query}”相关的知识。` : '暂无 wiki 知识。'}
          </section>
        ) : (
          <section className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
            {pages.map((page) => {
              const href = `/wiki/${encodeURIComponent(getPageSlug(page))}`;
              const description = buildDescription(page);

              const row = (
                <div className="grid gap-2 px-4 py-4 transition-colors hover:bg-slate-50 md:grid-cols-[minmax(0,1fr)_170px] md:items-center">
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-medium text-black">{page.title}</h2>
                    <p className="mt-1 truncate text-sm text-slate-600">{description}</p>
                  </div>
                  <time className="text-sm text-slate-500 md:text-right" dateTime={page.createdAt}>
                    {formatDate(page.createdAt)}
                  </time>
                </div>
              );

              return (
                <Link key={page.id} href={href} className="block focus:outline-none focus:ring-2 focus:ring-slate-700 focus:ring-offset-2">
                  {row}
                </Link>
              );
            })}
          </section>
        )}
      </div>
    </main>
  );
}
