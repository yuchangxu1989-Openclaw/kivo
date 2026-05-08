/**
 * BGE Embedder — persistent Python child process for embedding.
 *
 * Spawns bge-embed.py once, communicates via stdin/stdout JSON lines.
 * Model loads once at startup; all subsequent embed calls reuse the same process.
 * Uses BAAI/bge-small-zh-v1.5 (512 dimensions).
 *
 * Implements EmbeddingProvider interface for seamless integration.
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { EmbeddingProvider } from '../embedding/embedding-provider.js';
import { shouldBypassExternalModelsInTests } from '../utils/test-runtime.js';

const BGE_DIMENSIONS = 512;

/**
 * Resolve the path to bge-embed.py.
 * Priority: KIVO_BGE_SCRIPT env > relative path from this file.
 *
 * The relative fallback uses __dirname (CJS) or computes from import.meta.url (ESM).
 * dist/esm/extraction/ or dist/cjs/extraction/ → up 3 levels → scripts/bge-embed.py
 */
/**
 * Get the directory of this source file.
 * Uses eval() to avoid TypeScript static analysis errors when compiling
 * the same source for both ESM (import.meta.url) and CJS (__dirname).
 */
function getModuleDir(): string {
  // Try CJS __dirname first (it's a plain global in CJS)
  try {
    const d = eval('typeof __dirname !== "undefined" && __dirname');
    if (d) return d;
  } catch { /* not CJS */ }

  // ESM: compute from import.meta.url
  try {
    const url = eval('import.meta.url') as string;
    // Use Node built-in URL to convert file:// URL to path
    const filePath = new URL(url).pathname;
    return dirname(filePath);
  } catch { /* shouldn't happen */ }

  // Last resort: cwd-based (original behavior)
  return resolve(process.cwd(), 'dist', 'esm', 'extraction');
}

function defaultScriptPath(): string {
  if (process.env.KIVO_BGE_SCRIPT) return resolve(process.env.KIVO_BGE_SCRIPT);
  return resolve(getModuleDir(), '..', '..', '..', 'scripts', 'bge-embed.py');
}

export class BgeEmbedder implements EmbeddingProvider {
  private readonly pythonScript: string;
  private proc: ChildProcess | null = null;
  private rl: ReadlineInterface | null = null;
  private ready: Promise<void> | null = null;
  private pendingResolve: ((value: string) => void) | null = null;
  private pendingReject: ((reason: Error) => void) | null = null;
  private closed = false;

  constructor(customScriptPath?: string) {
    this.pythonScript = customScriptPath ?? defaultScriptPath();
  }

  /**
   * Start the Python process and wait for the "ready" signal.
   * Idempotent — only spawns once.
   */
  private ensureStarted(): Promise<void> {
    if (this.ready) return this.ready;

    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      this.proc = spawn('python3', [this.pythonScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.rl = createInterface({ input: this.proc.stdout! });

      // Wait for the first line: the ready signal
      const onFirstLine = (line: string) => {
        try {
          const msg = JSON.parse(line);
          if (msg.status === 'ready') {
            // Switch to normal request/response handling
            this.rl!.on('line', (l: string) => this.onLine(l));
            resolveReady();
          } else if (msg.error) {
            rejectReady(new Error(`BGE startup error: ${msg.error}`));
          } else {
            rejectReady(new Error(`BGE unexpected startup message: ${line}`));
          }
        } catch {
          rejectReady(new Error(`BGE startup returned invalid JSON: ${line}`));
        }
      };
      this.rl.once('line', onFirstLine);

      this.proc.on('error', (err) => {
        rejectReady(new Error(`Failed to spawn BGE process: ${err.message}`));
        if (this.pendingReject) {
          this.pendingReject(new Error(`BGE process error: ${err.message}`));
          this.pendingResolve = null;
          this.pendingReject = null;
        }
      });

      this.proc.on('exit', (code) => {
        if (!this.closed) {
          const err = new Error(`BGE process exited unexpectedly with code ${code}`);
          rejectReady(err);
          if (this.pendingReject) {
            this.pendingReject(err);
            this.pendingResolve = null;
            this.pendingReject = null;
          }
        }
      });

      // Collect stderr for diagnostics (don't block on it)
      this.proc.stderr?.on('data', () => {
        // Silently consume stderr (model loading progress, warnings, etc.)
      });
    });

    return this.ready;
  }

  /** Handle a response line from the Python process */
  private onLine(line: string): void {
    if (this.pendingResolve) {
      const cb = this.pendingResolve;
      this.pendingResolve = null;
      this.pendingReject = null;
      cb(line);
    }
  }

  /** Send a request and wait for the response (with 30s timeout) */
  private async request(payload: string): Promise<string> {
    await this.ensureStarted();

    if (!this.proc || !this.proc.stdin || this.closed) {
      throw new Error('BGE process is not running');
    }

    const REQUEST_TIMEOUT_MS = 30_000;

    return new Promise<string>((res, rej) => {
      const timer = setTimeout(() => {
        this.pendingResolve = null;
        this.pendingReject = null;
        // Kill the stuck process so subsequent calls don't hang
        this.proc?.kill('SIGKILL');
        this.proc = null;
        this.rl?.close();
        this.rl = null;
        this.ready = null; // allow re-spawn on next call
        rej(new Error(`BGE request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingResolve = (value: string) => {
        clearTimeout(timer);
        res(value);
      };
      this.pendingReject = (reason: Error) => {
        clearTimeout(timer);
        rej(reason);
      };
      this.proc!.stdin!.write(payload + '\n');
    });
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const input = JSON.stringify(texts);
    const raw = await this.request(input);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('BGE embedding returned invalid JSON');
    }

    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      throw new Error(`BGE embedding error: ${(parsed as { error: string }).error}`);
    }

    if (!Array.isArray(parsed) || parsed.length !== texts.length) {
      throw new Error(
        `BGE embedding returned ${Array.isArray(parsed) ? parsed.length : 'non-array'} results for ${texts.length} inputs`,
      );
    }

    return parsed as number[][];
  }

  dimensions(): number {
    return BGE_DIMENSIONS;
  }

  modelId(): string {
    return 'bge-small-zh-v1.5';
  }

  /** Gracefully shut down the Python process */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.proc) {
      // Close stdin to signal EOF → Python process exits its for-loop
      this.proc.stdin?.end();

      // Wait for process to exit (with timeout)
      await new Promise<void>((res) => {
        const timeout = setTimeout(() => {
          this.proc?.kill('SIGTERM');
          res();
        }, 5000);
        this.proc!.on('exit', () => {
          clearTimeout(timeout);
          res();
        });
      });

      this.rl?.close();
      this.proc = null;
      this.rl = null;
    }
  }

  /** Check if Python + sentence-transformers are available */
  static isAvailable(): boolean {
    if (shouldBypassExternalModelsInTests()) {
      return false;
    }

    try {
      execSync('python3 -c "import sentence_transformers"', {
        encoding: 'utf-8',
        timeout: 2_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  }
}
