import { Kivo } from './src/kivo.ts';

const kivo = new Kivo({
  dbPath: ':memory:',
  pipelineOptions: { extractor: { minContentLength: 10 } },
  llmProvider: { async judgeConflict(){ return 'conflict'; } },
  conflictThreshold: 0,
});

await kivo.init();
const r1 = await kivo.ingest('The Earth revolves around the Sun in approximately 365 days according to astronomical observations.','source-a');
const r2 = await kivo.ingest('The Earth revolves around the Sun in approximately 400 days according to astronomical observations.','source-b');
console.log(JSON.stringify({
  r1: { entries: r1.entries.length, conflicts: r1.conflicts.length, entriesData: r1.entries.map(e=>({id:e.id,type:e.type,title:e.title,content:e.content})) },
  r2: { entries: r2.entries.length, conflicts: r2.conflicts.length, entriesData: r2.entries.map(e=>({id:e.id,type:e.type,title:e.title,content:e.content})) },
  factCount: (await kivo.getRepository().findByType('fact')).length,
  all: (await kivo.getRepository().findAll()).map(e=>({id:e.id,type:e.type,title:e.title,content:e.content}))
}, null, 2));
await kivo.shutdown();
