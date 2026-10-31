import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { assertStagedFileName, type ResearchCodeBundle } from "./code-staging.js";
import { contentDigest } from "./content-digest.js";

export interface CodeExecutionScope { projectId: string; planId: string; taskId: string; attemptId: string; }
export interface ResearchCodeRead extends CodeExecutionScope {
  schema: "dsh-sci.code-read.v1";
  codeReadId: string;
  bundleId: string;
  bundleContentHash: string;
  fileName: string;
  contentHash: string;
  characters: number;
  offset: number;
  endOffset: number;
  actor: "agent";
  readAt: string;
}
export interface CodeReviewFinding {
  severity: "blocker" | "warning" | "info";
  fileName: string;
  startOffset: number;
  endOffset: number;
  message: string;
  recommendation: string;
}
export interface CodeReviewInput {
  bundleId: string;
  designId?: string;
  summary: string;
  findings: CodeReviewFinding[];
  limitations: string[];
}
export interface ResearchCodeReview extends CodeExecutionScope {
  schema: "dsh-sci.code-review.v1";
  codeReviewId: string;
  bundleId: string;
  bundleContentHash: string;
  designBinding?: { designId: string; contentHash: string };
  files: Array<{ name: string; contentHash: string; characters: number }>;
  codeReadIds: string[];
  actor: "agent";
  status: "findings-recorded" | "no-findings-reported";
  scientificQuality: "not-reviewed";
  summary: string;
  findings: CodeReviewFinding[];
  limitations: string[];
  createdAt: string;
}
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
const sha = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const boundedText = (value: unknown, field: string, max = 4000): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid code review ${field}`);
  return value.trim();
};
function inside(root: string, target: string) {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Code read must stay inside its registered bundle");
}
export function validateCodeBundleForRead(bundle: ResearchCodeBundle): void {
  if (!bundle || bundle.schema !== "dsh-sci.research-code-bundle.v1" || !id(bundle.projectId) || !id(bundle.planId) || !id(bundle.taskId) || !Array.isArray(bundle.files) || !bundle.files.length || bundle.files.length > 20) throw new Error("Invalid code bundle for reading");
  for (const file of bundle.files) {
    assertStagedFileName(file.name);
    if (!["code", "input", "dependency"].includes(file.kind) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 128 * 1024 || !sha(file.contentHash)) throw new Error("Invalid code file manifest");
  }
  if (new Set(bundle.files.map((file) => file.name.toLowerCase())).size !== bundle.files.length || bundle.files.reduce((sum, file) => sum + file.bytes, 0) > 512 * 1024) throw new Error("Invalid code bundle manifest");
  const scope = { projectId: bundle.projectId, planId: bundle.planId, taskId: bundle.taskId };
  const expected = hash(JSON.stringify({ ...scope, files: [...bundle.files].sort((a, b) => a.name.localeCompare(b.name)).map(({ name, kind, contentHash }) => ({ name, kind, contentHash })) }));
  if (bundle.contentHash !== expected || bundle.bundleId !== `bundle-${expected}`) throw new Error("Code bundle identity does not match its manifest");
}

/** Read only a registered, hash-verified file. No source is imported or run. */
export async function readStagedCodeFile(workspaceRoot: string, bundle: ResearchCodeBundle, fileName: string): Promise<string> {
  validateCodeBundleForRead(bundle);
  const file = bundle.files.find((item) => item.name === fileName);
  if (!file) throw new Error("File is not registered in this code bundle");
  const root = await realpath(workspaceRoot);
  const expectedBase = path.join(root, ".dsh-sci", "experiments", hash(bundle.projectId).slice(0, 32), bundle.bundleId);
  if (path.resolve(bundle.directory) !== expectedBase || path.resolve(file.path) !== path.join(expectedBase, file.name)) throw new Error("Code read must use the registered staging location");
  const target = path.join(expectedBase, file.name);
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Code read cannot follow symbolic links or junctions");
    inside(root, await realpath(current));
  }
  inside(expectedBase, await realpath(target));
  const handle = await open(target, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== file.bytes) throw new Error("Staged code changed since registration");
    // A concurrent append cannot grow an unbounded read.
    const buffer = Buffer.alloc(file.bytes + 1);
    let offset = 0;
    while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null); if (!bytesRead) break; offset += bytesRead; }
    const bytes = buffer.subarray(0, offset);
    if (offset !== file.bytes || hash(bytes) !== file.contentHash) throw new Error("Staged code changed since registration");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally { await handle.close(); }
}

export function validateCodeRead(value: ResearchCodeRead, projectId: string): ResearchCodeRead {
  if (!value || value.schema !== "dsh-sci.code-read.v1" || value.projectId !== projectId || ![value.codeReadId, value.projectId, value.planId, value.taskId, value.attemptId, value.bundleId].every(id) || value.actor !== "agent" || !sha(value.contentHash) || !sha(value.bundleContentHash) || !Number.isSafeInteger(value.characters) || value.characters < 1 || !Number.isSafeInteger(value.offset) || value.offset < 0 || !Number.isSafeInteger(value.endOffset) || value.endOffset <= value.offset || value.endOffset > value.characters || value.endOffset - value.offset > 12000 || !Number.isFinite(Date.parse(value.readAt))) throw new Error("Invalid code read receipt");
  assertStagedFileName(value.fileName);
  return value;
}

export function codeReadsCoverFiles(scope: CodeExecutionScope, bundle: ResearchCodeBundle, files: ResearchCodeReview["files"], receipts: ResearchCodeRead[]): boolean {
  if (files.length !== bundle.files.length) return false;
  return bundle.files.every((file) => {
    const description = files.find((item) => item.name === file.name && item.contentHash === file.contentHash);
    if (!description || !Number.isSafeInteger(description.characters) || description.characters < 1) return false;
    let covered = 0;
    const ranges = receipts.filter((receipt) => receipt.projectId === scope.projectId && receipt.planId === scope.planId && receipt.taskId === scope.taskId && receipt.attemptId === scope.attemptId && receipt.actor === "agent" && receipt.bundleId === bundle.bundleId && receipt.bundleContentHash === bundle.contentHash && receipt.fileName === file.name && receipt.contentHash === file.contentHash && receipt.characters === description.characters).sort((a, b) => a.offset - b.offset);
    for (const range of ranges) { if (range.offset > covered) return false; covered = Math.max(covered, range.endOffset); }
    return covered >= description.characters;
  });
}

export function makeCodeReview(scope: CodeExecutionScope, bundle: ResearchCodeBundle, files: ResearchCodeReview["files"], reads: ResearchCodeRead[], input: CodeReviewInput, designBinding?: ResearchCodeReview["designBinding"]): ResearchCodeReview {
  if (!Array.isArray(input.findings) || input.findings.length > 50 || !Array.isArray(input.limitations) || !input.limitations.length || input.limitations.length > 20) throw new Error("Code review requires bounded findings and explicit limitations");
  const findings = input.findings.map((finding) => {
    const file = files.find((file) => file.name === finding?.fileName);
    if (!file || !["blocker", "warning", "info"].includes(finding.severity) || !Number.isSafeInteger(finding.startOffset) || finding.startOffset < 0 || !Number.isSafeInteger(finding.endOffset) || finding.endOffset <= finding.startOffset || finding.endOffset > file.characters) throw new Error("Code review finding requires a valid file and character range");
    return { severity: finding.severity, fileName: finding.fileName, startOffset: finding.startOffset, endOffset: finding.endOffset, message: boundedText(finding.message, "finding"), recommendation: boundedText(finding.recommendation, "recommendation") };
  });
  if (!codeReadsCoverFiles(scope, bundle, files, reads)) throw new Error("Code review requires complete current-attempt reads of every bundled file");
  const record = { schema: "dsh-sci.code-review.v1" as const, ...scope, bundleId: bundle.bundleId, bundleContentHash: bundle.contentHash, ...(designBinding ? { designBinding } : {}), files,
    codeReadIds: [...new Set(reads.map((read) => read.codeReadId))].sort(), actor: "agent" as const, status: findings.length ? "findings-recorded" as const : "no-findings-reported" as const, scientificQuality: "not-reviewed" as const,
    summary: boundedText(input.summary, "summary"), findings, limitations: input.limitations.map((value) => boundedText(value, "limitation")) };
  return { ...record, codeReviewId: `code-review-${contentDigest(record)}`, createdAt: new Date().toISOString() };
}

export function validateCodeReview(review: ResearchCodeReview, projectId: string): ResearchCodeReview {
  if (!review || review.schema !== "dsh-sci.code-review.v1" || review.projectId !== projectId || ![review.projectId, review.planId, review.taskId, review.attemptId, review.bundleId].every(id) || review.actor !== "agent" || review.scientificQuality !== "not-reviewed" || !sha(review.bundleContentHash) || !Array.isArray(review.files) || !review.files.length || review.files.length > 20 || !Array.isArray(review.codeReadIds) || !review.codeReadIds.length || review.codeReadIds.length > 1000 || !review.codeReadIds.every(id) || !Number.isFinite(Date.parse(review.createdAt))) throw new Error("Invalid code review record");
  boundedText(review.summary, "summary");
  if (!Array.isArray(review.findings) || review.findings.length > 50 || !Array.isArray(review.limitations) || !review.limitations.length || review.limitations.length > 20 || new Set(review.files.map((file) => file.name)).size !== review.files.length) throw new Error("Invalid code review details");
  for (const file of review.files) {
    assertStagedFileName(file.name);
    if (!sha(file.contentHash) || !Number.isSafeInteger(file.characters) || file.characters < 1 || file.characters > 128 * 1024) throw new Error("Invalid code review file");
  }
  if (review.designBinding && (!id(review.designBinding.designId) || !sha(review.designBinding.contentHash))) throw new Error("Invalid code review design binding");
  for (const finding of review.findings) {
    const file = review.files.find((file) => file.name === finding?.fileName);
    if (!file || !["blocker", "warning", "info"].includes(finding.severity) || !Number.isSafeInteger(finding.startOffset) || finding.startOffset < 0 || !Number.isSafeInteger(finding.endOffset) || finding.endOffset <= finding.startOffset || finding.endOffset > file.characters) throw new Error("Invalid code review finding range");
    boundedText(finding.message, "finding"); boundedText(finding.recommendation, "recommendation");
  }
  for (const limitation of review.limitations) boundedText(limitation, "limitation");
  const { codeReviewId, createdAt: _createdAt, ...record } = review;
  if (codeReviewId !== `code-review-${contentDigest(record)}` || !Array.isArray(review.findings) || review.status !== (review.findings.length ? "findings-recorded" : "no-findings-reported")) throw new Error("Code review hash or status is invalid");
  return review;
}
