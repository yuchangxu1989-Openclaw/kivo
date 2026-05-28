/**
 * 上传/重处理后的进程内分发触发器。
 *
 * 走查体验问题：上传完成后必须等外部 cron 才能跑 classify/pipeline，
 * 而 cron-pipeline-dispatcher 当前在 crontab 里是 PAUSED。这导致新材料
 * 永远停在 classification_status='pending'、entries=0。
 *
 * 解决：upload route 触发后，进程内异步连续 tick dispatchTick，直到
 * 队列里没有 waiting 任务为止，或达到上限。tick 之间留间隔避免抢占
 * 主请求线程。
 *
 * 设计要点：
 *   - 单例锁：同一进程内同时只允许一个驱动循环跑，多次触发只会续杯
 *     而不会并发起多个循环。
 *   - 不阻塞响应：调用方 fire-and-forget，HTTP 响应立刻返回。
 *   - 失败容忍：dispatchTick 抛错只记 warn，不影响下次 tick；
 *     下次 cron（若启用）或下次上传都会再触发。
 */

import { dispatchTick } from '@/lib/queue/dispatcher';

const MAX_CONSECUTIVE_TICKS = 20;
const TICK_INTERVAL_MS = 1500;
const IDLE_REPROBE_AFTER_MS = 1000;

let driverRunning = false;
let pendingRequest = false;

async function driver(): Promise<void> {
  if (driverRunning) {
    pendingRequest = true;
    return;
  }
  driverRunning = true;
  try {
    let consecutive = 0;
    while (consecutive < MAX_CONSECUTIVE_TICKS) {
      pendingRequest = false;
      let dispatched = 0;
      try {
        const result = await dispatchTick();
        dispatched = result.dispatched;
      } catch (err) {
        console.warn(
          '[in-process-dispatch] dispatchTick failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
      consecutive += 1;
      if (dispatched === 0) {
        // 给 backfill 一个观察新写入的 chance；若期间没有新触发就退出
        await sleep(IDLE_REPROBE_AFTER_MS);
        if (!pendingRequest) break;
      } else {
        await sleep(TICK_INTERVAL_MS);
      }
    }
  } finally {
    driverRunning = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function triggerInProcessDispatch(): void {
  void driver();
}
