import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
let cached;
function loadRoadmap() {
  if (cached) return cached;
  const path = fileURLToPath(new URL("./roadmap.json", import.meta.url));
  cached = JSON.parse(readFileSync(path, "utf8"));
  return cached;
}
function roadmapGroups(roadmap) {
  return [...new Set(roadmap.tools.map((item) => item.group))];
}
const ROADMAP_STATUS_LABELS = {
  "implemented-calculation": "\u8BA1\u7B97\u5185\u6838\u5DF2\u5B9E\u73B0",
  "model-validation-pending": "\u5F85\u6A21\u578B\u9A8C\u6536",
  planned: "\u89C4\u5212\u4E2D"
};
export {
  ROADMAP_STATUS_LABELS,
  loadRoadmap,
  roadmapGroups
};
