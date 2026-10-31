// Operator-authorized static revision tooling. Never executes a candidate.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ResearchRepository } from '../dist/src/research/repository.js';
import { ResearchOrchestrator } from '../dist/src/research/orchestrator.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'research/validation/cases/imputation-v1-1793358639679');
const repository = new ResearchRepository(path.join(directory, 'runtime/research'));
const orchestrator = new ResearchOrchestrator(repository, {}, undefined, { experimentPolicy: { workspaceRoot: path.join(directory, 'runtime/workspace') } });
const [project] = await repository.listProjects(10000);
const snapshot = await repository.exportProject(project.projectId);
const task = snapshot.plan.tasks.find(t => t.taskId === 'task-06');
const [mode, argument] = process.argv.slice(2);
if (mode === 'activate') {
  if (task.status === 'waiting-approval') await orchestrator.approveTask(project.projectId, task.taskId);
  else if (task.status !== 'running') throw new Error('Expected an approved running revision task');
  console.log('Revision task activated; this approves neither design nor execution.');
} else if (mode === 'stage') {
  const sourceDirectory = path.resolve(argument);
  const names = await readdir(sourceDirectory);
  const files = await Promise.all(names.filter(n => !n.startsWith('.')).map(async name => ({name, kind: name.endsWith('.mjs') ? 'code' : 'input', content: await readFile(path.join(sourceDirectory, name), 'utf8')})));
  const result = await orchestrator.stageCode(project.projectId, {baseBundleId:'bundle-a5c41e60978543543cae18b29d0471789cc92cef8001f484fd29548c086d054b',files});
  await mkdir(path.join(directory, 'revision-review'), {recursive:true});
  await writeFile(path.join(directory, 'revision-review/staged-bundle.json'), JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({bundleId:result.bundleId,files:result.files.map(f=>({name:f.name,hash:f.contentHash})),syntaxChecks:result.syntaxChecks},null,2));
} else if (mode === 'read') {
  const bundle = await repository.readCodeBundle(project.projectId, argument);
  if (!bundle) throw new Error('Unknown bundle');
  for (const file of bundle.files) {
    let offset = 0;
    do {
      const part = await orchestrator.readCode(project.projectId, {bundleId:bundle.bundleId,fileName:file.name,offset,limit:12000});
      console.log(JSON.stringify({name:file.name,offset:part.offset,endOffset:part.endOffset,text:part.text}));
      offset = part.nextOffset;
    } while (offset !== undefined);
  }
} else if (mode === 'review') {
  const input = JSON.parse(await readFile(argument,'utf8'));
  const result = await orchestrator.reviewCode(project.projectId,input);
  console.log(JSON.stringify(result,null,2));
} else if (mode === 'checkpoint') {
  const input = JSON.parse(await readFile(argument,'utf8'));
  const current = (await repository.exportProject(project.projectId)).plan.tasks.find(t=>t.taskId===task.taskId);
  if(current.status!=='running') throw new Error('Task must still be running');
  const result = await orchestrator.submitTaskResult(project.projectId, {
    schema:'dsh-sci.research-task-result.v2', projectId:project.projectId,taskId:task.taskId,planId:project.planId,
    attemptId:current.attemptId,submissionId:'result-'+current.attemptId,expectedTaskVersion:current.stateVersion,
    status:'needs-approval',summary:input.summary,nextAction:input.nextAction,refs:input.refs,claims:[],evidence:[]
  });
  console.log(JSON.stringify(result,null,2));
} else throw new Error('Use activate, stage <folder>, read <bundleId>, review <input.json>, or checkpoint <input.json>');
