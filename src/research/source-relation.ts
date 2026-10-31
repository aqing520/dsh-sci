import { createHash } from "node:crypto";

export type SourceRelationKind = "same-work" | "preprint-of" | "version-of" | "replication-of" | "correction-of" | "related";

export interface ResearchSourceRelation {
  schema: "dsh-sci.research-source-relation.v1";
  relationId: string;
  projectId: string;
  fromSourceId: string;
  toSourceId: string;
  kind: SourceRelationKind;
  countsAsIndependent: boolean;
  note: string;
  actor: "trusted-workspace";
  reviewedAt: string;
}

const kinds = new Set<SourceRelationKind>(["same-work", "preprint-of", "version-of", "replication-of", "correction-of", "related"]);
const text = (value: unknown, field: string, max = 4000): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  if (value.trim().length > max) throw new Error(`${field} is too long`);
  return value.trim();
};

export function sourceRelationId(projectId: string, fromSourceId: string, toSourceId: string, kind: SourceRelationKind): string {
  return `relation-${createHash("sha256").update(JSON.stringify({ projectId, fromSourceId, toSourceId, kind })).digest("hex")}`;
}

export function makeSourceRelation(projectId: string, input: { fromSourceId: string; toSourceId: string; kind: SourceRelationKind; countsAsIndependent: boolean; note: string }, now = new Date().toISOString()): ResearchSourceRelation {
  const fromSourceId = text(input.fromSourceId, "sourceRelation.fromSourceId", 256);
  const toSourceId = text(input.toSourceId, "sourceRelation.toSourceId", 256);
  if (fromSourceId === toSourceId) throw new Error("A source cannot be related to itself");
  if (!kinds.has(input.kind)) throw new Error("Unknown source relation kind");
  if (typeof input.countsAsIndependent !== "boolean") throw new Error("sourceRelation.countsAsIndependent must be boolean");
  if (["same-work", "preprint-of", "version-of", "correction-of"].includes(input.kind) && input.countsAsIndependent) throw new Error("Versions of the same work cannot count as independent evidence");
  const note = text(input.note, "sourceRelation.note");
  return { schema: "dsh-sci.research-source-relation.v1", relationId: sourceRelationId(projectId, fromSourceId, toSourceId, input.kind), projectId, fromSourceId, toSourceId, kind: input.kind, countsAsIndependent: input.countsAsIndependent, note, actor: "trusted-workspace", reviewedAt: now };
}

export function validateSourceRelation(value: unknown, projectId?: string): ResearchSourceRelation {
  const relation = value as Partial<ResearchSourceRelation>;
  if (!relation || relation.schema !== "dsh-sci.research-source-relation.v1" || typeof relation.relationId !== "string" || typeof relation.projectId !== "string" || (projectId !== undefined && relation.projectId !== projectId) || typeof relation.fromSourceId !== "string" || typeof relation.toSourceId !== "string" || relation.fromSourceId === relation.toSourceId || !kinds.has(relation.kind as SourceRelationKind) || typeof relation.countsAsIndependent !== "boolean" || relation.actor !== "trusted-workspace" || typeof relation.reviewedAt !== "string" || typeof relation.note !== "string") throw new Error("Invalid research source relation");
  if (relation.relationId !== sourceRelationId(relation.projectId, relation.fromSourceId, relation.toSourceId, relation.kind as SourceRelationKind)) throw new Error("Source relation identity mismatch");
  makeSourceRelation(relation.projectId, { fromSourceId: relation.fromSourceId, toSourceId: relation.toSourceId, kind: relation.kind as SourceRelationKind, countsAsIndependent: relation.countsAsIndependent, note: relation.note }, relation.reviewedAt);
  return relation as ResearchSourceRelation;
}

export const sourceRelationKinds: SourceRelationKind[] = ["same-work", "preprint-of", "version-of", "replication-of", "correction-of", "related"];
