/**
 * KIVO Error Catalog — 结构化错误目录
 *
 * FR-Z07: 所有用户可见错误包含错误描述 + 可能原因 + 修复建议。
 * 错误信息用用户导向表述，非技术栈 trace。
 */

export type ErrorCategory =
  | 'config'
  | 'storage'
  | 'embedding'
  | 'search'
  | 'ingest'
  | 'conflict'
  | 'bootstrap'
  | 'provider'
  | 'auth'
  | 'migration'
  | 'access-control'
  | 'import-export';

export interface ErrorEntry {
  /** 错误码，格式: KIVO-{CATEGORY}-{NNN} */
  code: string;
  /** 用户可读的错误描述 */
  message: string;
  /** 可能原因 */
  cause: string;
  /** 修复建议 */
  suggestion: string;
  /** 是否支持重试 */
  retryable: boolean;
  /** 错误分类 */
  category: ErrorCategory;
}

/**
 * 结构化错误目录 — 覆盖安装、配置、导入、检索、调研等全链路场景
 */
export const ERROR_CATALOG: Record<string, ErrorEntry> = {
  // ── Config ──
  'KIVO-CFG-001': {
    code: 'KIVO-CFG-001',
    message: '配置文件缺失或无法读取',
    cause: '配置文件路径不存在，或当前用户无读取权限。',
    suggestion: '检查配置文件路径是否正确，或使用环境变量 KIVO_DB_PATH 等直接注入配置。',
    retryable: false,
    category: 'config',
  },
  'KIVO-CFG-002': {
    code: 'KIVO-CFG-002',
    message: '配置校验失败',
    cause: '必填字段缺失或字段值不合法。',
    suggestion: '运行 kivo health 查看详细校验结果，按提示修正配置。',
    retryable: false,
    category: 'config',
  },
  'KIVO-CFG-003': {
    code: 'KIVO-CFG-003',
    message: 'LLM Provider 连接失败',
    cause: 'API Key 无效、网络不可达或 Provider 服务暂时不可用。',
    suggestion: '检查 API Key 是否正确，确认网络连通性。可用 kivo health 验证 Provider 状态。',
    retryable: true,
    category: 'provider',
  },

  // ── Storage ──
  'KIVO-STG-001': {
    code: 'KIVO-STG-001',
    message: '数据库初始化失败',
    cause: '数据库文件路径不可写，或 SQLite 版本不兼容。',
    suggestion: '确认 dbPath 指向的目录存在且有写权限。使用 ":memory:" 可跳过文件系统限制。',
    retryable: false,
    category: 'storage',
  },
  'KIVO-STG-002': {
    code: 'KIVO-STG-002',
    message: '数据库读写失败',
    cause: '磁盘空间不足、文件被锁定或数据库损坏。',
    suggestion: '检查磁盘空间，确认无其他进程锁定数据库文件。如数据库损坏，可从备份恢复。',
    retryable: true,
    category: 'storage',
  },

  // ── Embedding ──
  'KIVO-EMB-001': {
    code: 'KIVO-EMB-001',
    message: 'Embedding Provider 未配置',
    cause: '未在配置中指定 embedding provider，语义搜索不可用。',
    suggestion: '在配置中添加 embedding 配置，或使用关键词搜索作为替代。',
    retryable: false,
    category: 'embedding',
  },
  'KIVO-EMB-002': {
    code: 'KIVO-EMB-002',
    message: 'Embedding 生成失败',
    cause: 'Embedding API 调用失败，可能是网络问题或 API 限流。',
    suggestion: '稍后重试。如持续失败，检查 API Key 和网络连接。',
    retryable: true,
    category: 'embedding',
  },

  // ── Search ──
  'KIVO-SCH-001': {
    code: 'KIVO-SCH-001',
    message: '检索无结果',
    cause: '知识库中没有匹配的条目，或查询关键词过于宽泛/狭窄。',
    suggestion: '尝试调整关键词，或导入更多知识数据。如刚完成导入，等待索引完成后重试。',
    retryable: true,
    category: 'search',
  },

  // ── Ingest ──
  'KIVO-ING-001': {
    code: 'KIVO-ING-001',
    message: '知识提取失败',
    cause: '输入文本格式异常或 Pipeline 处理超时。',
    suggestion: '检查输入文本是否为空或过长，缩短文本后重试。',
    retryable: true,
    category: 'ingest',
  },
  'KIVO-ING-002': {
    code: 'KIVO-ING-002',
    message: '知识条目保存失败',
    cause: '数据库写入异常，可能是存储空间不足或并发冲突。',
    suggestion: '检查磁盘空间，稍后重试。如问题持续，查看诊断信息。',
    retryable: true,
    category: 'ingest',
  },

  // ── Conflict ──
  'KIVO-CFT-001': {
    code: 'KIVO-CFT-001',
    message: '冲突检测失败',
    cause: '冲突检测过程中出现异常，可能是 LLM Provider 不可用。',
    suggestion: '检查 LLM Provider 配置和连通性，重试导入操作。',
    retryable: true,
    category: 'conflict',
  },

  // ── Bootstrap ──
  'KIVO-BST-001': {
    code: 'KIVO-BST-001',
    message: '初始化检测失败',
    cause: '无法读取初始化状态文件或数据库。',
    suggestion: '确认 dbPath 配置正确且目录可访问。',
    retryable: true,
    category: 'bootstrap',
  },
  'KIVO-BST-002': {
    code: 'KIVO-BST-002',
    message: '示例数据导入失败',
    cause: '示例数据文件缺失或格式不兼容。',
    suggestion: '跳过示例数据导入，手动创建知识条目。',
    retryable: true,
    category: 'bootstrap',
  },

  // ── Auth ──
  'KIVO-ATH-001': {
    code: 'KIVO-ATH-001',
    message: '登录失败',
    cause: '用户名或密码错误。',
    suggestion: '检查用户名和密码是否正确。如忘记密码，联系管理员重置。',
    retryable: true,
    category: 'auth',
  },
  'KIVO-ATH-002': {
    code: 'KIVO-ATH-002',
    message: '会话已过期',
    cause: '会话超时或已被主动注销。',
    suggestion: '请重新登录。',
    retryable: true,
    category: 'auth',
  },
  'KIVO-ATH-003': {
    code: 'KIVO-ATH-003',
    message: '权限不足',
    cause: '当前角色无权执行此操作。',
    suggestion: '联系管理员提升权限或切换到有权限的账户。',
    retryable: false,
    category: 'auth',
  },
  'KIVO-ATH-004': {
    code: 'KIVO-ATH-004',
    message: '用户名已存在',
    cause: '尝试创建的用户名已被占用。',
    suggestion: '使用其他用户名重试。',
    retryable: false,
    category: 'auth',
  },

  // ── Domain Goal ──
  'KIVO-DGL-001': {
    code: 'KIVO-DGL-001',
    message: '域目标已存在',
    cause: '尝试创建的域目标 ID 已被占用。',
    suggestion: '使用 update 方法修改已有域目标，或使用不同的 domainId。',
    retryable: false,
    category: 'config',
  },
  'KIVO-DGL-002': {
    code: 'KIVO-DGL-002',
    message: '域目标不存在',
    cause: '指定的域目标 ID 未找到。',
    suggestion: '检查 domainId 是否正确，或先创建域目标。',
    retryable: false,
    category: 'config',
  },

  // ── Access Control ──
  'KIVO-ACL-001': {
    code: 'KIVO-ACL-001',
    message: '域访问被拒绝',
    cause: '当前角色无权访问目标知识域。',
    suggestion: '联系管理员配置域访问权限。',
    retryable: false,
    category: 'auth',
  },

  // ── Migration ──
  'KIVO-MIG-001': {
    code: 'KIVO-MIG-001',
    message: '数据迁移失败',
    cause: '迁移脚本执行异常，可能是 schema 不兼容。',
    suggestion: '检查数据库状态，尝试回滚后重新迁移。如问题持续，查看迁移日志。',
    retryable: true,
    category: 'storage',
  },
  'KIVO-MIG-002': {
    code: 'KIVO-MIG-002',
    message: '数据完整性校验失败',
    cause: '升级前数据完整性校验不通过，数据库可能已损坏。',
    suggestion: '从备份恢复数据库后重试。',
    retryable: false,
    category: 'storage',
  },

  // ── Import/Export ──
  'KIVO-IMP-001': {
    code: 'KIVO-IMP-001',
    message: '导入格式不兼容',
    cause: '导入文件的格式版本与当前系统不兼容。',
    suggestion: '使用与当前系统版本匹配的导出文件，或升级系统后重试。',
    retryable: false,
    category: 'ingest',
  },
  'KIVO-IMP-002': {
    code: 'KIVO-IMP-002',
    message: '导入条目冲突',
    cause: '导入的条目与已有条目存在冲突。',
    suggestion: '冲突条目已标记为 pending，请在 Workbench 中裁决。',
    retryable: false,
    category: 'ingest',
  },
  'KIVO-EXP-001': {
    code: 'KIVO-EXP-001',
    message: '导出失败',
    cause: '知识库导出过程中出现异常。',
    suggestion: '检查磁盘空间和数据库状态后重试。',
    retryable: true,
    category: 'storage',
  },
};