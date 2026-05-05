export interface LLMProvider {
  complete(prompt: string): Promise<string>;
}

export type ProviderCapability = 'text-generation' | 'embedding' | 'structured-output';

export interface RegisteredLLMProvider extends LLMProvider {
  readonly id: string;
  readonly capabilities: ProviderCapability[];
  available?(): Promise<boolean> | boolean;
}
