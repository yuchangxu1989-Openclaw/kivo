export type IntentSignalType =
  | 'correction'
  | 'decision'
  | 'preference'
  | 'constraint'
  | 'methodology'
  | 'lesson_learned'
  | 'fact_update'
  | 'experience'
  | 'emphasis'
  | 'declaration'
  | 'rule'
  | (string & {});

export interface SignalTypeDefinition {
  type: IntentSignalType;
  description: string;
  positiveExamples: string[];
  negativeExamples: string[];
  promptFragment?: string;
}

/**
 * DetectedSignal — output of single-message signal detection.
 * Contains the signal type, confidence, extracted knowledge, and source evidence.
 */
export interface DetectedSignal {
  type: IntentSignalType;
  confidence: number;
  title: string;
  content: string;
  positives: string[];
  negatives: string[];
  sourceFragment: string;
  reason: string;
  tags: string[];
}

/**
 * IntentSignal — alias for DetectedSignal (backward compat).
 */
export type IntentSignal = DetectedSignal;

export interface SignalDetectorConfig {
  threshold: number;
  enabledTypes: IntentSignalType[];
  customTypes?: SignalTypeDefinition[];
  maxSignalsPerConversation: number;
}

export const BUILTIN_SIGNAL_TYPES: SignalTypeDefinition[] = [
  {
    type: 'correction',
    description: '用户纠正 AI 的错误理解、错误行为或错误结论。',
    positiveExamples: ['不对，我的意思是先派发再解释。', '你刚才漏了审计步骤，完成开发后必须审计。', '这个判断错了，要以实际文件为准。'],
    negativeExamples: ['这个结果还可以。', '继续处理下一个。'],
  },
  {
    type: 'emphasis',
    description: '用户强调某事的优先级、重要性或必须被记住的程度。',
    positiveExamples: ['这条是最高优先级。', '这个点务必记住。', '千万别再犯这个错误。'],
    negativeExamples: ['我顺手提一句。', '这个可以以后再看。'],
  },
  {
    type: 'declaration',
    description: '用户声明关于自己、项目、环境、事实状态的稳定信息。',
    positiveExamples: ['我不写代码，只说自然语言。', '这个项目的登录密码是 123。', '我们主要用飞书沟通。'],
    negativeExamples: ['我现在在吃饭。', '刚才那条消息发错了。'],
  },
  {
    type: 'rule',
    description: '用户陈述可复用的流程规则、工作规范或判断标准。',
    positiveExamples: ['开发完成后必须先审计再汇报。', '调研任务必须写入 reports 目录。', '禁止用关键词匹配冒充语义理解。'],
    negativeExamples: ['这个页面颜色不好看。', '今天先不用处理。'],
  },
  {
    type: 'preference',
    description: '用户表达个人偏好、习惯、审美或沟通方式。',
    positiveExamples: ['我喜欢先结论后证据。', '不要用表格汇报。', '文案要口语化一点。'],
    negativeExamples: ['必须授权 full_access。', '这个接口当前返回 500。'],
  },
  {
    type: 'decision',
    description: '用户做出明确选择、拍板、取舍或方向确认。',
    positiveExamples: ['就按第二个方案做。', '这个需求先砍掉。', '确定走 SEVO 流水线。'],
    negativeExamples: ['也许可以试试。', '你觉得哪个更好？'],
  },
  {
    type: 'constraint',
    description: '用户设定硬性约束、禁令、安全边界或不可突破的条件。',
    positiveExamples: ['绝对禁止执行 doctor --fix。', '未经确认不能改 openclaw.json。', '主会话不能跑长时间构建命令。'],
    negativeExamples: ['我更喜欢短一点。', '可以晚点再做。'],
  },
  {
    type: 'methodology',
    description: '用户沉淀可迁移的方法论、思考框架、工作方法或原则。',
    positiveExamples: ['遇到问题先问根因，再从终局倒推。', '先列维度再填内容。', '一个问题暴露后要链式扫描同类问题。'],
    negativeExamples: ['这个按钮放左边。', '明天再看这个。'],
  },
  {
    type: 'lesson_learned',
    description: '用户总结踩坑、复盘教训、badcase 或经验教训。',
    positiveExamples: ['上次就是因为没验证运行态才误报。', '这个坑说明不能只看代码存在。', '经验是先检查配置再判断能力。'],
    negativeExamples: ['我决定用 A。', '这个值现在是 3。'],
  },
  {
    type: 'fact_update',
    description: '用户更新一个应覆盖旧认知的事实、状态、配置或资料。',
    positiveExamples: ['密码现在改成 12345678。', 'KIVO Web 已经迁到 3721 端口。', '这个项目现在叫 AEO。'],
    negativeExamples: ['我不喜欢这个风格。', '下次记得先审计。'],
  },
  {
    type: 'experience',
    description: '兼容旧类型：用户分享过往经验；新实现优先使用 lesson_learned 表达经验教训。',
    positiveExamples: ['以前这样做成功过。', '之前踩过这个坑。'],
    negativeExamples: ['必须这么做。'],
  },
];

export const BUILTIN_SIGNAL_TYPE_REGISTRY: Record<string, SignalTypeDefinition> = Object.fromEntries(
  BUILTIN_SIGNAL_TYPES.map(definition => [definition.type, definition]),
);

export const DEFAULT_SIGNAL_CONFIG: SignalDetectorConfig = {
  threshold: 0.6,
  enabledTypes: [
    'correction',
    'decision',
    'preference',
    'constraint',
    'methodology',
    'lesson_learned',
    'fact_update',
    'experience',
    'emphasis',
    'declaration',
    'rule',
  ],
  maxSignalsPerConversation: 10,
};
