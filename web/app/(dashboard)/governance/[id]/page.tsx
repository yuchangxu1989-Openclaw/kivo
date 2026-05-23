import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Calendar, CheckCircle2, FileText, GitCompareArrows, Shield } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type ReportStatus = 'completed' | 'in_progress' | 'archived' | 'partial_failure';
type ReportType = 'staleness' | 'aggregation' | 'auto-govern';

interface GovernanceReportDetail {
  id: string;
  title: string;
  summary: string;
  type: ReportType;
  status: ReportStatus;
  issuesFound: number;
  issuesResolved: number;
  createdAt: string;
  items: GovernanceReportItem[];
}

interface GovernanceReportItem {
  id: string;
  title: string;
  operationType: string;
  before: string;
  after: string;
}

interface GovernanceReportRow {
  id: string;
  type: string;
  payload_json: string;
  processed_count: number;
  status: string;
  created_at: string;
}

interface GovernanceSnapshotRow {
  operation_id: string;
  operation_type: string;
  before_state_json: string;
  after_state_json: string | null;
  created_at: string;
}

const STATUS_LABELS: Record<string, string> = {
  completed: '已完成',
  in_progress: '进行中',
  archived: '已归档',
  partial_failure: '部分失败',
};

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  completed: 'default',
  in_progress: 'secondary',
  archived: 'outline',
  partial_failure: 'destructive',
};

const TYPE_LABELS: Record<string, string> = {
  staleness: '过期检查',
  aggregation: '碎片聚合',
  'auto-govern': '自动治理',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function summarizeState(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return '无';
  }

  const record = value as Record<string, unknown>;
  const title = record.title ?? record.name ?? record.id;
  const description = record.summary ?? record.description ?? record.content;
  const segments: string[] = [];

  if (typeof title === 'string' && title.trim()) {
    segments.push(title.trim());
  }
  if (typeof description === 'string' && description.trim()) {
    segments.push(description.trim());
  }
  if (typeof record.governanceStatus === 'string') {
    segments.push(`状态：${record.governanceStatus}`);
  }
  if (typeof record.weight === 'number') {
    segments.push(`权重：${record.weight}`);
  }

  return segments.join(' | ') || JSON.stringify(value);
}

function parseReportItems(payload: unknown, snapshots: GovernanceSnapshotRow[]): GovernanceReportItem[] {
  const items: GovernanceReportItem[] = [];
  const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};

  if (Array.isArray(data.actions)) {
    for (const action of data.actions) {
      if (!action || typeof action !== 'object') continue;
      const record = action as Record<string, unknown>;
      items.push({
        id: String(record.entryId ?? record.id ?? crypto.randomUUID()),
        title: String(record.entryTitle ?? record.title ?? record.entryId ?? '未命名条目'),
        operationType: String(record.actionType ?? record.type ?? 'governance'),
        before: typeof record.reason === 'string' ? record.reason : '治理前状态未记录',
        after: typeof record.message === 'string' ? record.message : '治理后状态未记录',
      });
    }
  }

  if (items.length === 0 && Array.isArray(data.topRiskEntries)) {
    for (const entry of data.topRiskEntries) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      items.push({
        id: String(record.id ?? crypto.randomUUID()),
        title: String(record.title ?? record.id ?? '未命名条目'),
        operationType: 'risk_review',
        before: `置信度：${String(record.confidence ?? '未知')}`,
        after: `当前状态：${String(record.status ?? '未知')}`,
      });
    }
  }

  if (items.length === 0) {
    for (const snapshot of snapshots) {
      const beforeState = safeJsonParse(snapshot.before_state_json);
      const afterState = safeJsonParse(snapshot.after_state_json);
      const beforeItems = Array.isArray(beforeState) ? beforeState : [];
      const afterRecord = afterState && typeof afterState === 'object' ? afterState as Record<string, unknown> : null;

      for (const entry of beforeItems) {
        items.push({
          id: String((entry as Record<string, unknown>).id ?? snapshot.operation_id),
          title: String((entry as Record<string, unknown>).title ?? (entry as Record<string, unknown>).name ?? '未命名条目'),
          operationType: snapshot.operation_type,
          before: summarizeState(entry),
          after: afterRecord?.resultId ? `结果条目：${String(afterRecord.resultId)}` : '治理后状态未记录',
        });
      }
    }
  }

  return items;
}

