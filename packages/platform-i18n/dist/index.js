import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
const SUPPORTED_LOCALES = ["zh-CN", "en-US", "ja-JP"];
const DEFAULT_LOCALE = "zh-CN";
const LOCALE_DISPLAY_NAMES = {
  "zh-CN": { native: "\u7B80\u4F53\u4E2D\u6587", en: "Simplified Chinese", intl: "zh-CN" },
  "en-US": { native: "English (US)", en: "English (US)", intl: "en-US" },
  "ja-JP": { native: "\u65E5\u672C\u8A9E", en: "Japanese", intl: "ja-JP" }
};
const LANG_PREFIX_MAP = [
  { prefix: "zh", locale: "zh-CN" },
  { prefix: "en", locale: "en-US" },
  { prefix: "ja", locale: "ja-JP" }
];
function normalizeLocale(input) {
  if (!input) return null;
  const lower = String(input).trim().toLowerCase();
  if (lower === "") return null;
  for (const { prefix, locale } of LANG_PREFIX_MAP) {
    if (lower === prefix || lower.startsWith(`${prefix}-`)) return locale;
  }
  return null;
}
function parseCookieHeader(header) {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return {};
  const out = {};
  for (const pair of String(raw).split(";")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    if (key !== "") out[key] = decodeURIComponent(pair.slice(eq + 1).trim());
  }
  return out;
}
function parseAcceptLanguage(header) {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw) return [];
  return String(raw).split(",").map((part) => {
    const [tag, ...params] = part.trim().split(";");
    let q = 1;
    for (const param of params) {
      const match = /q\s*=\s*([\d.]+)/.exec(param);
      if (match) q = Number(match[1]);
    }
    return { tag: (tag ?? "").trim(), q: Number.isFinite(q) ? q : 0 };
  }).filter((item) => item.tag !== "" && item.tag !== "*").sort((a, b) => b.q - a.q).map((item) => item.tag);
}
function resolveRequestLocale(input) {
  return normalizeLocale(input.query) ?? normalizeLocale(input.cookie) ?? parseAcceptLanguage(input.acceptLanguage).map((tag) => normalizeLocale(tag)).find((locale) => locale !== null) ?? normalizeLocale(input.env) ?? DEFAULT_LOCALE;
}
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalogCache = /* @__PURE__ */ new Map();
function readCatalogDir(dir) {
  if (!existsSync(dir)) return {};
  const merged = {};
  const files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  for (const name of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") merged[key] = value;
      }
    } catch {
    }
  }
  return merged;
}
function localeCatalog(locale) {
  const cached = catalogCache.get(locale);
  if (cached) return cached;
  const merged = readCatalogDir(join(PACKAGE_ROOT, "locales", locale));
  const extraRoot = process.env.I18N_EXTRA_DIR ?? "";
  if (extraRoot !== "") Object.assign(merged, readCatalogDir(join(extraRoot, locale)));
  catalogCache.set(locale, merged);
  return merged;
}
const requestLocaleStorage = new AsyncLocalStorage();
function installLocale() {
  return normalizeLocale(process.env.PLATFORM_LOCALE) ?? DEFAULT_LOCALE;
}
function currentLocale() {
  return requestLocaleStorage.getStore() ?? installLocale();
}
function runWithLocale(locale, fn) {
  return requestLocaleStorage.run(locale, fn);
}
const INTERP = /\{(\w+)\}/g;
function interpolate(template, params) {
  if (!params) return template;
  return template.replace(INTERP, (whole, name) => Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole);
}
function t(zhText, params) {
  const locale = currentLocale();
  if (locale === DEFAULT_LOCALE) return interpolate(zhText, params);
  const translated = localeCatalog(locale)[zhText];
  return interpolate(translated ?? zhText, params);
}
function tIn(locale, zhText, params) {
  if (locale === DEFAULT_LOCALE) return interpolate(zhText, params);
  const translated = localeCatalog(locale)[zhText];
  return interpolate(translated ?? zhText, params);
}
function formatDateValue(value, locale, opts) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const tag = LOCALE_DISPLAY_NAMES[locale ?? currentLocale()].intl;
  return new Intl.DateTimeFormat(tag, opts ?? { dateStyle: "medium", timeStyle: "medium" }).format(date);
}
function formatNumberValue(value, locale, opts) {
  const tag = LOCALE_DISPLAY_NAMES[locale ?? currentLocale()].intl;
  return new Intl.NumberFormat(tag, opts).format(value);
}
export {
  DEFAULT_LOCALE,
  LOCALE_DISPLAY_NAMES,
  SUPPORTED_LOCALES,
  currentLocale,
  formatDateValue,
  formatNumberValue,
  installLocale,
  localeCatalog,
  normalizeLocale,
  parseAcceptLanguage,
  parseCookieHeader,
  readCatalogDir,
  resolveRequestLocale,
  runWithLocale,
  t,
  tIn
};
