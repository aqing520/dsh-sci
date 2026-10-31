import path from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { ResearchRepository } from "../dist/src/research/repository.js";
import { ResearchOrchestrator } from "../dist/src/research/orchestrator.js";
import { inspectCaseProtocolBinding } from "./research-case-protocol.mjs";

function within(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Case paths must remain inside the selected validation directory");
}

/** Opening a case only reads its authoritative repository. No recovery, approval,
 * model request or candidate execution takes place here. */
export async function loadCaseWorkspace(casePath, casesRoot) {
  const parent = await realpath(casesRoot), directory = await realpath(casePath);
  within(parent, directory);
  const repositoryRoot = await realpath(path.join(directory, "runtime/research"));
  const workspace = await realpath(path.join(directory, "runtime/workspace"));
  within(directory, repositoryRoot); within(directory, workspace);
  const summary = JSON.parse(await readFile(path.join(directory, "summary.json"), "utf8"));
  const protocol = JSON.parse(await readFile(path.join(directory, "protocol.json"), "utf8"));
  const repository = new ResearchRepository(repositoryRoot);
  const projects = await repository.listProjects(10_000);
  if (projects.length !== 1 || projects[0].projectId !== summary.projectId) throw new Error("Case must contain exactly its declared project");
  const projectId = projects[0].projectId;
  const snapshot = await repository.exportProject(projectId);
  const binding = inspectCaseProtocolBinding(protocol, snapshot.project.question);
  if (binding.status !== "bound") throw new Error(binding.issues.join(" "));
  const orchestrator = new ResearchOrchestrator(repository, {}, undefined, { experimentPolicy: { workspaceRoot: workspace } });
  return { directory, workspace, repository, orchestrator, projectId, summary };
}

/** Additional case scope and preview gates, on top of the production window
 * registry and kernel's immutable proposal/launch checks. */
export function registerCaseWorkspaceIpc(registrar, context) {
  const { repository, orchestrator, projectId, summary } = context;
  const previews = new WeakMap();
  const scope = (id) => { if (id !== projectId) throw new Error("This window is scoped to one research case"); };
  const definition = async (input) => {
    scope(input?.projectId);
    const snapshot = await repository.exportProject(projectId);
    const experiment = snapshot.experiments.find((item) => item.experimentId === input?.experimentId);
    if (!experiment || experiment.planId !== snapshot.project.planId || !input?.contentHash || input.contentHash !== experiment.proposalContentHash) throw new Error("Proposal changed; refresh and review its current contents");
    return { snapshot, experiment };
  };
  const requirePreview = (event, experiment) => {
    if (previews.get(event.sender)?.get(experiment.experimentId) !== experiment.proposalContentHash) throw new Error("View every bound code/input file in this window before approval or execution");
  };
  registrar.handle("research:list", () => repository.listProjects(1));
  registrar.handle("research:export", async (_event, id) => { scope(id); return { ...await repository.exportProject(projectId), caseProvenance: { planOrigin: summary.planOrigin, operatorActions: summary.operatorActions ?? [], scientificQuality: summary.scientificQuality } }; });
  registrar.handle("research:experiment-review", async (event, input) => {
    const { experiment } = await definition(input);
    const entries = previews.get(event.sender) ?? new Map();
    entries.delete(experiment.experimentId); previews.set(event.sender, entries);
    const review = await orchestrator.experimentReview(projectId, experiment.experimentId);
    if (review.proposalContentHash !== experiment.proposalContentHash || !review.files.length || review.files.some((file) => file.truncated || !file.exists || !file.sha256)) throw new Error("Full bound contents unavailable; review outside this window and prepare a fully reviewable proposal");
    entries.set(experiment.experimentId, experiment.proposalContentHash);
    return review;
  });
  registrar.handle("research:approve", async (_event, input) => {
    scope(input?.projectId);
    const snapshot = await repository.exportProject(projectId);
    if (!input?.planId || input.planId !== snapshot.project.planId || !snapshot.plan?.tasks.some((task) => task.taskId === input.taskId && task.status === "waiting-approval")) throw new Error("Task or plan changed; refresh before approval");
    return orchestrator.approveTask(projectId, input.taskId);
  });
  registrar.handle("research:approve-experiment", async (event, input) => {
    const { experiment } = await definition(input);
    requirePreview(event, experiment);
    return orchestrator.approveExperiment(projectId, experiment.experimentId, input.contentHash);
  });
  registrar.handle("research:execute-experiment", async (event, input) => {
    const { snapshot, experiment } = await definition(input);
    requirePreview(event, experiment);
    if (input.approved !== true || !experiment.approval || experiment.approval.proposalContentHash !== input.contentHash) throw new Error("Approve the exact proposal before separately requesting execution");
    if (snapshot.experimentRuns.some((run) => run.experimentId === experiment.experimentId)) throw new Error("This proposal already has a run; inspect it and prepare a new proposal for another execution");
    return orchestrator.executeExperiment(projectId, experiment.experimentId, { approved: true });
  });
}
