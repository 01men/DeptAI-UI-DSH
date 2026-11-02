const ASSET_CATEGORIES = ["\u8D22\u52A1", "\u884C\u653F", "\u4EBA\u4E8B", "\u9500\u552E", "\u8FD0\u8425", "\u6218\u7565", "\u751F\u4EA7", "\u7814\u53D1", "\u8D28\u91CF", "\u5236\u9020", "\u5176\u4ED6"];
const DEFAULT_ASSET_CATEGORY = "\u5176\u4ED6";
const LEGACY_CATEGORY_MAP = {
  // 旧 Skill 市场内置分类
  "\u529E\u516C\u63D0\u6548": "\u884C\u653F",
  "\u7814\u53D1\u6548\u80FD": "\u7814\u53D1",
  "\u5BA2\u6237\u670D\u52A1": "\u9500\u552E",
  "\u6570\u636E\u5206\u6790": "\u8FD0\u8425",
  "\u4EBA\u4E8B\u884C\u653F": "\u4EBA\u4E8B",
  "\u5E02\u573A\u60C5\u62A5": "\u9500\u552E",
  "\u6CD5\u52A1\u5408\u89C4": "\u884C\u653F",
  "\u901A\u7528": "\u5176\u4ED6",
  // 外部 Skill 目录导入分类
  "\u4EBA\u529B\u8D44\u6E90": "\u4EBA\u4E8B",
  "HR": "\u4EBA\u4E8B",
  "\u7EC4\u7EC7\u5EFA\u8BBE": "\u4EBA\u4E8B",
  "\u6CD5\u52A1": "\u884C\u653F",
  "\u5408\u89C4": "\u884C\u653F",
  "\u6548\u7387": "\u884C\u653F",
  "\u529E\u516C": "\u884C\u653F",
  "\u5E02\u573A": "\u9500\u552E",
  "\u8425\u9500": "\u9500\u552E",
  "\u5BA2\u6237\u652F\u6301": "\u9500\u552E",
  "\u5BA2\u670D": "\u9500\u552E",
  "\u6570\u636E": "\u8FD0\u8425",
  "\u7ECF\u8425\u5206\u6790": "\u8FD0\u8425",
  "\u4EA7\u54C1\u7BA1\u7406": "\u7814\u53D1",
  "\u4EA7\u54C1": "\u7814\u53D1",
  "\u8BBE\u8BA1": "\u7814\u53D1",
  "\u5DE5\u7A0B": "\u7814\u53D1",
  "\u6280\u672F": "\u7814\u53D1",
  "\u751F\u7269\u7814\u7A76": "\u7814\u53D1",
  "\u79D1\u7814": "\u7814\u53D1",
  "\u8D28\u68C0": "\u8D28\u91CF",
  "\u54C1\u63A7": "\u8D28\u91CF",
  "\u4F9B\u5E94\u94FE": "\u751F\u4EA7",
  "\u91C7\u8D2D": "\u751F\u4EA7",
  "\u4F01\u4E1A\u68C0\u7D22": "\u5176\u4ED6",
  "\u63D2\u4EF6\u7BA1\u7406": "\u5176\u4ED6",
  "PDF \u5DE5\u5177": "\u5176\u4ED6",
  "\u5C0F\u5FAE\u4F01\u4E1A": "\u5176\u4ED6",
  "\u4F1A\u8BA1": "\u8D22\u52A1",
  "\u7A0E\u52A1": "\u8D22\u52A1"
};
function isAssetCategory(value) {
  return typeof value === "string" && ASSET_CATEGORIES.includes(value);
}
function normalizeAssetCategory(value) {
  const text = String(value ?? "").trim();
  if (!text) return DEFAULT_ASSET_CATEGORY;
  if (isAssetCategory(text)) return text;
  if (LEGACY_CATEGORY_MAP[text]) return LEGACY_CATEGORY_MAP[text];
  if (text.startsWith("\u5408\u4F5C\u65B9")) return DEFAULT_ASSET_CATEGORY;
  return DEFAULT_ASSET_CATEGORY;
}
function alignAssetCategory(value, tags = []) {
  const original = String(value ?? "").trim();
  const category = normalizeAssetCategory(original);
  const nextTags = [...tags];
  if (original && !isAssetCategory(original) && !nextTags.includes(original)) nextTags.push(original);
  return { category, tags: nextTags };
}
function withLegacyCategories(found) {
  const extras = [];
  for (const item of found) {
    const text = String(item ?? "").trim();
    if (!text || isAssetCategory(text) || extras.includes(text)) continue;
    extras.push(text);
  }
  return [...ASSET_CATEGORIES, ...extras];
}
export {
  ASSET_CATEGORIES,
  DEFAULT_ASSET_CATEGORY,
  LEGACY_CATEGORY_MAP,
  alignAssetCategory,
  isAssetCategory,
  normalizeAssetCategory,
  withLegacyCategories
};
