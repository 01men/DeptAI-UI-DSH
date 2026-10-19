function toMarkdown(result) {
  const body = result.blocks.map((block) => {
    switch (block.type) {
      case "metrics":
        return block.items.map((item) => `- ${item.label}\uFF1A${item.value} ${item.unit ?? ""}`).join("\n");
      case "text":
        return `## ${block.title}

${block.content}`;
      case "bars":
        return `## ${block.title}

${block.items.map((item) => `- ${item.label}: ${item.value} ${block.unit ?? ""}`).join("\n")}`;
      case "table":
        return `## ${block.title}

${[block.columns, block.columns.map(() => "---"), ...block.rows].map((row) => `| ${row.map((cell) => String(cell).replaceAll("|", "\\|").replaceAll("\n", " ")).join(" | ")} |`).join("\n")}`;
      case "scene":
        return `## ${block.title}

${block.label}\uFF1A${block.dimensions.join(" \xD7 ")} mm\uFF1B\u6570\u91CF ${block.count}\u3002`;
      default:
        return "";
    }
  }).join("\n\n");
  const warnings = result.warnings.map((warning) => `> ${warning}`).join("\n");
  return `# ${result.title}

${result.createdAt}

${body}

${warnings}

\u8FD0\u884C\u7F16\u53F7\uFF1A${result.runId}
`;
}
function exportFileName(result, extension) {
  const stamp = result.createdAt.replace(/[:.]/g, "-").slice(0, 19);
  return `${result.toolId}-${stamp}.${extension}`;
}
export {
  exportFileName,
  toMarkdown
};
