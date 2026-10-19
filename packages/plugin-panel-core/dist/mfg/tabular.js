import { fail, requireCondition } from "./validate.js";
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let index = 0;
  const source = text.charCodeAt(0) === 65279 ? text.slice(1) : text;
  while (index < source.length) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (char === "\r") {
      index += 1;
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (quoted) fail("TABLE_INVALID", "\u8868\u683C\u5F15\u53F7\u672A\u95ED\u5408\uFF0C\u8BF7\u68C0\u67E5 CSV \u683C\u5F0F");
  row.push(field);
  rows.push(row);
  return rows.filter((cells) => !(cells.length === 1 && cells[0].trim() === ""));
}
function readTable(text, columns) {
  let parsed;
  try {
    parsed = parseCsv(text);
  } catch (error) {
    if (error instanceof Error && error.name === "MfgError") throw error;
    fail("TABLE_INVALID", "\u8868\u683C\u683C\u5F0F\u9519\u8BEF");
  }
  if (parsed.length < 2 || parsed.length > 1001) fail("TABLE_INVALID", "\u8BF7\u63D0\u4F9B\u8868\u5934\u548C 1\u20131000 \u6761\u6570\u636E");
  if (parsed[0].map((cell) => cell.trim()).join(",") !== columns.join(",")) {
    fail("TABLE_INVALID", `\u8868\u5934\u5FC5\u987B\u4E3A ${columns.join(",")}`);
  }
  return parsed.slice(1).map((cells, index) => {
    if (cells.length !== columns.length || cells.some((cell) => cell.trim() === "")) {
      fail("TABLE_INVALID", `\u7B2C ${index + 2} \u884C\u6709\u7A7A\u503C\u6216\u5217\u6570\u4E0D\u6B63\u786E`);
    }
    return Object.fromEntries(columns.map((key, position) => [key, cells[position].trim()]));
  });
}
const num = (value, label, min = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) fail("TABLE_INVALID", `${label}\u987B\u4E3A\u4E0D\u5C0F\u4E8E ${min} \u7684\u6709\u9650\u6570\u5B57`);
  return parsed;
};
const r = (value) => Number(value.toFixed(2));
const unique = (rows, key) => {
  if (new Set(rows.map((row) => row[key])).size !== rows.length) {
    fail("DUPLICATE_KEY", `${key} \u4E0D\u80FD\u91CD\u590D\uFF1B\u8BF7\u5148\u6309\u7F16\u7801/\u5355\u636E\u6C47\u603B\u6216\u62C6\u5206\u7F16\u7801`);
  }
};
function day(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail("INVALID_DATE", "\u65E5\u671F\u5FC5\u987B\u4F7F\u7528 YYYY-MM-DD \u683C\u5F0F");
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    fail("INVALID_DATE", `\u65E0\u6548\u65E5\u671F ${value}`);
  }
  return parsed;
}
function runTabular(id, input) {
  const warnings = [];
  let blocks = [];
  if (id === "bom-diff") {
    const a = readTable(String(input.before), ["code", "quantity"]);
    const b = readTable(String(input.after), ["code", "quantity"]);
    unique(a, "code");
    unique(b, "code");
    const before = new Map(a.map((row) => [row.code, num(row.quantity, "\u7528\u91CF")]));
    const after = new Map(b.map((row) => [row.code, num(row.quantity, "\u7528\u91CF")]));
    const changes = [.../* @__PURE__ */ new Set([...before.keys(), ...after.keys()])].map((code) => ({ code, old: before.get(code), next: after.get(code) })).filter((item) => item.old !== item.next);
    blocks = [
      { type: "metrics", items: [{ label: "\u5DEE\u5F02\u7269\u6599", value: changes.length, unit: "\u9879" }, { label: "\u65B0\u7248\u7269\u6599\u79CD\u6570", value: after.size, unit: "\u79CD" }] },
      {
        type: "table",
        title: "BOM \u5DEE\u5F02\u660E\u7EC6",
        columns: ["\u7269\u6599\u7F16\u7801", "\u65E7\u7248\u7528\u91CF", "\u65B0\u7248\u7528\u91CF", "\u53D8\u5316"],
        rows: changes.map((item) => [
          item.code,
          item.old ?? "\u4E0D\u5B58\u5728",
          item.next ?? "\u4E0D\u5B58\u5728",
          item.old === void 0 ? "\u65B0\u589E" : item.next === void 0 ? "\u5220\u9664" : `\u7528\u91CF ${r(item.next - item.old) >= 0 ? "+" : ""}${r(item.next - item.old)}`
        ])
      },
      { type: "text", title: "\u6BD4\u8F83\u8303\u56F4", content: "\u4EC5\u5BF9\u6BD4\u7269\u6599\u7F16\u7801\u53CA\u7528\u91CF\uFF0C\u4E0D\u89E3\u6790\u56FE\u7EB8\uFF0C\u4E0D\u9A8C\u8BC1\u7269\u6599\u89C4\u683C\u3001\u7248\u672C\u66FF\u4EE3\u5173\u7CFB\u6216\u5DE5\u7A0B\u9002\u7528\u6027\u3002\u7F16\u7801\u5FC5\u987B\u552F\u4E00\u3002" }
    ];
  } else if (id === "shortage") {
    const rows = readTable(String(input.data), ["code", "required", "available"]);
    unique(rows, "code");
    const values = rows.map((row) => ({ code: row.code, required: num(row.required, "\u9700\u6C42\u91CF"), available: num(row.available, "\u53EF\u7528\u91CF") }));
    const shortage = values.filter((item) => item.available < item.required);
    blocks = [
      { type: "metrics", items: [{ label: "\u7F3A\u6599\u79CD\u6570", value: shortage.length, unit: "\u79CD", tone: shortage.length ? "warn" : "good" }, { label: "\u7269\u6599\u9879\u6EE1\u8DB3\u7387", value: r((values.length - shortage.length) / values.length * 100), unit: "%" }] },
      { type: "table", title: "\u9010\u9879\u9F50\u5957\u68C0\u67E5", columns: ["\u7269\u6599\u7F16\u7801", "\u9700\u6C42\u91CF", "\u53EF\u7528\u91CF", "\u7F3A\u53E3"], rows: values.map((item) => [item.code, item.required, item.available, r(Math.max(0, item.required - item.available))]) },
      { type: "text", title: "\u8BA1\u7B97\u53E3\u5F84", content: "\u9010\u9879\u7F3A\u53E3 = max(\u9700\u6C42 \u2212 \u53EF\u7528\u91CF, 0)\u3002\u9879\u6EE1\u8DB3\u7387\u6309\u7269\u6599\u79CD\u6570\u8BA1\u7B97\uFF0C\u4E0D\u662F\u8BA2\u5355\u9F50\u5957\u7387\u3002\u8BF7\u5148\u4ECE\u53EF\u7528\u91CF\u6263\u9664\u5DF2\u9884\u7559\u3001\u51BB\u7ED3\u53CA\u4E0D\u5408\u683C\u5E93\u5B58\u3002" }
    ];
  } else if (id === "aging") {
    const date = day(String(input.asOf));
    const rows = readTable(String(input.data), ["id", "dueDate", "amount"]);
    unique(rows, "id");
    const buckets = ["\u672A\u903E\u671F", "\u903E\u671F1\u201330\u5929", "\u903E\u671F31\u201360\u5929", "\u903E\u671F61\u201390\u5929", "\u903E\u671F90\u5929\u4EE5\u4E0A"].map((label) => ({ label, value: 0 }));
    const detail = rows.map((row) => {
      const due = day(row.dueDate);
      const days = Math.max(0, Math.floor((date - due) / 864e5));
      const amount = num(row.amount, "\u672A\u7ED3\u4F59\u989D");
      const index = days === 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4;
      buckets[index].value += amount;
      return [row.id, row.dueDate, days, amount, buckets[index].label];
    });
    const total = buckets.reduce((sum, item) => sum + item.value, 0);
    blocks = [
      { type: "metrics", items: [{ label: "\u672A\u7ED3\u4F59\u989D\u5408\u8BA1", value: r(total), unit: "\u5143" }, { label: "\u903E\u671F\u4F59\u989D", value: r(total - buckets[0].value), unit: "\u5143" }] },
      { type: "bars", title: "\u903E\u671F\u5206\u5C42\u5206\u5E03", unit: "\u5143", items: buckets.map((item) => ({ ...item, value: r(item.value) })) },
      { type: "table", title: "\u672A\u7ED3\u5355\u636E\u660E\u7EC6", columns: ["\u5355\u636E", "\u5230\u671F\u65E5", "\u903E\u671F\u5929\u6570", "\u672A\u7ED3\u4F59\u989D", "\u5206\u5C42"], rows: detail }
    ];
    warnings.push("\u8FD9\u662F\u6309\u5230\u671F\u65E5\u8BA1\u7B97\u7684\u903E\u671F\u5206\u5C42\uFF0C\u4E0D\u662F\u6309\u5165\u8D26\u65E5\u8BA1\u7B97\u7684\u4F1A\u8BA1\u8D26\u9F84\u3002\u4EC5\u652F\u6301\u540C\u5E01\u79CD\u3001\u975E\u8D1F\u672A\u7ED3\u4F59\u989D\uFF1B\u5E94\u6536\u548C\u5E94\u4ED8\u8BF7\u5206\u5F00\u5BFC\u5165\u3002");
  } else if (id === "maintenance") {
    const failures = Number(input.failures);
    if (!Number.isSafeInteger(failures)) fail("INVALID_INPUT", "\u6545\u969C\u6B21\u6570\u5FC5\u987B\u4E3A\u6574\u6570");
    requireCondition(failures > 0, "\u6545\u969C\u6B21\u6570\u5FC5\u987B\u5927\u4E8E 0");
    blocks = [
      { type: "metrics", items: [{ label: "MTBF \u5E73\u5747\u6545\u969C\u95F4\u9694", value: r(Number(input.uptime) / failures), unit: "h" }, { label: "MTTR \u5E73\u5747\u4FEE\u590D\u65F6\u95F4", value: r(Number(input.repair) / failures), unit: "h" }] },
      { type: "text", title: "\u8BA1\u7B97\u53E3\u5F84", content: "MTBF = \u540C\u4E00\u89C2\u5BDF\u671F\u7D2F\u8BA1\u8FD0\u884C\u65F6\u95F4 / \u6545\u969C\u6B21\u6570\uFF1BMTTR = \u540C\u671F\u7D2F\u8BA1\u4E3B\u52A8\u7EF4\u4FEE\u65F6\u95F4 / \u6545\u969C\u6B21\u6570\u3002\u8F93\u5165\u5E94\u4FDD\u6301\u8BBE\u5907\u8303\u56F4\u4E0E\u89C2\u5BDF\u671F\u4E00\u81F4\uFF0C\u4E0D\u5C06\u7B49\u5F85\u5907\u4EF6\u65F6\u95F4\u6DF7\u5165\u4E3B\u52A8\u7EF4\u4FEE\u65F6\u95F4\u3002" }
    ];
  } else if (id === "quote-compare") {
    const quantity = Number(input.quantity);
    if (!Number.isSafeInteger(quantity)) fail("INVALID_INPUT", "\u91C7\u8D2D\u6570\u91CF\u5FC5\u987B\u4E3A\u6574\u6570");
    const values = readTable(String(input.data), ["supplier", "price", "taxRate", "freight"]);
    unique(values, "supplier");
    const ranked = values.map((row) => {
      const price = num(row.price, "\u672A\u7A0E\u5355\u4EF7");
      const tax = num(row.taxRate, "\u7A0E\u7387");
      const freight = num(row.freight, "\u542B\u7A0E\u8FD0\u8D39");
      if (tax > 1) fail("INVALID_INPUT", "\u7A0E\u7387\u7528\u5C0F\u6570\u8868\u793A\uFF0C\u4F8B\u5982 13% \u586B 0.13");
      return { supplier: row.supplier, total: r(quantity * price * (1 + tax) + freight), price, tax, freight };
    }).sort((a, b) => a.total - b.total);
    blocks = [
      { type: "metrics", items: [{ label: "\u6700\u4F4E\u542B\u7A0E\u5230\u8D27\u603B\u6210\u672C", value: ranked[0].total, unit: "\u5143" }, { label: "\u6700\u9AD8\u4E0E\u6700\u4F4E\u5DEE\u989D", value: r(ranked.at(-1).total - ranked[0].total), unit: "\u5143" }] },
      { type: "bars", title: "\u542B\u7A0E\u5230\u8D27\u603B\u6210\u672C\u5BF9\u6BD4", unit: "\u5143", items: ranked.map((item) => ({ label: item.supplier, value: item.total })) },
      { type: "table", title: "\u540C\u53E3\u5F84\u62A5\u4EF7\u660E\u7EC6", columns: ["\u4F9B\u5E94\u5546", "\u672A\u7A0E\u5355\u4EF7", "\u7A0E\u7387", "\u542B\u7A0E\u8FD0\u8D39", "\u603B\u6210\u672C"], rows: ranked.map((item) => [item.supplier, item.price, item.tax, item.freight, item.total]) }
    ];
    warnings.push("\u603B\u6210\u672C = \u6570\u91CF \xD7 \u672A\u7A0E\u5355\u4EF7 \xD7 (1 + \u7A0E\u7387) + \u542B\u7A0E\u8FD0\u8D39\u3002\u4EC5\u6BD4\u8F83\u540C\u5E01\u79CD\u540C\u89C4\u683C\u7684\u73B0\u91D1\u652F\u51FA\uFF0C\u4E0D\u8003\u8651\u53EF\u62B5\u6263\u7A0E\u989D\u3001\u4EA4\u671F\u3001\u8D28\u91CF\u3001\u8D26\u671F\u548C\u6C47\u7387\u3002");
  }
  return { blocks, warnings };
}
export {
  parseCsv,
  readTable,
  runTabular
};
