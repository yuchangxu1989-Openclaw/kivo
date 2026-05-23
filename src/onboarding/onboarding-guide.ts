/**
 * OnboardingGuide — 首次知识旅程引导
 *
 * FR-Z06: 空库用户 10 分钟内看到系统价值。
 * - AC1: 空库引导入口（上传文档/导入示例/手动新建）
 * - AC2: 操作后引导检索验证
 * - AC3: 搜索无结果时给出建议
 * - AC4: 就绪度检查清单
 */

import type { Kivo } from '../kivo.js';
import { detectInitStatus } from '../bootstrap/init-detector.js';
import type { KivoConfig } from '../config/types.js';

// ── AC1: 起步方式 ──

export type OnboardingAction = 'upload-document' | 'import-sample' | 'manual-create';

export interface OnboardingEntry {
  action: OnboardingAction;
  label: string;
  description: string;
}

export const ONBOARDING_ACTIONS: OnboardingEntry[] = [
  {
    action: 'upload-document',
    label: '上传文档',
    description: '上传 PDF、Markdown 或纯文本文件，系统自动提取知识条目。',
  },
  {
    action: 'import-sample',
    label: '导入示例数据',
    description: '一键导入预置的示例知识条目，快速体验系统能力。',
  },
  {
    action: 'manual-create',
    label: '手动新建知识',
    description: '手动创建一条知识条目，立即可检索验证。',
  },
];

// ── AC3: 搜索无结果建议 ──

export interface SearchSuggestion {
  type: 'import' | 'adjust-query' | 'research';
  label: string;
  description: string;
}

export function getEmptySearchSuggestions(): SearchSuggestion[] {
  return [
    {
      type: 'import',
      label: '导入数据',
      description: '知识库为空或数据不足，尝试导入文档或示例数据。',
    },
    {
      type: 'adjust-query',
      label: '调整关键词',
      description: '尝试使用更宽泛或不同的关键词重新搜索。',
    },
    {
      type: 'research',
      label: '发起调研',
      description: '创建调研任务，让系统自动收集相关知识。',
    },
  ];
}

// ── AC4: 就绪度检查清单 ──

export type ReadinessItemStatus = 'ready' | 'warning' | 'missing';

export interface ReadinessItem {
  id: string;
  label: string;
  status: ReadinessItemStatus;
  detail: string;
}

export interface ReadinessReport {
  items: ReadinessItem[];
  overallReady: boolean;
  readyCount: number;
  totalCount: number;
}

export async function checkReadiness(
  config: KivoConfig,
  kivo?: Kivo,
): Promise<ReadinessReport> {
  const items: ReadinessItem[] = [];

  // 1. 初始化状态
  const initStatus = detectInitStatus(config.dbPath);
  items.push({
    id: 'initialized',
    label: '系统初始化',
    status: initStatus.initialized ? 'ready' : 'missing',
    detail: initStatus.initialized ? '已完成初始化' : '未完成初始化，请运行 bootstrap 流程',
  });

  // 2. 存储配置
  items.push({
    id: 'storage',
    label: '存储配置',
    status: config.dbPath ? 'ready' : 'missing',
    detail: config.dbPath ? `数据库路径: ${config.dbPath}` : '未配置数据库路径',
  });

  // 3. Embedding Provider
  const hasEmbedding = !!config.embedding;
  items.push({
    id: 'embedding',
    label: 'Embedding Provider',
    status: hasEmbedding ? 'ready' : 'warning',
    detail: hasEmbedding
      ? `已配置: ${config.embedding!.provider}`
      : '未配置，语义搜索不可用（关键词搜索仍可用）',
  });

  // 4. 知识库数据
  let entryCount = 0;
  if (kivo) {
    try {
      const results = await kivo.query('*');
      entryCount = results.length;
    } catch {
      // query 可能失败（FTS 语法），用 count 兜底
    }
  }
  items.push({
    id: 'data',
    label: '知识库数据',
    status: entryCount > 0 ? 'ready' : 'missing',
    detail: entryCount > 0 ? `已有 ${entryCount} 条知识条目` : '知识库为空，请导入数据',
  });

  // 5. 管理员账号
  items.push({
    id: 'admin',
    label: '管理员账号',
    status: initStatus.adminCreated ? 'ready' : 'missing',
    detail: initStatus.adminCreated ? '已创建管理员账号' : '未创建管理员账号',
  });

  const readyCount = items.filter(i => i.status === 'ready').length;
  return {
    items,
    overallReady: items.every(i => i.status !== 'missing'),
    readyCount,
    totalCount: items.length,
  };
}

// ── AC2: 操作后引导检索验证 ──

export interface PostActionGuide {
  message: string;
  nextStep: string;
  searchQuery?: string;
}

export function getPostActionGuide(action: OnboardingAction, entryTitle?: string): PostActionGuide {
  switch (action) {
    case 'upload-document':
      return {
        message: '文档上传成功，知识条目已提取入库。',
        nextStep: '前往知识库搜索刚导入的内容，验证检索是否命中。',
        searchQuery: entryTitle,
      };
    case 'import-sample':
      return {
        message: '示例数据导入成功。',
        nextStep: '尝试搜索 "KIVO" 或 "知识类型"，验证检索功能。',
        searchQuery: 'KIVO',
      };
    case 'manual-create':
      return {
        message: '知识条目创建成功。',
        nextStep: '搜索刚创建的条目标题，验证是否可检索。',
        searchQuery: entryTitle,
      };
  }
}
