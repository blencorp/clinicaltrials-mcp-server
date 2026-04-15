import { createHash, randomUUID } from "node:crypto";
import { logger } from "../util/logger.js";

export interface ApiCallTrace {
  id: string;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  cacheHit: boolean;
  bytes: number;
  error?: string;
}

export interface AuditContext {
  subject?: string;
  traceId: string;
  startedAt: number;
  calls: ApiCallTrace[];
}

export function newAuditContext(subject?: string): AuditContext {
  const ctx: AuditContext = {
    traceId: randomUUID(),
    startedAt: Date.now(),
    calls: [],
  };
  if (subject !== undefined) ctx.subject = subject;
  return ctx;
}

export function recordCall(ctx: AuditContext, trace: ApiCallTrace): void {
  ctx.calls.push(trace);
  logger.info("upstream.call", {
    traceId: ctx.traceId,
    ...(ctx.subject !== undefined ? { subjectHash: hashSubject(ctx.subject) } : {}),
    ...redactedTrace(trace),
  });
}

function hashSubject(subject: string): string {
  return createHash("sha256").update(subject).digest("hex").slice(0, 16);
}

function redactedTrace(trace: ApiCallTrace): ApiCallTrace {
  return {
    ...trace,
    url: redactUrl(trace.url),
  };
}

function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, "REDACTED");
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}
