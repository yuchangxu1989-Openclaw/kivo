export default function UserUnderstandingPage() {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <p className="text-sm font-semibold text-slate-800">用户理解</p>
      <h1 className="mt-2 text-2xl font-black tracking-tight text-slate-950">KIVO 对你的理解</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
        这里展示从真实纠偏、偏好和决策里沉淀出的用户画像。数据接口接入后，只展示可追溯的事实，不放演示数据。
      </p>
      <div className="mt-6 rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">等待 /api/v1/user-understanding 接入。</div>
    </section>
  );
}
