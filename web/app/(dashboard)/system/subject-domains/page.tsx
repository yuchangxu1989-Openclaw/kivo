export default function SubjectDomainsPage() {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <p className="text-sm font-semibold text-slate-800">学科域管理</p>
      <h1 className="mt-2 text-2xl font-black tracking-tight text-slate-950">管理学科域</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
        这里承接学科域重命名、合并、拆分和别名管理。B1-B5 API 接入后再注入真实树和操作表单。
      </p>
      <div className="mt-6 rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">等待 subjects API 接入。</div>
    </section>
  );
}
