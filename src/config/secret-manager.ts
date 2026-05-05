/**
 * SecretManager — 配置与密钥管理
 *
 * FR-Z04:
 * - AC1: API Key 等敏感配置支持环境变量注入，不硬编码在配置文件中
 * - AC2: 配置文件中的敏感字段支持占位符语法 ${ENV_VAR}
 * - AC3: 启动时校验必要密钥是否已配置，缺失时给出明确提示
 * - AC4: 密钥不出现在日志和错误输出中
 */

export interface SecretCheckResult {
  key: string;
  envVar: string;
  configured: boolean;
  required: boolean;
  masked: string;
}

export interface SecretCheckReport {
  items: SecretCheckResult[];
  allRequired: boolean;
  missingRequired: string[];
}

const KNOWN_SECRETS: Array<{ key: string; envVar: string; required: boolean }> = [
  { key: 'embedding.apiKey', envVar: 'KIVO_EMBEDDING_API_KEY', required: false },
  { key: 'llm.apiKey', envVar: 'KIVO_LLM_API_KEY', required: false },
];

/**
 * AC1/AC2: 解析配置中的占位符 ${ENV_VAR}
 */
export function resolveSecrets(config: Record<string, unknown>): Record<string, unknown> {
  return deepResolve(config) as Record<string, unknown>;
}

function deepResolve(value: unknown): unknown {
  if (typeof value === 'string') {
    return resolveString(value);
  }
  if (Array.isArray(value)) {
    return value.map(deepResolve);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = deepResolve(v);
    }
    return result;
  }
  return value;
}

function resolveString(str: string): string {
  return str.replace(/\$\{([^}]+)\}/g, (_match, envVar: string) => {
    const value = process.env[envVar.trim()];
    return value ?? '';
  });
}

/**
 * AC3: 校验必要密钥是否已配置
 */
export function checkSecrets(additionalSecrets?: Array<{ key: string; envVar: string; required: boolean }>): SecretCheckReport {
  const secrets = [...KNOWN_SECRETS, ...(additionalSecrets ?? [])];
  const items: SecretCheckResult[] = [];

  for (const secret of secrets) {
    const value = process.env[secret.envVar];
    const configured = !!value && value.length > 0;
    items.push({
      key: secret.key,
      envVar: secret.envVar,
      configured,
      required: secret.required,
      masked: configured ? maskSecret(value!) : '(未配置)',
    });
  }

  const missingRequired = items
    .filter(i => i.required && !i.configured)
    .map(i => i.envVar);

  return {
    items,
    allRequired: missingRequired.length === 0,
    missingRequired,
  };
}

/**
 * AC4: 密钥脱敏 — 只显示前 4 位和后 4 位
 */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/** 格式化密钥检查报告 */
export function formatSecretReport(report: SecretCheckReport): string {
  const lines: string[] = ['密钥配置状态', '-'.repeat(25), ''];

  for (const item of report.items) {
    const icon = item.configured ? '✓' : item.required ? '✗' : '⚠';
    const reqLabel = item.required ? '(必需)' : '(可选)';
    lines.push(`${icon} ${item.key} ${reqLabel}`);
    lines.push(`  环境变量: ${item.envVar}`);
    lines.push(`  状态: ${item.masked}`);
  }

  lines.push('');
  if (report.allRequired) {
    lines.push('✓ 所有必需密钥已配置');
  } else {
    lines.push(`✗ 缺失必需密钥: ${report.missingRequired.join(', ')}`);
    lines.push('  请设置对应环境变量后重试');
  }

  return lines.join('\n');
}
