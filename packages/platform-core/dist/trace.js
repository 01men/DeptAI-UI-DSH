import { randomBytes } from "node:crypto";
const TRACEPARENT_VERSION = "00";
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const PARENT_ID_RE = /^[0-9a-f]{16}$/;
const FLAGS_RE = /^[0-9a-f]{2}$/;
function newTraceId() {
  const id = randomBytes(16).toString("hex");
  return id === "0".repeat(32) ? randomBytes(16).toString("hex") : id;
}
function parseTraceparent(header) {
  if (typeof header !== "string") return null;
  const parts = header.split("-");
  if (parts.length !== 4) return null;
  const [version, traceId, parentId, flags] = parts;
  if (version !== TRACEPARENT_VERSION) return null;
  if (!TRACE_ID_RE.test(traceId) || /^0+$/.test(traceId)) return null;
  if (!PARENT_ID_RE.test(parentId) || /^0+$/.test(parentId)) return null;
  if (!FLAGS_RE.test(flags)) return null;
  return { version, traceId, parentId, flags };
}
function formatTraceparent(traceId, parentId, flags = "01") {
  if (!TRACE_ID_RE.test(traceId) || /^0+$/.test(traceId)) {
    throw new Error(`\u975E\u6CD5 traceId\uFF08\u987B\u4E3A 32 \u4F4D\u975E\u5168\u96F6 hex\uFF09\uFF1A${traceId}`);
  }
  const parent = parentId ?? randomBytes(8).toString("hex");
  if (!PARENT_ID_RE.test(parent) || /^0+$/.test(parent)) {
    throw new Error(`\u975E\u6CD5 parentId\uFF08\u987B\u4E3A 16 \u4F4D\u975E\u5168\u96F6 hex\uFF09\uFF1A${parent}`);
  }
  if (!FLAGS_RE.test(flags)) {
    throw new Error(`\u975E\u6CD5 trace flags\uFF08\u987B\u4E3A 2 \u4F4D hex\uFF09\uFF1A${flags}`);
  }
  return `${TRACEPARENT_VERSION}-${traceId}-${parent}-${flags}`;
}
export {
  formatTraceparent,
  newTraceId,
  parseTraceparent
};
