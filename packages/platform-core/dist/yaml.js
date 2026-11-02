function parseYaml(text) {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\t/g, "  ")).filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  let pos = 0;
  const indentOf = (line) => line.length - line.trimStart().length;
  function parseBlock(indent) {
    const first = lines[pos];
    if (first === void 0) return null;
    if (first.trimStart().startsWith("- ")) return parseSeq(indent);
    return parseMap(indent);
  }
  function parseMap(indent) {
    const result = {};
    while (pos < lines.length) {
      const line = lines[pos];
      const ind = indentOf(line);
      if (ind < indent) break;
      if (ind > indent) throw new Error(`YAML \u7F29\u8FDB\u5F02\u5E38\uFF1A\u300C${line.trim()}\u300D`);
      const content = line.trim();
      if (content.startsWith("- ")) break;
      const match = content.match(/^("[^"]+"|'[^']+'|[^:]+):\s*(.*)$/);
      if (!match) throw new Error(`YAML \u6620\u5C04\u884C\u89E3\u6790\u5931\u8D25\uFF1A\u300C${content}\u300D`);
      const key = String(parseScalar(match[1].trim()));
      const rest = (match[2] ?? "").trim();
      pos++;
      if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-" || rest === "|+" || rest === ">+") {
        const blockIndent = pos < lines.length ? indentOf(lines[pos]) : -1;
        const collected = [];
        if (blockIndent > ind) {
          while (pos < lines.length && indentOf(lines[pos]) >= blockIndent) {
            collected.push(lines[pos].trimStart());
            pos++;
          }
        }
        const joiner = rest.startsWith(">") ? " " : "\n";
        let text2 = collected.join(joiner);
        if (!rest.endsWith("-") && text2 !== "") text2 += "\n";
        result[key] = text2;
      } else if (rest !== "" && !rest.startsWith("#")) {
        result[key] = parseScalar(rest);
      } else if (pos < lines.length && indentOf(lines[pos]) > ind) {
        if (lines[pos].trim() === "[]" || lines[pos].trim() === "{}") {
          result[key] = lines[pos].trim() === "[]" ? [] : {};
          pos++;
        } else {
          result[key] = parseBlock(indentOf(lines[pos]));
        }
      } else if (pos < lines.length && indentOf(lines[pos]) === ind && (lines[pos].trimStart().startsWith("- ") || lines[pos].trim() === "-")) {
        result[key] = parseSeq(ind);
      } else {
        result[key] = null;
      }
    }
    return result;
  }
  function parseSeq(indent) {
    const result = [];
    while (pos < lines.length) {
      const line = lines[pos];
      const ind = indentOf(line);
      if (ind < indent) break;
      if (ind > indent) throw new Error(`YAML \u7F29\u8FDB\u5F02\u5E38\uFF1A\u300C${line.trim()}\u300D`);
      const content = line.trim();
      if (content !== "-" && !content.startsWith("- ")) break;
      const rest = content === "-" ? "" : content.slice(2).trim();
      pos++;
      if (rest === "") {
        result.push(pos < lines.length && indentOf(lines[pos]) > ind ? parseBlock(indentOf(lines[pos])) : null);
      } else if (/^[^:]+:(\s|$)/.test(rest) && !rest.startsWith('"') && !rest.startsWith("'")) {
        const virtualIndent = ind + 2;
        lines.splice(pos, 0, " ".repeat(virtualIndent) + rest);
        result.push(parseMap(virtualIndent));
      } else {
        result.push(parseScalar(rest));
      }
    }
    return result;
  }
  function parseScalar(raw) {
    const value = raw.split(" #")[0].trim();
    if (value === "[]") return [];
    if (value === "{}") return {};
    if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
    if (value === "true" || value === "false") return value === "true";
    if (value === "null" || value === "~") return null;
    if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
    if (/^-?\d+\.\d+$/.test(value)) return Number.parseFloat(value);
    return value;
  }
  if (lines.length === 0) return null;
  return parseBlock(indentOf(lines[0]));
}
export {
  parseYaml
};
