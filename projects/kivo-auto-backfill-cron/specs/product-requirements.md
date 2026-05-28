# KIVO Auto Backfill Cron - Product Requirements

Hermes（OpenClaw ACP Agent）/ 2026-05-24

## 1. 背景与目标

KIVO 现有 `scripts/backfill-p04-p06-extract.ts` 脚本可对 PDF 材料执行 FR-P04 概念抽取与 FR-P06 wiki 聚合，但目前每次新材料入库后都需要人工触发，导致：

- materials 长时间停留在 `pipeline_status='pending'`，仪表盘无法呈现真实进度。
- 每次手动跑都依赖会话上下文与人工守护，无法陌生人开箱即用。

目标：让新材料入库后自动通过 cron 触发 backfill，无需手动介入。

## 2. 范围

In Scope：
- 新增 user crontab 任务，每 30 分钟触发一次 backfill cron 脚本。
- 新增 `scripts/kivo-auto-backfill-cron.sh`，扫描待处理 materials 并按限流逐条触发。
- 单条 material 超时（>5min）自动跳过并写入 `pipeline_status='failed'`。
- 写日志到 `logs/kivo-auto-backfill.log`。

Out of Scope：
- 不修改 `scripts/backfill-p04-p06-extract.ts` 自身行为。
- 不动 `openclaw.json`、不修改全局 crontab、不重写 wiki 编译器。
- 不引入新的存储或外部依赖。

## 3. 用户与场景

主要用户：KIVO 单机运维者（陌生人/小白也适用），通过仪表盘观察 materials 处理状态。

典型场景：
1. 用户在 KIVO Web 或 CLI 导入新 PDF 材料，系统写入 `materials.pipeline_status='pending'`。
2. 30 分钟内 cron 自动触发 backfill；该 material 的 entries / wiki page 自动生成。
3. 单 material 卡死时，cron 跳过并标 failed，不影响后续 material 处理。

## 4. 功能需求（FR）

### FR-A 自动触发条件

- AC1：cron 每 30 分钟运行一次 `scripts/kivo-auto-backfill-cron.sh`。
- AC2：脚本扫描 `materials` 表，筛选 `pipeline_status='pending'` 且 `subject_node_id IS NOT NULL` 的 PDF 材料。
- AC3：单 material 处理超过 5 分钟自动终止子进程并跳过。
- AC4：单次 cron 运行最多处理 3 个 material（限流）。
- AC5：所有运行/跳过/失败信息写入 `/root/.openclaw/workspace/logs/kivo-auto-backfill.log`，时间戳格式 `[YYYY-MM-DD HH:MM:SS]`。

### FR-B 工程集成

- AC1：cron 注册到当前用户 crontab（`crontab -u root -l`），不修改 `/etc/crontab` 等全局配置。
- AC2：脚本路径固定为 `/root/.openclaw/workspace/scripts/kivo-auto-backfill-cron.sh`，可执行权限。
- AC3：超时 / 子进程异常退出的 material 在 sqlite 中写 `pipeline_status='failed'` 并在 `error_message` 字段记录原因（含时间戳）。
- AC4：每次状态变更必须更新 `materials.updated_at`，让仪表盘能感知变化。

## 5. 验证标准

- 手动跑一次 `bash scripts/kivo-auto-backfill-cron.sh` 完成且无报错。
- `crontab -l` 出现新条目，频率为 `*/30 * * * *`。
- sqlite 实测：构造一个 `pipeline_status='pending'` 的 material 后，运行脚本可观察到 `pipeline_status` 与 `updated_at` 变化。
- 日志文件实际生成且按时间戳追加。
