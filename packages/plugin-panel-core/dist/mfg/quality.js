import { createHash } from "node:crypto";
import { skills } from "./skills.js";
import { checkModelOutputSchema, fail } from "./validate.js";
const skillHash = (id) => createHash("sha256").update(JSON.stringify(skills[id] ?? null)).digest("hex");
const modelIdentityHash = (identity) => createHash("sha256").update(JSON.stringify({ model: identity.model, endpoint: identity.endpoint ?? "" })).digest("hex");
class MemoryReleaseStore {
  map = /* @__PURE__ */ new Map();
  get(skillId) {
    return this.map.get(skillId);
  }
  put(release) {
    this.map.set(release.skillId, release);
  }
  remove(skillId) {
    this.map.delete(skillId);
  }
  list() {
    return [...this.map.values()];
  }
}
const RELEASE_TTL_DAYS = 30;
function releaseReady(store, skillId, identity, now = Date.now()) {
  const release = store.get(skillId);
  if (!release) return { ready: false, reason: "\u5C1A\u65E0\u653E\u884C\u8BB0\u5F55\uFF1A\u9700\u5148\u5B8C\u6210\u771F\u5B9E\u6A21\u578B\u8BC4\u4F30\u4E0E\u9886\u57DF\u5BA1\u9605" };
  if (release.skillHash !== skillHash(skillId)) return { ready: false, reason: "Skill \u5185\u6838\u5DF2\u53D8\u66F4\uFF0C\u539F\u653E\u884C\u8BB0\u5F55\u5931\u6548\uFF0C\u9700\u91CD\u65B0\u8BC4\u4F30" };
  if (release.modelHash !== modelIdentityHash(identity)) return { ready: false, reason: "\u6A21\u578B\u914D\u7F6E\u5DF2\u53D8\u66F4\uFF0C\u539F\u653E\u884C\u8BB0\u5F55\u5931\u6548\uFF0C\u9700\u91CD\u65B0\u8BC4\u4F30" };
  if (!release.approvedBy?.trim()) return { ready: false, reason: "\u653E\u884C\u8BB0\u5F55\u7F3A\u5C11\u5BA1\u6838\u4EBA" };
  const expires = Date.parse(release.expiresAt);
  if (!Number.isFinite(expires) || expires <= now) return { ready: false, reason: "\u653E\u884C\u8BB0\u5F55\u5DF2\u5230\u671F\uFF0C\u9700\u91CD\u65B0\u8BC4\u4F30\u4E0E\u5BA1\u9605" };
  return { ready: true };
}
function buildRelease(report, reportText, reviewer, reviewKind, now = Date.now()) {
  if (!reviewer?.trim() || reviewer.startsWith("--")) fail("REVIEW_REQUIRED", "\u5BA1\u6838\u4EBA\u4E0D\u80FD\u4E3A\u7A7A", 400);
  if (report.status !== "passed") fail("REPORT_NOT_PASSED", "\u8BC4\u4F30\u62A5\u544A\u672A\u901A\u8FC7\uFF0C\u62D2\u7EDD\u653E\u884C", 400);
  if (report.live !== true) fail("REPORT_NOT_LIVE", "\u62A5\u544A\u975E\u771F\u5B9E\u6A21\u578B\u8C03\u7528\u4EA7\u751F\uFF08mock \u6216\u672A\u6267\u884C\uFF09\uFF0C\u62D2\u7EDD\u653E\u884C", 400);
  if (report.repetitions < 3) fail("REPORT_INSUFFICIENT", "\u8BC4\u4F30\u91CD\u590D\u6B21\u6570\u4E0D\u8DB3\uFF08\u6BCF\u7528\u4F8B\u81F3\u5C11 3 \u6B21\uFF09\uFF0C\u62D2\u7EDD\u653E\u884C", 400);
  if (report.skillHash !== skillHash(report.skillId)) fail("REPORT_STALE", "\u62A5\u544A\u4E2D\u7684 Skill \u6307\u7EB9\u4E0E\u5F53\u524D\u5185\u6838\u4E0D\u7B26\uFF0C\u62D2\u7EDD\u653E\u884C", 400);
  const reportHash = createHash("sha256").update(reportText).digest("hex");
  return {
    skillId: report.skillId,
    skillHash: report.skillHash,
    modelHash: report.modelHash,
    reportHash,
    approvedBy: reviewer.trim(),
    reviewKind,
    approvedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + RELEASE_TTL_DAYS * 864e5).toISOString()
  };
}
function qualityInstructions(skillId) {
  const skill = skills[skillId];
  if (!skill) fail("SKILL_NOT_FOUND", `\u672A\u627E\u5230\u5DE5\u5177\u5BF9\u5E94\u7684 Skill\uFF1A${skillId}`, 404);
  return `\u4F60\u5FC5\u987B\u53EA\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF0C\u4E0D\u8F93\u51FA Markdown \u4EE3\u7801\u56F4\u680F\u3002\u683C\u5F0F\uFF1A{"sections":[{"title":"\u7AE0\u8282\u540D","content":"\u7EAF\u6587\u672C\u5185\u5BB9","evidence":["\u8F93\u5165\u4E2D\u7684\u9010\u5B57\u8BC1\u636E\u7247\u6BB5"]}],"missingInformation":["\u9700\u8981\u8865\u5145\u6216\u786E\u8BA4\u7684\u4FE1\u606F"]}\u3002
sections \u5FC5\u987B\u4F9D\u6B21\u5305\u542B\u4E14\u4EC5\u5305\u542B\u8FD9\u4E9B\u7AE0\u8282\uFF1A${skill.sections.join("\u3001")}\u3002evidence \u5FC5\u987B\u9010\u5B57\u6458\u81EA\u7528\u6237\u8F93\u5165\uFF1B\u5047\u8BBE\u6216\u5EFA\u8BAE\u53EF\u4EE5\u4E3A\u7A7A\u6570\u7EC4\uFF0C\u4E0D\u80FD\u865A\u6784\u5F15\u6587\uFF1B\u6574\u4EFD\u7ED3\u679C\u81F3\u5C11\u4E00\u5904\u8F93\u5165\u8BC1\u636E\u3002\u4FE1\u606F\u4E0D\u8DB3\u65F6\u660E\u786E\u5199\u5F85\u786E\u8BA4\uFF0C\u5E76\u586B\u5165 missingInformation\u3002\u7981\u6B62 HTML\u3002`;
}
function checkModelOutput(skillId, raw, source) {
  const parsed = checkModelOutputSchema(raw);
  const skill = skills[skillId];
  if (!skill) fail("SKILL_NOT_FOUND", `\u672A\u627E\u5230\u5DE5\u5177\u5BF9\u5E94\u7684 Skill\uFF1A${skillId}`, 404);
  if (parsed.sections.map((section) => section.title).join("\n") !== skill.sections.join("\n")) {
    fail("QUALITY_SECTIONS", "\u6A21\u578B\u8F93\u51FA\u7F3A\u5C11\u5FC5\u9700\u7AE0\u8282\u6216\u987A\u5E8F\u4E0D\u6B63\u786E\uFF0C\u672C\u6B21\u7ED3\u679C\u672A\u4EA4\u4ED8\u3002", 502);
  }
  const evidence = parsed.sections.flatMap((section) => section.evidence);
  if (evidence.length === 0 || evidence.some((quote) => !source.includes(quote))) {
    fail("QUALITY_EVIDENCE", "\u6A21\u578B\u5F15\u7528\u65E0\u6CD5\u5728\u8F93\u5165\u4E2D\u5B9A\u4F4D\uFF0C\u672C\u6B21\u7ED3\u679C\u672A\u4EA4\u4ED8\u3002", 502);
  }
  if (parsed.sections.some((section) => /<\/?[a-z][^>]*>/i.test(section.content))) {
    fail("QUALITY_CONTENT", "\u6A21\u578B\u8F93\u51FA\u5305\u542B\u4E0D\u5141\u8BB8\u7684 HTML\uFF0C\u672C\u6B21\u7ED3\u679C\u672A\u4EA4\u4ED8\u3002", 502);
  }
  return parsed;
}
export {
  MemoryReleaseStore,
  RELEASE_TTL_DAYS,
  buildRelease,
  checkModelOutput,
  modelIdentityHash,
  qualityInstructions,
  releaseReady,
  skillHash
};
