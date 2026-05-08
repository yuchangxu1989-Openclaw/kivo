/**
 * Context Injection SPI — Embedding 通过接口调用，不绑定特定 provider
 * 与 conflict/spi.ts 同构接口，保持域独立，调用方可传入同一实现。
 */

/** Embedding 向量化 SPI */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}
