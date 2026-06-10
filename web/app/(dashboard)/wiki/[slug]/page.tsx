import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ContentRenderer } from '@/components/wiki/content-renderer';
import { getWikiPageDetailBySlug } from '@/lib/wiki-pages';

export default async function WikiFlatPage(
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const detail = getWikiPageDetailBySlug(slug);
  if (!detail) notFound();

  const sourceRefs = Array.isArray(detail.page.metadata.extra?.sourceRefs)
    ? detail.page.metadata.extra?.sourceRefs as Array<{ label?: string; uri?: string }>
    : [];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 text-black md:px-6">
      <div className="rounded-md border border-slate-200 bg-white p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.26em] text-slate-500">Wiki</p>
        <h1 className="mt-3 text-3xl font-semibold text-black">{detail.page.title}</h1>
        <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">{detail.page.summary}</p>
        <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-600">
          <span className="rounded-md border border-slate-200 bg-white px-3 py-1">版本 {detail.page.version}</span>
          <span className="rounded-md border border-slate-200 bg-white px-3 py-1">来源 {detail.sourcePages.length}</span>
          <span className="rounded-md border border-slate-200 bg-white px-3 py-1">链接 {detail.outgoingLinks.length}</span>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <article className="rounded-md border border-slate-200 bg-white p-6">
          <ContentRenderer content={detail.page.content} sourceRefs={sourceRefs} />
        </article>

        <aside className="space-y-6">
          <section className="rounded-md border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-black">来源溯源</h2>
            <div className="mt-4 space-y-3">
              {detail.sourcePages.length === 0 ? (
                <p className="text-xs text-slate-500">暂无来源页面。</p>
              ) : detail.sourcePages.map((page) => (
                <div key={page.id} className="rounded-md border border-slate-100 bg-white px-4 py-3">
                  <p className="text-sm font-medium text-black">{page.title}</p>
                  <p className="mt-1 text-xs leading-6 text-slate-600">{page.summary}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-md border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-black">历史版本</h2>
            <div className="mt-4 space-y-3">
              {detail.versions.length === 0 ? (
                <p className="text-xs text-slate-500">当前只有首版内容。</p>
              ) : detail.versions.map((version) => (
                <div key={version.id} className="rounded-md border border-slate-100 px-4 py-3">
                  <p className="text-sm font-medium text-black">v{version.version}</p>
                  <p className="mt-1 text-xs text-slate-500">{version.createdAt}</p>
                  <p className="mt-2 text-xs leading-6 text-slate-600">{version.summary}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-md border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-black">关联链接</h2>
            <div className="mt-4 space-y-3">
              {detail.outgoingLinks.length === 0 ? (
                <p className="text-xs text-slate-500">当前没有解析出的 wiki 链接。</p>
              ) : detail.outgoingLinks.map((link, index) => (
                <div key={`${link.targetTitle}-${index}`} className="rounded-md border border-slate-100 px-4 py-3">
                  <p className="text-sm font-medium text-black">{link.targetTitle}</p>
                  <p className="mt-1 text-xs text-slate-500">{link.label}</p>
                </div>
              ))}
            </div>
            <Link href="/wiki" className="mt-4 inline-flex text-xs font-medium text-slate-700 hover:text-black">
              返回 Wiki
            </Link>
          </section>
        </aside>
      </div>
    </div>
  );
}
