import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ContentRenderer } from '@/components/wiki/content-renderer';
import { getWikiPageDetailBySlug } from '@/lib/wiki-pages';

export default async function WikiAggregatePage(
  { params }: { params: Promise<{ space: string; slug: string }> },
) {
  const { space, slug } = await params;
  const detail = getWikiPageDetailBySlug(slug, space);
  if (!detail) notFound();

  const sourceRefs = Array.isArray(detail.page.metadata.extra?.sourceRefs)
    ? detail.page.metadata.extra?.sourceRefs as Array<{ label?: string; uri?: string }>
    : [];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 md:px-6">
      <div className="rounded-3xl border border-slate-200 bg-gradient-to-br from-amber-50 via-white to-cyan-50 p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.26em] text-slate-500">{space} / Wiki</p>
        <h1 className="mt-3 text-3xl font-semibold text-slate-950">{detail.page.title}</h1>
        <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">{detail.page.summary}</p>
        <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-500">
          <span className="rounded-full bg-white px-3 py-1">版本 {detail.page.version}</span>
          <span className="rounded-full bg-white px-3 py-1">来源 {detail.sourcePages.length}</span>
          <span className="rounded-full bg-white px-3 py-1">链接 {detail.outgoingLinks.length}</span>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <ContentRenderer content={detail.page.content} sourceRefs={sourceRefs} />
        </article>

        <aside className="space-y-6">
          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-950">来源溯源</h2>
            <div className="mt-4 space-y-3">
              {detail.sourcePages.map((page) => (
                <div key={page.id} className="rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3">
                  <p className="text-sm font-medium text-slate-900">{page.title}</p>
                  <p className="mt-1 text-xs leading-6 text-slate-600">{page.summary}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-950">历史版本</h2>
            <div className="mt-4 space-y-3">
              {detail.versions.length === 0 ? (
                <p className="text-xs text-slate-500">当前只有首版聚合内容，下一次聚合后这里会记录历史快照。</p>
              ) : detail.versions.map((version) => (
                <div key={version.id} className="rounded-2xl border border-slate-100 px-4 py-3">
                  <p className="text-sm font-medium text-slate-900">v{version.version}</p>
                  <p className="mt-1 text-xs text-slate-500">{version.createdAt}</p>
                  <p className="mt-2 text-xs leading-6 text-slate-600">{version.summary}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-950">关联链接</h2>
            <div className="mt-4 space-y-3">
              {detail.outgoingLinks.length === 0 ? (
                <p className="text-xs text-slate-500">当前没有解析出的 wiki_links。</p>
              ) : detail.outgoingLinks.map((link, index) => (
                <div key={`${link.targetTitle}-${index}`} className="rounded-2xl border border-slate-100 px-4 py-3">
                  <p className="text-sm font-medium text-slate-900">{link.targetTitle}</p>
                  <p className="mt-1 text-xs text-slate-500">{link.label}</p>
                </div>
              ))}
            </div>
            <Link href="/wiki" className="mt-4 inline-flex text-xs font-medium text-cyan-700 hover:text-cyan-900">
              返回 Wiki 空间
            </Link>
          </section>
        </aside>
      </div>
    </div>
  );
}
