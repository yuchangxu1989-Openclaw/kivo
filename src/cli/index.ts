#!/usr/bin/env node

const command = process.argv[2];

function parseFlags(valueFlags: string[], boolFlags: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  const args = process.argv.slice(3);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (boolFlags.includes(key)) {
      result[key] = true;
    } else if (valueFlags.includes(key) && i + 1 < args.length) {
      result[key] = args[++i];
    }
  }
  return result;
}

async function main() {
  switch (command) {
    case 'health': {
      const { runHealthCheck, formatHealthReport } = await import('./health-check.js');
      const report = await runHealthCheck();
      console.log(formatHealthReport(report));
      process.exitCode = report.overall === 'unhealthy' ? 1 : 0;
      break;
    }
    case 'init': {
      const { runInit } = await import('./init.js');
      const interactive = process.argv.includes('--interactive') || process.argv.includes('-i');
      const nonInteractive = process.argv.includes('--yes') || process.argv.includes('-y');
      const result = await runInit({ interactive, nonInteractive });
      console.log(result);
      // Auto-ingest workspace knowledge after init
      try {
        const { runIngest } = await import('./ingest.js');
        console.log('');
        console.log('Auto-ingesting workspace knowledge...');
        const ingestResult = await runIngest({ cwd: process.cwd() });
        console.log(ingestResult);
      } catch (err) {
        console.error(`⚠ Auto-ingest failed: ${(err as Error).message}`);
      }
      break;
    }
    case 'query': {
      const queryOpts = parseFlags(['nature', 'function', 'domain'], []);
      const queryArgs = process.argv.slice(3).filter(a => !a.startsWith('--'));
      const queryText = queryArgs.join(' ');
      if (!queryText && !queryOpts.nature && !queryOpts.function && !queryOpts.domain) {
        console.error('Usage: kivo query <search text> [--nature fact] [--function routing] [--domain "agent-scheduling"]');
        process.exitCode = 1;
        break;
      }
      const { runQuery } = await import('./query.js');
      const output = await runQuery(queryText, {
        nature: typeof queryOpts.nature === 'string' ? queryOpts.nature : undefined,
        functionTag: typeof queryOpts.function === 'string' ? queryOpts.function : undefined,
        domain: typeof queryOpts.domain === 'string' ? queryOpts.domain : undefined,
      });
      console.log(output);
      break;
    }
    case 'add': {
      const addType = process.argv[3];
      const addTitle = process.argv[4];
      if (!addType || !addTitle) {
        console.error('Usage: kivo add <type> <title> [--content "..."] [--tags "a,b"] [--source "..."] [--confidence 0.8] [--domain "..."] [--json] [--no-quality-gate]');
        process.exitCode = 1;
        break;
      }
      const addOpts = parseFlags(['content', 'tags', 'source', 'confidence', 'domain', 'status'], ['json', 'no-quality-gate']);
      const { runAdd } = await import('./add.js');
      const addOutput = await runAdd(addType, addTitle, addOpts);
      console.log(addOutput);
      break;
    }
    case 'list': {
      const listOpts = parseFlags(['type', 'limit', 'offset', 'status'], ['json']);
      const { runList } = await import('./list.js');
      const listOutput = await runList(listOpts);
      console.log(listOutput);
      break;
    }
    case 'update': {
      const updateId = process.argv[3];
      if (!updateId) {
        console.error('Usage: kivo update <id> [--title "..."] [--content "..."] [--tags "a,b"] [--confidence 0.8] [--status active] [--json]');
        process.exitCode = 1;
        break;
      }
      const updateOpts = parseFlags(['title', 'content', 'tags', 'confidence', 'domain', 'status'], ['json']);
      const { runUpdate } = await import('./update.js');
      const updateOutput = await runUpdate(updateId, updateOpts);
      console.log(updateOutput);
      break;
    }
    case 'delete': {
      const deleteId = process.argv[3];
      if (!deleteId) {
        console.error('Usage: kivo delete <id> [--force] [--json]');
        process.exitCode = 1;
        break;
      }
      const deleteOpts = parseFlags([], ['force', 'json']);
      const { runDelete } = await import('./delete.js');
      const deleteOutput = await runDelete(deleteId, deleteOpts);
      console.log(deleteOutput);
      break;
    }
    case 'config-check': {
      const { loadEnvConfig } = await import('../config/env-loader.js');
      const { validateConfigDetailed, formatValidationErrors } = await import('../config/config-validator.js');
      const { DEFAULT_CONFIG } = await import('../config/types.js');
      const config = { ...DEFAULT_CONFIG, ...loadEnvConfig() };
      const result = validateConfigDetailed(config);
      console.log(formatValidationErrors(result));
      process.exitCode = result.valid ? 0 : 1;
      break;
    }
    case 'env': {
      const { listEnvVars } = await import('../config/env-loader.js');
      const vars = listEnvVars();
      console.log('KIVO Environment Variables:\n');
      for (const v of vars) {
        const val = v.current ?? '(not set)';
        console.log(`  ${v.env} -> ${v.configPath} = ${val}`);
      }
      break;
    }
    case 'capabilities': {
      const { detectCapabilities, formatCapabilities } = await import('./capabilities.js');
      const { loadEnvConfig } = await import('../config/env-loader.js');
      const { DEFAULT_CONFIG } = await import('../config/types.js');
      const config = { ...DEFAULT_CONFIG, ...loadEnvConfig() };
      const caps = detectCapabilities(config);
      console.log(formatCapabilities(caps));
      break;
    }
    case 'doc-gate': {
      const docsDir = process.argv[3] ?? 'docs';
      const srcDir = process.argv[4] ?? 'src';
      const strict = process.argv.includes('--strict');
      const { runDocGate } = await import('../doc-gate/doc-gate-runner.js');
      const result = runDocGate({ docsDir, srcDir, strict });
      console.log(result.report);
      process.exitCode = result.passed ? 0 : 1;
      break;
    }
    case 'migrate': {
      const { runMigrate } = await import('./migrate.js');
      const subCmd = process.argv[3];
      const migrateResult = await runMigrate(subCmd, process.argv.slice(4));
      console.log(migrateResult);
      break;
    }
    case 'governance': {
      const govSubCmd = process.argv[3];
      const govOpts = parseFlags(['limit', 'domain', 'decay-days', 'min-confidence', 'batch-size', 'max-age-days'], ['json', 'dry-run']);
      const govJson = !!govOpts.json;

      switch (govSubCmd) {
        case 'run': {
          const { runPeriodicGovernance, formatPeriodicGovernanceReport } = await import('./periodic-governance.js');
          const domain = typeof govOpts.domain === 'string' ? govOpts.domain : undefined;
          const dryRun = !!govOpts['dry-run'];
          const decayDays = govOpts['decay-days'] ? Number(govOpts['decay-days']) : undefined;
          const minConfidence = govOpts['min-confidence'] ? Number(govOpts['min-confidence']) : undefined;
          const report = await runPeriodicGovernance({ domain, dryRun, json: govJson, decayDays, minConfidence });
          if (govJson) {
            console.log(JSON.stringify(report, null, 2));
          } else {
            console.log(formatPeriodicGovernanceReport(report));
          }
          break;
        }
        case 'restore': {
          const restoreId = process.argv[4];
          if (!restoreId) {
            console.error('Usage: kivo governance restore <id>');
            process.exitCode = 1;
            break;
          }
          const { runGovernanceRestore } = await import('./periodic-governance.js');
          const restoreOutput = await runGovernanceRestore(restoreId);
          console.log(restoreOutput);
          break;
        }
        case 'report': {
          const { runGovernanceReport } = await import('./governance.js');
          const limit = govOpts.limit ? Number(govOpts.limit) : undefined;
          const govOutput = await runGovernanceReport({ limit, json: govJson });
          console.log(govOutput);
          break;
        }
        case 'config': {
          const { runGovernanceConfig } = await import('./governance.js');
          // Parse --set key=value pairs
          const setArgs: Record<string, string> = {};
          const args = process.argv.slice(4);
          for (let i = 0; i < args.length; i++) {
            if (args[i] === '--set' && i + 1 < args.length) {
              const [k, v] = args[++i].split('=');
              if (k && v) setArgs[k] = v;
            }
          }
          const govOutput = await runGovernanceConfig({
            set: Object.keys(setArgs).length > 0 ? setArgs : undefined,
            json: govJson,
          });
          console.log(govOutput);
          break;
        }
        case 'check-staleness': {
          const { runStalenessCheck, formatStalenessReport } = await import('./staleness-detector.js');
          const domain = typeof govOpts.domain === 'string' ? govOpts.domain : undefined;
          const dryRun = !!govOpts['dry-run'];
          const batchSize = govOpts['batch-size'] ? Number(govOpts['batch-size']) : 20;
          const maxAgeDays = govOpts['max-age-days'] ? Number(govOpts['max-age-days']) : 90;
          const stalenessReport = await runStalenessCheck({
            batchSize,
            maxAgeDays,
            dryRun,
            json: govJson,
            domain,
          });
          if (govJson) {
            console.log(JSON.stringify(stalenessReport, null, 2));
          } else {
            console.log(formatStalenessReport(stalenessReport));
          }
          break;
        }
        default:
          console.log(`Usage:\n  kivo governance run [options]    Run periodic knowledge governance\n  kivo governance restore <id>     Restore an archived/deprecated entry\n  kivo governance check-staleness   Detect and archive stale entries\n  kivo governance report [--limit]  View recent governance reports\n  kivo governance config            View current governance config\n  kivo governance config --set key=value  Update a config parameter\n\nRun Options:\n  --domain <type>          Filter by knowledge type/domain\n  --dry-run                Preview actions without executing\n  --json                   Output as JSON\n  --decay-days <number>    Days without retrieval hit before decay (default: 90)\n  --min-confidence <number> Confidence threshold for archiving (default: 0.3)\n\nCheck-Staleness Options:\n  --batch-size <number>    Entries per LLM batch (default: 20)\n  --max-age-days <number>  Age threshold in days (default: 90)\n  --domain <type>          Filter by domain\n  --dry-run                Preview without archiving\n  --json                   Output as JSON\n\nReport Options:\n  --json    Output as JSON\n  --limit N Max reports to show (default 5)`);

          process.exitCode = govSubCmd ? 1 : 0;
      }
      break;
    }
    case 'consistency-check': {
      const ccOpts = parseFlags(['threshold', 'types', 'domains'], ['json', 'strict']);
      const { runConsistencyCheck } = await import('./consistency-check.js');
      const entries: import('../types/index.js').KnowledgeEntry[] = [];
      try {
        const { KnowledgeRepository } = await import('../repository/index.js');
        const { SQLiteProvider } = await import('../repository/index.js');
        const { existsSync, readFileSync } = await import('node:fs');
        const { resolve, join } = await import('node:path');
        const { DEFAULT_CONFIG } = await import('../config/types.js');
        const dir = process.cwd();
        const configPath = join(dir, 'kivo.config.json');
        let dbPath = process.env.KIVO_DB_PATH ?? String(DEFAULT_CONFIG.dbPath);
        if (!process.env.KIVO_DB_PATH && existsSync(configPath)) {
          const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
          if (typeof raw.dbPath === 'string') dbPath = raw.dbPath;
        }
        const resolvedDb = resolve(dir, dbPath);
        if (existsSync(resolvedDb)) {
          const provider = new SQLiteProvider({ dbPath: resolvedDb });
          const repo = new KnowledgeRepository(provider);
          entries.push(...await repo.findAll());
          await repo.close();
        }
      } catch {
        // DB not available; proceed with empty entries
      }

      if (entries.length === 0) {
        console.log('No knowledge entries found. Initialize a knowledge base first with `kivo init`.');
        break;
      }

      const checkOptions = {
        similarityThreshold: ccOpts.threshold ? Number(ccOpts.threshold) : undefined,
        types: ccOpts.types ? String(ccOpts.types).split(',') : undefined,
        domains: ccOpts.domains ? String(ccOpts.domains).split(',') : undefined,
        strict: !!ccOpts.strict,
      };

      const { report, output } = runConsistencyCheck({
        entries,
        options: checkOptions,
        json: !!ccOpts.json,
      });
      console.log(output);
      process.exitCode = report.passed ? 0 : 1;
      break;
    }
    case 'ingest': {
      const ingestOpts = parseFlags(['dir', 'file', 'files'], ['json', 'llm', 'no-quality-gate']);
      const dirs = typeof ingestOpts.dir === 'string' ? ingestOpts.dir.split(',') : undefined;
      const filesRaw = typeof ingestOpts.files === 'string' ? ingestOpts.files : typeof ingestOpts.file === 'string' ? ingestOpts.file : undefined;
      const files = typeof filesRaw === 'string' ? filesRaw.split(',') : undefined;
      const { runIngest } = await import('./ingest.js');
      const ingestOutput = await runIngest({ dirs, files, json: !!ingestOpts.json, llm: !!ingestOpts.llm, noQualityGate: !!ingestOpts['no-quality-gate'] });
      console.log(ingestOutput);
      break;
    }
    case 'enrich-intents': {
      const enrichOpts = parseFlags(['batch-size'], ['dry-run', 'json']);
      const { runEnrichIntents } = await import('./enrich-intents.js');
      const batchSize = enrichOpts['batch-size'] ? parseInt(String(enrichOpts['batch-size']), 10) : undefined;
      const enrichOutput = await runEnrichIntents({ dryRun: !!enrichOpts['dry-run'], json: !!enrichOpts.json, batchSize });
      console.log(enrichOutput);
      break;
    }
    case 'embed-backfill': {
      const ebOpts = parseFlags(['batch-size', 'sleep-ms'], ['json']);
      const { runEmbedBackfill } = await import('./embed-backfill.js');
      const ebBatchSize = ebOpts['batch-size'] ? parseInt(String(ebOpts['batch-size']), 10) : undefined;
      const ebSleepMs = ebOpts['sleep-ms'] ? parseInt(String(ebOpts['sleep-ms']), 10) : undefined;
      const ebOutput = await runEmbedBackfill({ batchSize: ebBatchSize, sleepMs: ebSleepMs, json: !!ebOpts.json });
      console.log(ebOutput);
      break;
    }
    case 'cron': {
      const cronOpts = parseFlags([], ['json', 'full', 'no-quality-gate']);
      const { runCron } = await import('./cron.js');
      const cronOutput = await runCron({ json: !!cronOpts.json, full: !!cronOpts.full, noQualityGate: !!cronOpts['no-quality-gate'] });
      console.log(cronOutput);
      break;
    }
    case 'extract-sessions': {
      const esOpts = parseFlags(['limit', 'since', 'candidates'], ['dry-run', 'help', 'no-quality-gate']);
      if (esOpts.help || process.argv.includes('--help') || process.argv.includes('-h')) {
        console.log(`kivo extract-sessions - Extract knowledge from session history (FR-A05)

Usage:
  kivo extract-sessions [options]

Options:
  --candidates PATH  Use existing candidates JSON (skip Python preprocessor)
  --dry-run          Preview without writing to DB
  --limit N          Process only first N clusters
  --since DATE       Only process sessions after this date
  --help             Show this help message
  --no-quality-gate  Bypass FR-N05 intake quality gate

Examples:
  kivo extract-sessions --since 2026-01-01
  kivo extract-sessions --candidates ./candidates.json --dry-run
  kivo extract-sessions --limit 5`);
        break;
      }
      const { runExtractSessions } = await import('./extract-sessions.js');
      const esOutput = await runExtractSessions({
        dryRun: !!esOpts['dry-run'],
        limit: esOpts.limit ? parseInt(String(esOpts.limit), 10) : undefined,
        since: typeof esOpts.since === 'string' ? esOpts.since : undefined,
        candidates: typeof esOpts.candidates === 'string' ? esOpts.candidates : undefined,
        noQualityGate: !!esOpts['no-quality-gate'],
      });
      console.log(esOutput);
      break;
    }
    case 'deduplicate': {
      const dedupSubCmd = process.argv[3];
      const dedupOpts = parseFlags(['threshold', 'domain'], ['auto', 'json']);
      const { runDeduplicateCmd } = await import('./cmd-deduplicate.js');
      const dedupOutput = await runDeduplicateCmd(dedupSubCmd, {
        threshold: typeof dedupOpts.threshold === 'string' ? dedupOpts.threshold : undefined,
        auto: !!dedupOpts.auto,
        domain: typeof dedupOpts.domain === 'string' ? dedupOpts.domain : undefined,
        json: !!dedupOpts.json,
      });
      console.log(dedupOutput);
      break;
    }
    case 'learn-from-badcase': {
      const lbOpts = parseFlags(['source'], ['dry-run', 'json']);
      const { runLearnFromBadcase } = await import('./cmd-learn-from-badcase.js');
      const lbOutput = await runLearnFromBadcase({
        source: typeof lbOpts.source === 'string' ? lbOpts.source : undefined,
        dryRun: !!lbOpts['dry-run'],
        json: !!lbOpts.json,
      });
      console.log(lbOutput);
      break;
    }
    case 'audit-quality': {
      const aqOpts = parseFlags(['domain', 'threshold', 'limit'], ['json']);
      const { runAuditQuality } = await import('./cmd-audit-quality.js');
      const aqOutput = await runAuditQuality({
        domain: typeof aqOpts.domain === 'string' ? aqOpts.domain : undefined,
        threshold: aqOpts.threshold ? parseInt(String(aqOpts.threshold), 10) : undefined,
        limit: aqOpts.limit ? parseInt(String(aqOpts.limit), 10) : undefined,
        json: !!aqOpts.json,
      });
      console.log(aqOutput);
      break;
    }
    case 'upgrade-quality': {
      const uqOpts = parseFlags(['domain', 'threshold'], ['batch', 'dry-run', 'json']);
      const { runUpgradeQuality } = await import('./cmd-upgrade-quality.js');
      const uqOutput = await runUpgradeQuality({
        batch: !!uqOpts.batch,
        domain: typeof uqOpts.domain === 'string' ? uqOpts.domain : undefined,
        threshold: uqOpts.threshold ? parseInt(String(uqOpts.threshold), 10) : undefined,
        dryRun: !!uqOpts['dry-run'],
        json: !!uqOpts.json,
      });
      console.log(uqOutput);
      break;
    }
    case 'auto-govern': {
      const agOpts = parseFlags(['domain', 'threshold', 'similarity-threshold', 'output', 'quality-batch-size'], ['json', 'skip-quality']);
      const { runAutoGovernance } = await import('./auto-governance.js');
      const agOutput = await runAutoGovernance({
        domain: typeof agOpts.domain === 'string' ? agOpts.domain : undefined,
        threshold: agOpts.threshold ? parseInt(String(agOpts.threshold), 10) : undefined,
        similarityThreshold: agOpts['similarity-threshold'] ? parseFloat(String(agOpts['similarity-threshold'])) : undefined,
        output: typeof agOpts.output === 'string' ? agOpts.output : undefined,
        json: !!agOpts.json,
        skipQuality: !!agOpts['skip-quality'],
        qualityBatchSize: agOpts['quality-batch-size'] ? parseInt(String(agOpts['quality-batch-size']), 10) : undefined,
      });
      console.log(agOutput);
      break;
    }
    case 'watch-badcases': {
      const wbOpts = parseFlags(['dir', 'state-file', 'interval'], ['once', 'json']);
      if (typeof wbOpts.dir !== 'string') {
        console.error('Usage: kivo watch-badcases --dir <path> [--state-file <path>] [--interval 15000] [--once] [--json]');
        process.exitCode = 1;
        break;
      }
      const { runWatchBadcases } = await import('../governance/badcase-watcher.js');
      const wbOutput = await runWatchBadcases({
        dir: wbOpts.dir,
        stateFile: typeof wbOpts['state-file'] === 'string' ? wbOpts['state-file'] : undefined,
        intervalMs: wbOpts.interval ? parseInt(String(wbOpts.interval), 10) : undefined,
        once: !!wbOpts.once,
        json: !!wbOpts.json,
      });
      console.log(wbOutput);
      break;
    }
    case 'audit-value': {
      const avOpts = parseFlags(['domain', 'limit'], ['apply', 'json', 'help']);
      if (avOpts.help || process.argv.includes('--help') || process.argv.includes('-h')) {
        console.log(`kivo audit-value - Batch audit knowledge entries for value (FR-N04)

Usage:
  kivo audit-value [options]

Options:
  --domain <value>   Only audit entries in this domain
  --limit N          Max entries to audit
  --apply            Mark low-value entries as pending
  --json             Output as JSON
  --help             Show this help message

Examples:
  kivo audit-value --limit 50
  kivo audit-value --domain engineering --apply
  kivo audit-value --json`);
        break;
      }
      const { runAuditValue } = await import('./audit-value.js');
      const avOutput = await runAuditValue({
        domain: typeof avOpts.domain === 'string' ? avOpts.domain : undefined,
        limit: avOpts.limit ? parseInt(String(avOpts.limit), 10) : undefined,
        apply: !!avOpts.apply,
        json: !!avOpts.json,
      });
      console.log(avOutput);
      break;
    }
    case 'graph': {
      const graphSubCmd = process.argv[3];
      if (graphSubCmd === 'build') {
        const graphOpts = parseFlags([], ['json']);
        const { runGraphBuild } = await import('./graph-build.js');
        const graphOutput = await runGraphBuild({ json: !!graphOpts.json });
        console.log(graphOutput);
      } else {
        console.log('Usage:\n  kivo graph build [--json]    Build knowledge graph from entries');
        process.exitCode = graphSubCmd ? 1 : 0;
      }
      break;
    }
    case 'dict': {
      const dictSubCmd = process.argv[3];
      if (dictSubCmd === 'seed') {
        const dictOpts = parseFlags(['limit'], ['json']);
        const { runDictSeed } = await import('./dict-seed.js');
        const dictOutput = await runDictSeed({
          limit: dictOpts.limit ? parseInt(String(dictOpts.limit), 10) : undefined,
          json: !!dictOpts.json,
        });
        console.log(dictOutput);
      } else {
        console.log('Usage:\n  kivo dict seed [--json] [--limit N]    Seed dictionary with core terms');
        process.exitCode = dictSubCmd ? 1 : 0;
      }
      break;
    }
    case 'retag': {
      const retagOpts = parseFlags(['limit', 'domain'], ['dry-run', 'json', 'help']);
      if (retagOpts.help || process.argv.includes('--help') || process.argv.includes('-h')) {
        console.log(`kivo retag - Re-tag entries with multi-dimensional labels (FR-B05)

Usage:
  kivo retag [options]

Options:
  --dry-run          Preview tag changes without writing
  --limit N          Only retag first N untagged entries
  --domain <value>   Only retag entries in the specified knowledge domain
  --json             Output as JSON
  --help             Show this help message

Examples:
  kivo retag --dry-run
  kivo retag --limit 20 --domain agent-scheduling
  kivo retag --json`);
        break;
      }
      const { runRetag } = await import('./retag.js');
      const retagOutput = await runRetag({
        dryRun: !!retagOpts['dry-run'],
        limit: retagOpts.limit ? parseInt(String(retagOpts.limit), 10) : undefined,
        domain: typeof retagOpts.domain === 'string' ? retagOpts.domain : undefined,
        json: !!retagOpts.json,
      });
      console.log(retagOutput);
      break;
    }
    default:
      console.log(`kivo - Agent Knowledge Iteration Engine

Usage:
  kivo health                    Check environment and dependencies
  kivo init [--interactive]      Initialize config file (default: non-interactive)
  kivo query <text>              Search knowledge base
  kivo add <type> <title>        Add a knowledge entry
  kivo list                      List knowledge entries
  kivo update <id>               Update a knowledge entry
  kivo delete <id>               Delete a knowledge entry
  kivo config-check              Validate current configuration
  kivo env                       Show environment variable mappings
  kivo capabilities              Show available system capabilities
  kivo doc-gate [docs] [src]     Check doc-code consistency (--strict for strict mode)
  kivo migrate [status|up|notes] Database migration management
  kivo governance <sub>          Intent governance (run|report|config)
  kivo ingest                    Ingest workspace markdown files into knowledge base
  kivo enrich-intents             Backfill similar sentences for intent entries
  kivo embed-backfill            Batch-generate BGE embeddings for entries missing them
  kivo cron                      Incremental ingest (for crontab use)
  kivo extract-sessions          Extract knowledge from session history (FR-A05)
  kivo deduplicate [scan]        MECE semantic dedup scan (FR-N01)
  kivo deduplicate coverage      Coverage audit against domain keyQuestions
  kivo graph build               Build knowledge graph from entries
  kivo dict seed                 Seed dictionary with core terms
  kivo retag                     Re-tag entries with multi-dimensional labels (FR-B05)
  kivo learn-from-badcase        Convert badcases into intent knowledge (FR-N02)
  kivo audit-quality             Assess knowledge entry quality (FR-N03)
  kivo upgrade-quality           Batch rewrite low-quality entries (FR-N03)
  kivo auto-govern               Run scheduled governance + quality rewrite (FR-N04)
  kivo audit-value               Batch audit knowledge entry value (FR-N04)
  kivo watch-badcases            Watch badcase directories and auto-learn (FR-N05)
  kivo consistency-check         Check knowledge entry consistency (CI gate)

Auto-Govern Options:
  --domain <value>               Filter governance to one domain
  --threshold <N>                Quality rewrite threshold (default 2)
  --similarity-threshold <N>     Dedup similarity threshold (default 0.80)
  --output <path>                Write report to file
  --json                         Output as JSON

Watch-Badcases Options:
  --dir <path>                   Directory to watch for badcase files
  --state-file <path>            State file for processed mtimes
  --interval <ms>                Polling interval in milliseconds
  --once                         Run one scan and exit
  --json                         Output as JSON

Extract Sessions Options:
  --candidates PATH  Use existing candidates JSON (skip Python preprocessor)
  --dry-run          Preview without writing to DB
  --limit N          Process only first N clusters
  --since DATE       Only process sessions after this date

Learn-from-Badcase Options:
  --source <path>    File or directory containing badcase records
  --dry-run          Preview without writing to DB
  --json             Output as JSON

Audit-Quality Options:
  --domain <value>   Filter by knowledge domain
  --threshold <N>    Custom failing threshold (default 2)
  --json             Output as JSON

Upgrade-Quality Options:
  --batch            Enable batch rewrite mode
  --domain <value>   Filter by knowledge domain
  --threshold <N>    Custom failing threshold (default 2)
  --dry-run          Preview without writing to DB
  --json             Output as JSON

Retag Options:
  --dry-run          Preview tag changes without writing
  --limit N          Only retag first N untagged entries
  --json             Output as JSON

Audit-Value Options:
  --domain <value>   Filter by knowledge domain
  --limit N          Max entries to audit
  --apply            Mark low-value entries as pending
  --json             Output as JSON

Deduplicate Options:
  --threshold 0.80   Similarity threshold (default 0.80)
  --auto             Auto-merge entries with similarity > 0.95
  --domain <value>   Limit scan to a specific domain
  --json             Output as JSON

Search Options:
  --nature <type>    Filter by nature: fact/concept/rule/procedure/heuristic
  --function <type>  Filter by function: routing/quality_gate/context_enrichment/decision_support/correction
  --domain <label>   Filter by knowledge domain

Ingest Options:
  --dir "path1,path2"  Additional directories to scan
  --file "a.md,b.md"   Additional files to scan
  --llm                (default, kept for backward compatibility)
  --json               Output as JSON
  --full               Force full re-ingest (cron only)

CRUD Options:
  --content "..."      Entry content text
  --tags "a,b,c"       Comma-separated tags
  --source "..."       Source reference
  --confidence 0.8     Confidence score (0-1)
  --domain "..."       Knowledge domain
  --status active      Entry status
  --type fact          Filter by type (list)
  --limit 20           Max results (list)
  --offset 0           Skip results (list)
  --force              Skip confirmation (delete)
  --json               Output as JSON

General Options:
  --yes, -y            Non-interactive mode (default, kept for backward compat)
  --interactive, -i    Enable interactive prompts
  --strict             Strict mode for doc-gate`);
      process.exitCode = (command && command !== '--help' && command !== '-h') ? 1 : 0;
  }
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
