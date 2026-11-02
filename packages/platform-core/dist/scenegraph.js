import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Service } from "@deepseek-ai/cordis";
import { t } from "../../platform-i18n/dist/index.js";
const SCENE_TAGS = ["\u63D0\u8D28", "\u964D\u672C", "\u589E\u6548", "\u8282\u80FD", "\u65B0\u6A21\u5F0F", "\u589E\u6536", "\u5B89\u5168", "\u73AF\u4FDD"];
const SCENE_ACTIVITIES = ["rd", "mfg", "scm", "svc", "mkt", "mgmt", "fin"];
const ACTIVITY_LABELS = {
  rd: "\u7814\u53D1\u8BBE\u8BA1",
  mfg: "\u751F\u4EA7\u5236\u9020",
  scm: "\u4F9B\u5E94\u94FE\u7BA1\u7406",
  svc: "\u8FD0\u7EF4\u670D\u52A1",
  mkt: "\u6570\u5B57\u8425\u9500",
  mgmt: "\u7ECF\u8425\u7BA1\u7406",
  fin: "\u6CD5\u8D22\u7A0E\u4E0E\u6210\u672C"
};
function validateScenegraph(input, source = "scenegraph") {
  const errors = [];
  const pack = input;
  if (pack === null || typeof pack !== "object") return [t("{source}: \u4E0D\u662F JSON \u5BF9\u8C61", { source })];
  if (!pack.code || typeof pack.code !== "string" || !/^[A-Z][A-Z0-9]{2,9}$/.test(pack.code)) {
    errors.push(t("{source}: code \u5FC5\u586B\uFF08\u884C\u4E1A\u56FE\u8C31\u7F16\u7801\uFF0C\u5927\u5199\u5B57\u6BCD\u5F00\u5934 3-10 \u4F4D\uFF0C\u6536\u5230 {value}\uFF09", { source, value: String(pack.code) }));
  }
  if (!pack.name || typeof pack.name !== "string") errors.push(t("{source}: name \u5FC5\u586B", { source }));
  if (!pack.icon || typeof pack.icon !== "string") errors.push(t("{source}: icon \u5FC5\u586B", { source }));
  if (!pack.version || typeof pack.version !== "string") errors.push(t("{source}: version \u5FC5\u586B", { source }));
  if (!pack.chains || typeof pack.chains !== "string") errors.push(t("{source}: chains\uFF08\u884C\u4E1A\u94FE\u6761\u4E3B\u7EBF\uFF09\u5FC5\u586B", { source }));
  if (!pack.activities || typeof pack.activities !== "object" || Array.isArray(pack.activities)) {
    errors.push(t("{source}: activities \u5FC5\u586B\uFF08\u4E1A\u52A1\u6D3B\u52A8 \u2192 \u573A\u666F\u6E05\u5355\uFF09", { source }));
    return errors;
  }
  const seen = /* @__PURE__ */ new Set();
  let total = 0;
  for (const [activity, scenes] of Object.entries(pack.activities)) {
    if (!SCENE_ACTIVITIES.includes(activity)) {
      errors.push(t("{source}: activities.{activity} \u975E\u6CD5\uFF08\u5E94\u4E3A {expected}\uFF09", { source, activity, expected: SCENE_ACTIVITIES.join("/") }));
      continue;
    }
    if (!Array.isArray(scenes) || scenes.length === 0) {
      errors.push(t("{source}: activities.{activity} \u5FC5\u987B\u662F\u975E\u7A7A\u573A\u666F\u6570\u7EC4", { source, activity }));
      continue;
    }
    scenes.forEach((scene, index) => {
      total++;
      const at = `${source}: activities.${activity}[${index}]`;
      if (!scene?.code || typeof scene.code !== "string") errors.push(t("{at}.code \u5FC5\u586B", { at }));
      else if (seen.has(scene.code)) errors.push(t("{at}.code \u5168\u56FE\u91CD\u590D\uFF1A{code}", { at, code: scene.code }));
      else seen.add(scene.code);
      if (!scene?.name || typeof scene.name !== "string") errors.push(t("{at}.name \u5FC5\u586B", { at }));
      if (scene?.type !== "\u4E3B\u573A\u666F" && scene?.type !== "\u7EC6\u5206\u573A\u666F") errors.push(t("{at}.type \u975E\u6CD5\uFF08\u4E3B\u573A\u666F/\u7EC6\u5206\u573A\u666F\uFF09", { at }));
      if (!Number.isInteger(scene?.s) || scene.s < 1 || scene.s > 5) errors.push(t("{at}.s \u73B0\u72B6\u8BC4\u7EA7\u987B\u4E3A 1-5 \u6574\u6570", { at }));
      if (!Array.isArray(scene?.tags) || scene.tags.some((tag) => !SCENE_TAGS.includes(tag))) {
        errors.push(t("{at}.tags \u975E\u6CD5\uFF08\u5E94\u4E3A {expected} \u7684\u5B50\u96C6\uFF0C\u53EF\u4E3A\u7A7A\u6570\u7EC4\uFF09", { at, expected: SCENE_TAGS.join("/") }));
      }
      if (!scene?.pain || typeof scene.pain !== "string") errors.push(t("{at}.pain \u5FC5\u586B", { at }));
      for (const list of ["tools", "models", "data", "talent"]) {
        if (!Array.isArray(scene?.[list]) || scene[list].length === 0) {
          errors.push(t("{at}.{field} \u5FC5\u586B\u4E14\u975E\u7A7A\uFF08\u56DB\u6E05\u5355\u7F3A\u4E00\u4E0D\u53EF\uFF09", { at, field: list }));
        }
      }
    });
  }
  if (total === 0) errors.push(t("{source}: \u56FE\u8C31\u81F3\u5C11\u8981\u6709\u4E00\u4E2A\u573A\u666F", { source }));
  return errors;
}
function defaultScenegraphDir() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "scenegraphs");
}
class ScenegraphService extends Service {
  static provide = "scenegraphs";
  packs = [];
  loadErrors = [];
  constructor(ctx, config = {}) {
    super(ctx, "scenegraphs");
    void this.loadFromDir(config.dir ?? process.env.SCENEGRAPH_DIR ?? defaultScenegraphDir());
  }
  /** 装载目录内全部 *.json：单文件非法跳过并记录（不阻断启动），lint:manifests 负责红线。 */
  async loadFromDir(dir) {
    const errors = [];
    const packs = [];
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      this.loadErrors = [t("{dir} \u4E0D\u53EF\u8BFB\uFF08\u65E0\u573A\u666F\u56FE\u8C31\u5305\uFF09", { dir })];
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(dir, entry.name), "utf8"));
        const packErrors = validateScenegraph(parsed, entry.name);
        if (packErrors.length > 0) {
          errors.push(...packErrors);
          continue;
        }
        packs.push(parsed);
      } catch (error) {
        errors.push(t("{name}: JSON \u89E3\u6790\u5931\u8D25\uFF08{message}\uFF09", { name: entry.name, message: error instanceof Error ? error.message : String(error) }));
      }
    }
    this.packs = packs;
    this.loadErrors = errors;
    if (errors.length > 0) this.ctx.logger("scenegraphs").warn(`\u573A\u666F\u56FE\u8C31\u88C5\u8F7D\u5B58\u5728\u88AB\u8DF3\u8FC7\u7684\u6587\u4EF6\uFF1A${errors.join("\uFF1B")}`);
  }
  /** 热刷新：重载目录后发 scenegraph.updated（面板据此刷新场景页；review Phase 2 第 11 条）。 */
  async reloadFromDir(dir) {
    await this.loadFromDir(dir ?? process.env.SCENEGRAPH_DIR ?? defaultScenegraphDir());
    this.ctx.platformBus.emit(PlatformEvents_ScenegraphUpdated, { packs: this.packs.length, problems: this.loadErrors.length });
    return { packs: this.packs.length, problems: this.loadErrors };
  }
  all() {
    return this.packs;
  }
  get(code) {
    return this.packs.find((pack) => pack.code === code);
  }
  /** 场景编号反查（会话引用沉淀回图谱：如 QB01-A-2-5）。 */
  findScene(code) {
    for (const pack of this.packs) {
      for (const [activity, scenes] of Object.entries(pack.activities)) {
        const hit = (scenes ?? []).find((scene) => scene.code === code);
        if (hit) return { pack, activity, scene: hit };
      }
    }
    return void 0;
  }
  /** 装载期被跳过文件的问题清单，观测用。 */
  loadProblems() {
    return this.loadErrors;
  }
}
const PlatformEvents_ScenegraphUpdated = "scenegraph.updated";
export {
  ACTIVITY_LABELS,
  SCENE_ACTIVITIES,
  SCENE_TAGS,
  ScenegraphService,
  defaultScenegraphDir,
  validateScenegraph
};
