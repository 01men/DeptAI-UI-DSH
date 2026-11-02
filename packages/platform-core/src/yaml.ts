/**
 * 最小 YAML 子集解析器（无外部依赖）。
 * 支持第三方插件契约五面（plugin.yaml / manifest/*.yaml）所需的语法：
 *   缩进映射 / 序列（- 项，含行内映射项与「- 独占一行」块项）/ 标量（字符串、数字、
 *   布尔、null、空流式集合 [] {}）/ # 整行注释。
 * 不支持锚点、多文档、非空流式集合——契约面刻意保持最小。
 */

export function parseYaml(text: string): unknown {
  const lines = text.split(/\r?\n/)
    .map((line) => line.replace(/\t/g, '  '))
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
  let pos = 0

  const indentOf = (line: string): number => line.length - line.trimStart().length

  function parseBlock(indent: number): unknown {
    const first = lines[pos]
    if (first === undefined) return null
    if (first.trimStart().startsWith('- ')) return parseSeq(indent)
    return parseMap(indent)
  }

  function parseMap(indent: number): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    while (pos < lines.length) {
      const line = lines[pos]!
      const ind = indentOf(line)
      if (ind < indent) break
      if (ind > indent) throw new Error(`YAML 缩进异常：「${line.trim()}」`)
      const content = line.trim()
      if (content.startsWith('- ')) break
      const match = content.match(/^("[^"]+"|'[^']+'|[^:]+):\s*(.*)$/)
      if (!match) throw new Error(`YAML 映射行解析失败：「${content}」`)
      const key = String(parseScalar(match[1]!.trim()))
      const rest = (match[2] ?? '').trim()
      pos++
      if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-' || rest === '|+' || rest === '>+') {
        // 块标量：后续更深缩进行为内容（| 字面 / > 折叠；- 去尾换行）
        const blockIndent = pos < lines.length ? indentOf(lines[pos]!) : -1
        const collected: string[] = []
        if (blockIndent > ind) {
          while (pos < lines.length && indentOf(lines[pos]!) >= blockIndent) {
            collected.push(lines[pos]!.trimStart())
            pos++
          }
        }
        const joiner = rest.startsWith('>') ? ' ' : '\n'
        let text = collected.join(joiner)
        if (!rest.endsWith('-') && text !== '') text += '\n'
        result[key] = text
      } else if (rest !== '' && !rest.startsWith('#')) {
        result[key] = parseScalar(rest)
      } else if (pos < lines.length && indentOf(lines[pos]!) > ind) {
        // key 下嵌套行是空流式集合（如 permissions:\n  []）——消费为空集合
        if (lines[pos]!.trim() === '[]' || lines[pos]!.trim() === '{}') {
          result[key] = lines[pos]!.trim() === '[]' ? [] : {}
          pos++
        } else {
          result[key] = parseBlock(indentOf(lines[pos]!))
        }
      } else if (pos < lines.length && indentOf(lines[pos]!) === ind && (lines[pos]!.trimStart().startsWith('- ') || lines[pos]!.trim() === '-')) {
        result[key] = parseSeq(ind)
      } else {
        result[key] = null
      }
    }
    return result
  }

  function parseSeq(indent: number): unknown[] {
    const result: unknown[] = []
    while (pos < lines.length) {
      const line = lines[pos]!
      const ind = indentOf(line)
      if (ind < indent) break
      if (ind > indent) throw new Error(`YAML 缩进异常：「${line.trim()}」`)
      const content = line.trim()
      if (content !== '-' && !content.startsWith('- ')) break
      const rest = content === '-' ? '' : content.slice(2).trim()
      pos++
      if (rest === '') {
        result.push(pos < lines.length && indentOf(lines[pos]!) > ind ? parseBlock(indentOf(lines[pos]!)) : null)
      } else if (/^[^:]+:(\s|$)/.test(rest) && !rest.startsWith('"') && !rest.startsWith("'")) {
        // 行内映射项判定（E-05）：冒号后必须跟空白或行尾才算映射键（YAML 惯例）——
        // 「12:34:56」这类无空格冒号串（时间/比例）保持标量，不再误判为映射后报「[object Object]」。
        // 以更深缩进注入虚拟行后按映射解析
        const virtualIndent = ind + 2
        lines.splice(pos, 0, ' '.repeat(virtualIndent) + rest)
        result.push(parseMap(virtualIndent))
      } else {
        result.push(parseScalar(rest))
      }
    }
    return result
  }

  function parseScalar(raw: string): unknown {
    const value = raw.split(' #')[0]!.trim()
    if (value === '[]') return []
    if (value === '{}') return {}
    if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1)
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
    if (value === 'true' || value === 'false') return value === 'true'
    if (value === 'null' || value === '~') return null
    if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10)
    if (/^-?\d+\.\d+$/.test(value)) return Number.parseFloat(value)
    return value
  }

  if (lines.length === 0) return null
  return parseBlock(indentOf(lines[0]!))
}
