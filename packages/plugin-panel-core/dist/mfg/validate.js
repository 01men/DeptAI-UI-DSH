class MfgError extends Error {
  code;
  status;
  constructor(code, message, status = 400) {
    super(message);
    this.name = "MfgError";
    this.code = code;
    this.status = status;
  }
}
const fail = (code, message, status = 400) => {
  throw new MfgError(code, message, status);
};
const requireCondition = (ok, message, code = "INVALID_INPUT") => {
  if (!ok) fail(code, message);
};
const TEXT_MAX = 16e3;
function checkNumber(value, label, min, max) {
  const num = typeof value === "number" ? value : Number(value);
  if (typeof value === "boolean" || value === null || value === void 0 || value === "" || !Number.isFinite(num)) {
    fail("INVALID_INPUT", `${label}\u5FC5\u987B\u662F\u6709\u9650\u6570\u5B57`);
  }
  if (min !== void 0 && num < min) fail("INVALID_INPUT", `${label}\u4E0D\u80FD\u5C0F\u4E8E ${min}`);
  if (max !== void 0 && num > max) fail("INVALID_INPUT", `${label}\u4E0D\u80FD\u5927\u4E8E ${max}`);
  return num;
}
function checkText(value, label, max = TEXT_MAX) {
  if (typeof value !== "string") fail("INVALID_INPUT", `${label}\u4E0D\u80FD\u4E3A\u7A7A`);
  const text = value.trim();
  if (text === "") fail("INVALID_INPUT", `${label}\u4E0D\u80FD\u4E3A\u7A7A`);
  if (text.length > max) fail("INVALID_INPUT", `${label}\u957F\u5EA6\u8D85\u8FC7 ${max} \u5B57\u7B26`);
  return text;
}
function checkInteger(value, label) {
  const num = checkNumber(value, label);
  if (!Number.isSafeInteger(num)) fail("INVALID_INPUT", `${label}\u987B\u4E3A\u5B89\u5168\u8303\u56F4\u5185\u7684\u6574\u6570`);
  return num;
}
function checkStrictObject(raw, keys, validate) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("INVALID_INPUT", "\u8F93\u5165\u5FC5\u987B\u662F\u5BF9\u8C61");
  const source = raw;
  const allowed = new Set(keys);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key) && key !== "_protocol") fail("INVALID_INPUT", `\u8F93\u5165\u5305\u542B\u672A\u77E5\u5B57\u6BB5\uFF1A${key}`);
  }
  const out = {};
  for (const key of keys) out[key] = validate(key, source[key]);
  return out;
}
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
function checkModelOutputSchema(raw) {
  if (!isPlainObject(raw)) fail("QUALITY_SCHEMA", "\u6A21\u578B\u8F93\u51FA\u672A\u901A\u8FC7\u7ED3\u6784\u6821\u9A8C\uFF0C\u672C\u6B21\u7ED3\u679C\u672A\u4EA4\u4ED8\u3002", 502);
  const sectionsRaw = raw.sections;
  const missingRaw = raw.missingInformation;
  if (!Array.isArray(sectionsRaw) || sectionsRaw.length < 1 || sectionsRaw.length > 12) {
    fail("QUALITY_SCHEMA", "\u6A21\u578B\u8F93\u51FA\u672A\u901A\u8FC7\u7ED3\u6784\u6821\u9A8C\uFF0C\u672C\u6B21\u7ED3\u679C\u672A\u4EA4\u4ED8\u3002", 502);
  }
  if (!Array.isArray(missingRaw) || missingRaw.length > 30) {
    fail("QUALITY_SCHEMA", "\u6A21\u578B\u8F93\u51FA\u672A\u901A\u8FC7\u7ED3\u6784\u6821\u9A8C\uFF0C\u672C\u6B21\u7ED3\u679C\u672A\u4EA4\u4ED8\u3002", 502);
  }
  const sections = sectionsRaw.map((item) => {
    if (!isPlainObject(item)) fail("QUALITY_SCHEMA", "\u6A21\u578B\u8F93\u51FA\u672A\u901A\u8FC7\u7ED3\u6784\u6821\u9A8C\uFF0C\u672C\u6B21\u7ED3\u679C\u672A\u4EA4\u4ED8\u3002", 502);
    const title = item.title;
    const content = item.content;
    const evidence = item.evidence;
    if (typeof title !== "string" || title.length < 1 || title.length > 100) fail("QUALITY_SCHEMA", "\u6A21\u578B\u8F93\u51FA\u672A\u901A\u8FC7\u7ED3\u6784\u6821\u9A8C\uFF0C\u672C\u6B21\u7ED3\u679C\u672A\u4EA4\u4ED8\u3002", 502);
    if (typeof content !== "string" || content.length < 1 || content.length > 12e3) fail("QUALITY_SCHEMA", "\u6A21\u578B\u8F93\u51FA\u672A\u901A\u8FC7\u7ED3\u6784\u6821\u9A8C\uFF0C\u672C\u6B21\u7ED3\u679C\u672A\u4EA4\u4ED8\u3002", 502);
    if (!Array.isArray(evidence) || evidence.length > 20) fail("QUALITY_SCHEMA", "\u6A21\u578B\u8F93\u51FA\u672A\u901A\u8FC7\u7ED3\u6784\u6821\u9A8C\uFF0C\u672C\u6B21\u7ED3\u679C\u672A\u4EA4\u4ED8\u3002", 502);
    const quotes = evidence.map((quote) => {
      if (typeof quote !== "string" || quote.length < 1 || quote.length > 1e3) fail("QUALITY_SCHEMA", "\u6A21\u578B\u8F93\u51FA\u672A\u901A\u8FC7\u7ED3\u6784\u6821\u9A8C\uFF0C\u672C\u6B21\u7ED3\u679C\u672A\u4EA4\u4ED8\u3002", 502);
      return quote;
    });
    return { title, content, evidence: quotes };
  });
  const missingInformation = missingRaw.map((item) => {
    if (typeof item !== "string" || item.length < 1 || item.length > 1e3) fail("QUALITY_SCHEMA", "\u6A21\u578B\u8F93\u51FA\u672A\u901A\u8FC7\u7ED3\u6784\u6821\u9A8C\uFF0C\u672C\u6B21\u7ED3\u679C\u672A\u4EA4\u4ED8\u3002", 502);
    return item;
  });
  return { sections, missingInformation };
}
export {
  MfgError,
  TEXT_MAX,
  checkInteger,
  checkModelOutputSchema,
  checkNumber,
  checkStrictObject,
  checkText,
  fail,
  requireCondition
};
