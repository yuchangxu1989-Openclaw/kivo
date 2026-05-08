/**
 * EmbeddingProvider — 向量化抽象接口
 * 所有 embedding 后端必须实现此接口。
 */

export interface EmbeddingProvider {
  /** 单文本向量化 */
  embed(text: string): Promise<number[]>;
  /** 批量向量化 */
  embedBatch(texts: string[]): Promise<number[][]>;
  /** 向量维度 */
  dimensions(): number;
  /** 模型标识 */
  modelId(): string;
}
