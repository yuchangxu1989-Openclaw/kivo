/**
 * Material domain types — Wave 1 / arc42 §5.3.1 / §6.1
 *
 * 描述外部素材进入 KIVO 的入口数据契约。A1 只负责接收并落地一行
 * materials（classification_status = 'pending'），分类逻辑由 A2 消费。
 */

/**
 * 支持的素材资产类型。与 spec FR-B03 一致，覆盖 PDF / Office 文档 /
 * 视频 / 音频 / 图片。其它类型走 'other' 并由后续管线处理。
 */
export type AssetKind =
  | 'pdf'
  | 'docx'
  | 'doc'
  | 'video'
  | 'audio'
  | 'image'
  | 'text'
  | 'other';

/**
 * 渠道。MVP 主要走 web upload，预留后续 IM / API / mcp 等。
 */
export type SourceChannel = 'web_upload' | 'api' | 'feishu' | 'wechat' | 'manual' | 'unknown';

/**
 * materials.classification_status 的取值。
 *  - pending:     已入库，等待 A2 调度
 *  - in_progress: A2 正在分类
 *  - classified:  分类完成（高置信度）
 *  - needs_review: 低置信度，进入 pending_review 队列
 *  - failed:      分类失败
 */
export type ClassificationStatus =
  | 'pending'
  | 'in_progress'
  | 'classified'
  | 'needs_review'
  | 'failed';

/**
 * 素材登记元数据载荷。
 *
 * 当 multipart/form-data 时，metadata 以 JSON 字符串的形式放在
 * `metadata` 字段；当 JSON 请求时，整个 body 即为 IngestMetadata + sourceRef。
 */
export interface IngestMetadata {
  /** 素材标题；为空时由文件名推断 */
  title?: string;
  /**
   * 资产类型。未提供时由 mimeType / 文件扩展名推断；推断不出走 'other'。
   */
  assetKind?: AssetKind;
  /**
   * 数据来源标识。文件上传时为 `upload://material/<id>`；外链/API 时为
   * 调用方提供的 URL 或唯一 id。A2 会以此查重，避免重复处理。
   */
  sourceRef?: string;
  /** 调用渠道。未提供时按请求形态推断 */
  sourceChannel?: SourceChannel;
  /** 学科域提示，纯参考；A2 在低置信度时会用来辅助 rerank。 */
  subjectHint?: string;
  /** 空间隔离 id，默认 'default' */
  spaceId?: string;
  /** 调用方传入的额外 JSON，存进 source_ref 旁边以便 A2 调试 */
  extra?: Record<string, unknown>;
}

/**
 * Ingest 接口返回值，AC：必须返回 material_id + 状态轮询 endpoint
 */
export interface IngestResponse {
  materialId: string;
  status: 'processing';
  classificationStatus: ClassificationStatus;
  /** 状态轮询入口；A2 实施后由该 endpoint 提供分类结果 */
  statusEndpoint: string;
  assetKind: AssetKind;
  sourceChannel: SourceChannel;
  acceptedAt: string;
}

/**
 * GET /api/materials/[id]/status 的响应（A1 提供轮询占位实现）
 */
export interface MaterialStatusResponse {
  materialId: string;
  title: string;
  assetKind: AssetKind | null;
  sourceChannel: SourceChannel | null;
  sourceRef: string | null;
  /** 上传/写入态：processing / done / failed */
  pipelineStatus: string | null;
  /** A2 写入的分类态 */
  classificationStatus: ClassificationStatus | null;
  classificationConfidence: number | null;
  suggestedSubjectName: string | null;
  subjectNodeId: string | null;
  createdAt: string;
  updatedAt: string;
}
