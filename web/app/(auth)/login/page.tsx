'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/client-api';

interface LoginResponse {
  ok: boolean;
}

const FEATURES = [
  { icon: '⟳', title: '自主进化', desc: '知识自动迭代更新，Agent 持续学习成长', color: 'text-cyan-400' },
  { icon: '🧠', title: '意图增强', desc: '深度理解用户意图，精准匹配知识上下文', color: 'text-purple-400' },
  { icon: '🔍', title: '语义搜索', desc: '基于 BGE 向量模型的高精度语义检索', color: 'text-cyan-400' },
  { icon: '⑆', title: '知识图谱', desc: '结构化知识网络，实现关联推理与发现', color: 'text-purple-400' },
];

const MARQUEE_ITEMS = [
  '基于 Karpathy LLM Wiki 最佳实践',
  '覆盖知识完整生命周期',
  '多源知识提取',
  '语义检索（BGE Embedding）',
  '知识迭代',
  '意图理解增强',
  '知识图谱',
  '15个功能域',
];

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [identity, setIdentity] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const data = await apiFetch<LoginResponse>('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, identity: identity.trim() }),
      });

      if (data.ok) {
        router.push('/dashboard');
        router.refresh();
        return;
      }
      setError('密码错误，请检查后重试');
    } catch {
      setError('密码错误或网络异常，请重试');
    } finally {
      setLoading(false);
    }
  }

  const marqueeText = MARQUEE_ITEMS.join('  ·  ');

  return (
    <div className="relative min-h-screen bg-[#0a0e1a] text-slate-300 overflow-hidden">
      {/* CSS Particles */}
      <style jsx>{`
        @keyframes particle-float-1 {
          0%, 100% { transform: translate(0, 0); opacity: 0.2; }
          25% { transform: translate(80px, -120px); opacity: 0.4; }
          50% { transform: translate(-40px, -200px); opacity: 0.15; }
          75% { transform: translate(60px, -80px); opacity: 0.35; }
        }
        @keyframes particle-float-2 {
          0%, 100% { transform: translate(0, 0); opacity: 0.15; }
          33% { transform: translate(-100px, -150px); opacity: 0.3; }
          66% { transform: translate(50px, -250px); opacity: 0.1; }
        }
        @keyframes particle-float-3 {
          0%, 100% { transform: translate(0, 0); opacity: 0.25; }
          50% { transform: translate(120px, -180px); opacity: 0.1; }
        }
        @keyframes marquee-scroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .particle {
          position: absolute;
          border-radius: 50%;
          background: rgba(103, 232, 249, 0.3);
          pointer-events: none;
        }
        .marquee-track {
          animation: marquee-scroll 30s linear infinite;
        }
        .marquee-track:hover {
          animation-play-state: paused;
        }
        .glass-card {
          background: rgba(255, 255, 255, 0.04);
          backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.08);
          transition: all 0.3s ease;
        }
        .glass-card:hover {
          background: rgba(255, 255, 255, 0.07);
          border-color: rgba(139, 92, 246, 0.3);
          transform: translateY(-4px);
          box-shadow: 0 8px 32px rgba(139, 92, 246, 0.1);
        }
        .input-cyber:focus {
          border-color: rgba(103, 232, 249, 0.5);
          box-shadow: 0 0 12px rgba(103, 232, 249, 0.1);
        }
        .neon-line {
          height: 1px;
          background: linear-gradient(90deg, transparent, rgba(103, 232, 249, 0.3), rgba(139, 92, 246, 0.3), transparent);
        }
      `}</style>

      {/* Particle elements */}
      <div className="fixed inset-0 z-0 pointer-events-none overflow-hidden" aria-hidden="true">
        {[
          { w: 3, left: '10%', top: '80%', anim: 'particle-float-1', dur: '12s', delay: '0s' },
          { w: 2, left: '20%', top: '70%', anim: 'particle-float-2', dur: '18s', delay: '2s' },
          { w: 4, left: '35%', top: '90%', anim: 'particle-float-3', dur: '15s', delay: '1s' },
          { w: 2, left: '50%', top: '85%', anim: 'particle-float-1', dur: '20s', delay: '4s' },
          { w: 3, left: '65%', top: '75%', anim: 'particle-float-2', dur: '14s', delay: '3s' },
          { w: 2, left: '80%', top: '95%', anim: 'particle-float-3', dur: '16s', delay: '5s' },
          { w: 3, left: '90%', top: '60%', anim: 'particle-float-1', dur: '22s', delay: '1s' },
          { w: 2, left: '5%', top: '50%', anim: 'particle-float-2', dur: '19s', delay: '6s' },
          { w: 4, left: '45%', top: '65%', anim: 'particle-float-1', dur: '17s', delay: '2s' },
          { w: 2, left: '75%', top: '45%', anim: 'particle-float-3', dur: '21s', delay: '4s' },
          { w: 3, left: '25%', top: '40%', anim: 'particle-float-2', dur: '13s', delay: '7s' },
          { w: 2, left: '55%', top: '30%', anim: 'particle-float-1', dur: '16s', delay: '3s' },
        ].map((p, i) => (
          <div
            key={i}
            className="particle"
            style={{
              width: p.w,
              height: p.w,
              left: p.left,
              top: p.top,
              animation: `${p.anim} ${p.dur} ease-in-out infinite`,
              animationDelay: p.delay,
            }}
          />
        ))}
      </div>

      {/* Main content */}
      <div className="relative z-10 min-h-screen flex flex-col">
        {/* Main area */}
        <main className="flex-1 flex flex-col lg:flex-row items-center lg:items-start gap-10 lg:gap-16 px-4 sm:px-6 md:px-12 lg:px-20 py-8 lg:py-16 max-w-7xl mx-auto w-full">
          {/* Left: Product intro - hidden on small screens */}
          <div className="hidden md:flex flex-1 flex-col space-y-6 max-w-2xl">
            <h1
              className="text-5xl md:text-6xl font-bold tracking-tight text-[#f0fdfa]"
              style={{ textShadow: '0 0 20px rgba(103,232,249,0.15), 0 0 40px rgba(103,232,249,0.05)' }}
            >
              KIVO
            </h1>
            <p className="text-xl md:text-2xl text-slate-200 font-medium">
              Agent 知识平台 — <span className="text-cyan-300">让 AI 越用越懂你</span>
            </p>
            <p className="text-sm text-slate-300">
              由 <span className="text-white font-medium">于长煦</span> 开发 &nbsp;|&nbsp; Self-Evolving Harness 三件套（
              <span className="text-cyan-300">KIVO</span> · <span className="text-purple-300">SEVO</span> · <span className="text-purple-300">AEO</span>）
            </p>
            <p className="text-base text-slate-200 font-semibold">
              提升 <span className="text-cyan-300">OpenClaw</span> Agent 的可控性与自主进化力
            </p>

            {/* Marquee */}
            <div className="overflow-hidden rounded-lg py-2 relative">
              <div className="neon-line mb-2" />
              <div className="flex whitespace-nowrap text-xs text-slate-400 overflow-hidden">
                <div className="marquee-track flex gap-6">
                  {[...MARQUEE_ITEMS, ...MARQUEE_ITEMS].map((item, i) => (
                    <span key={i}>
                      {item.includes('Karpathy') || item.includes('BGE') ? (
                        <span>
                          {item.split(/(Karpathy LLM Wiki|BGE)/).map((part, j) =>
                            part === 'Karpathy LLM Wiki' || part === 'BGE' ? (
                              <span key={j} className="text-white">{part}</span>
                            ) : (
                              <span key={j}>{part}</span>
                            )
                          )}
                        </span>
                      ) : item.includes('15') ? (
                        <span className="text-cyan-300">{item}</span>
                      ) : (
                        item
                      )}
                      {i < MARQUEE_ITEMS.length * 2 - 1 && <span className="ml-6">·</span>}
                    </span>
                  ))}
                </div>
              </div>
              <div className="neon-line mt-2" />
            </div>

            {/* Feature cards */}
            <div className="grid grid-cols-2 gap-3">
              {FEATURES.map((f, i) => (
                <div key={i} className="glass-card rounded-xl p-4 cursor-pointer">
                  <span className={`text-lg ${f.color} mb-2 block`}>{f.icon}</span>
                  <h3 className="text-white font-semibold text-sm mb-1">{f.title}</h3>
                  <p className="text-xs text-slate-400 leading-relaxed">{f.desc}</p>
                </div>
              ))}
            </div>

            {/* Install command */}
            <div className="glass-card rounded-lg p-3 flex items-center gap-3 !transform-none !shadow-none hover:!transform-none">
              <span className="text-cyan-400 shrink-0 text-sm">$</span>
              <code className="text-xs text-slate-300 flex-1 overflow-x-auto">
                npm install @self-evolving-harness/kivo && kivo init
              </code>
            </div>

            {/* Contact */}
            <div className="flex items-center gap-4 text-xs text-slate-500 pt-2">
              <a href="mailto:yuchangxu1989@gmail.com" className="hover:text-slate-300 transition flex items-center gap-1">
                ✉ yuchangxu1989@gmail.com
              </a>
              <a
                href="https://github.com/yuchangxu1989-Openclaw/kivo"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-slate-300 transition flex items-center gap-1"
              >
                GitHub
              </a>
            </div>
          </div>

          {/* Right: Login form */}
          <div className="w-full md:w-96 shrink-0 flex flex-col items-center md:items-stretch">
            {/* Mobile-only title */}
            <div className="md:hidden text-center mb-6">
              <h1
                className="text-3xl font-bold tracking-tight text-[#f0fdfa] mb-2"
                style={{ textShadow: '0 0 20px rgba(103,232,249,0.15)' }}
              >
                KIVO
              </h1>
              <p className="text-sm text-slate-400">Agent 知识平台</p>
            </div>

            <div
              className="w-full min-w-[320px] max-w-[400px] rounded-2xl p-7 space-y-5"
              style={{
                background: 'rgba(255,255,255,0.04)',
                backdropFilter: 'blur(16px)',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <div className="text-center">
                <h2 className="text-xl font-semibold text-white mb-1">登录 KIVO</h2>
                <p className="text-sm text-slate-400">进入你的知识空间</p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="identity-field" className="text-xs text-slate-400 mb-1 block">
                    用户名
                  </label>
                  <input
                    id="identity-field"
                    type="text"
                    placeholder="请输入用户名"
                    value={identity}
                    onChange={(e) => setIdentity(e.target.value)}
                    autoComplete="username"
                    className="input-cyber w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition"
                  />
                </div>

                <div>
                  <label htmlFor="access-password" className="text-xs text-slate-400 mb-1 block">
                    密码
                  </label>
                  <input
                    id="access-password"
                    type="password"
                    placeholder="请输入密码"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? 'login-error' : undefined}
                    className="input-cyber w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition"
                  />
                </div>

                {error && (
                  <div id="login-error" aria-live="polite" className="text-sm text-red-400">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading || !password}
                  className="w-full py-2.5 rounded-lg bg-gradient-to-r from-cyan-600 to-purple-600 hover:from-cyan-500 hover:to-purple-500 active:scale-[0.98] text-white font-medium text-sm transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? '登录中...' : '登 录'}
                </button>
              </form>
            </div>
          </div>
        </main>

        {/* Footer */}
        <footer className="px-6 py-4 text-center text-xs text-slate-600 border-t border-white/5">
          Powered by <span className="text-slate-400">Self-Evolving Harness</span>
        </footer>
      </div>
    </div>
  );
}