function safeJsonParse(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function seedReport(id: string): GovernanceReportDetail | null {
  const now = Date.now();
  const reports: GovernanceReportDetail[] = [
    {
      id: 'rpt-1',
      title: '意图覆盖度周报 #12',
      summary: '本周新增 8 条意图，覆盖率提升至 78%。发现 3 条重复意图待合并。',
      type: 'staleness',
      status: 'completed',
      issuesFound: 5,
      issuesResolved: 4,
      createdAt: new Date(now - 86400_000).toISOString(),
      items: [
        { id: 'seed-1', title: 'API 设计规范', operationType: 'staleness_flagged', before: '最近 30 天未被命中', after: '已标记为待复核' },
        { id: 'seed-2', title: '数据库优化', operationType: 'value_decay', before: '权重偏高且近一周无新增证据', after: '已下调权重并保留活跃状态' },
      ],
    },
    {
      id: 'rpt-2',
      title: '冲突意图清理报告',
      summary: '清理 12 条过期意图，合并 4 组语义重复意图。',
      type: 'aggregation',
      status: 'completed',
      issuesFound: 16,
      issuesResolved: 16,
      createdAt: new Date(now - 3 * 86400_000).toISOString(),
      items: [
        { id: 'seed-3', title: '中文注释', operationType: 'merge', before: '候选 A：中文注释 | 候选 B：中文注释规范', after: '已合并为统一规范条目' },
      ],
    },
  ];

  return reports.find((report) => report.id === id) ?? null;
}

async function loadReport(id: string): Promise<GovernanceReportDetail | null> {
  try {
    const Database = (await import('better-sqlite3')).default;
    const path = await import('path');
    const dbPath = process.env.KIVO_DB_PATH || path.resolve(process.cwd(), '../kivo.db');
    const db = new Database(dbPath, { readonly: true });

    const tableExists = db.prepare(
      "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='governance_reports'"
    ).get() as { cnt: number };

    if (tableExists.cnt === 0) {
      db.close();
      return seedReport(id);
    }

    const row = db.prepare(
      'SELECT id, type, payload_json, processed_count, status, created_at FROM governance_reports WHERE id = ?'
    ).get(id) as GovernanceReportRow | undefined;

    if (!row) {
      db.close();
      return seedReport(id);
    }

    const snapshots = db.prepare(
      `SELECT operation_id, operation_type, before_state_json, after_state_json, created_at
       FROM governance_snapshots
       WHERE ABS(strftime('%s', created_at) - strftime('%s', ?)) <= 600
       ORDER BY created_at DESC
       LIMIT 20`
    ).all(row.created_at) as GovernanceSnapshotRow[];

    db.close();

    const payload = safeJsonParse(row.payload_json);
    const payloadRecord = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const issuesFound = Number(payloadRecord.pendingMaterials ?? payloadRecord.totalScanned ?? row.processed_count ?? 0);
    const issuesResolved = Number(payloadRecord.knowledgeWritten ?? payloadRecord.materialsConsumed ?? row.processed_count ?? 0);
    const items = parseReportItems(payload, snapshots);

    return {
      id: row.id,
      title: typeof payloadRecord.title === 'string' ? payloadRecord.title : `${TYPE_LABELS[row.type] ?? row.type} 报告`,
      summary: typeof payloadRecord.summary === 'string'
        ? payloadRecord.summary
        : `处理 ${issuesResolved} 项，状态：${STATUS_LABELS[row.status] ?? row.status}`,
      type: (row.type as ReportType) ?? 'auto-govern',
      status: (row.status as ReportStatus) ?? 'completed',
      issuesFound,
      issuesResolved,
      createdAt: row.created_at,
      items,
    };
  } catch {
    return seedReport(id);
  }
}

export default async function GovernanceReportDetailPage(
  props: { params: Promise<{ id: string }> }
) {
  const { id } = await props.params;
  const report = await loadReport(id);

  if (!report) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight text-slate-900">{report.title}</h1>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{report.summary}</p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/governance">
            <ArrowLeft className="mr-2 h-4 w-4" />
            返回列表
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <Badge variant={STATUS_VARIANT[report.status] ?? 'outline'}>
          {STATUS_LABELS[report.status] ?? report.status}
        </Badge>
        <Badge variant="outline">{TYPE_LABELS[report.type] ?? report.type}</Badge>
        <span className="inline-flex items-center gap-1.5">
          <Calendar className="h-4 w-4" />
          {formatDate(report.createdAt)}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <FileText className="h-4 w-4" />
          发现 {report.issuesFound} 项
        </span>
        <span className="inline-flex items-center gap-1.5">
          <CheckCircle2 className="h-4 w-4" />
          已处理 {report.issuesResolved} 项
        </span>
      </div>

      <Card className="border-slate-200/80 bg-white/95 shadow-sm">
        <CardHeader>
          <div className="flex items-center gap-2 text-indigo-600">
            <Shield className="h-4 w-4" />
            <span className="text-xs font-medium uppercase tracking-[0.2em]">治理条目</span>
          </div>
          <CardTitle className="text-xl">具体知识条目</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {report.items.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-muted-foreground">
              该报告暂无可展示的条目级变更详情。
            </div>
          ) : (
            report.items.map((item) => (
              <div
                key={`${item.id}-${item.operationType}`}
                className="rounded-xl border border-slate-200 p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold text-slate-900">{item.title}</h2>
                  <Badge variant="outline">{item.operationType}</Badge>
                </div>
                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-500">
                      <GitCompareArrows className="h-3.5 w-3.5" />
                      变更前
                    </div>
                    <p className="text-sm leading-6 text-slate-700">{item.before}</p>
                  </div>
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                    <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      变更后
                    </div>
                    <p className="text-sm leading-6 text-slate-700">{item.after}</p>
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
