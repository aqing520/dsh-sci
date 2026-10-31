export interface ResearchSearchLog {
  schema: "dsh-sci.search-log.v1";
  searchId: string;
  projectId: string;
  query: string;
  provider: string;
  startedAt: string;
  finishedAt?: string;
  actor: "agent" | "workspace";
  planId?: string;
  taskId?: string;
  status: "pending" | "completed" | "failed" | "cancelled";
  pagination: { supported: false; page: 1; requestedLimit: number };
  resultCount?: number;
  ignoredBeyondLimit?: number;
  results: Array<{ rank: number; title?: string; url?: string; sourceId?: string; decision: "retained" | "duplicate" | "filtered"; reason: string }>;
  failureKind?: string;
}
