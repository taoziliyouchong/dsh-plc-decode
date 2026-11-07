/**
 * 文字梯形图渲染器（纯函数，零依赖）
 *
 * 样式是**固定**的（2026-09-18 用户认可的那一版）：
 *   - 触点与导线在左边、指令盒画成方框、引脚列在方框两侧、值写在导线上
 *   - 梯体全为等宽字符；中文只出现在标题行与说明行（不参与对齐）
 *   - 对齐由本模块按"显示宽度"计算（CJK/全角按 2 列），不靠手敲空格
 *
 * 用法：
 *   import { renderSpec, renderNetwork, dw } from './ladder-render.mjs'
 *   renderSpec({ legend: true, networks: [ { name:'网络 6', note:'MOV_W', rows:[...], comments:[...] } ] })
 */

/** 一个字符占几列（等宽字体下 CJK/全角 = 2，其余 = 1）。 */
export function dw(s) {
  let n = 0
  for (const ch of String(s ?? '')) {
    const c = ch.codePointAt(0)
    const wide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || c >= 0x20000
    n += wide ? 2 : 1
  }
  return n
}

/** 图例行（用户看过并认可的那一行，不要随手改）。 */
export const LEGEND = '符号：  ┤ ├ 常开触点    ┤P├ 上升沿触点    ┤==I +0├ 比较触点    ──  导线'

const DEFAULT_STYLE = {
  indent: 3,       // 缩进
  gapMin: 4,       // 左导线区在最长左侧内容之后至少留几根横线
  leftArea: 37,    // 左导线区的最小宽度（决定方框左边界落在第 3+37=40 列）
  boxMin: 24,      // 方框内部最小宽度
}

/** 渲染一个网络；返回字符串（无行则返回空串）。 */
export function renderNetwork(net, style = {}) {
  const st = { ...DEFAULT_STYLE, ...style }
  const pad = ' '.repeat(st.indent)
  const rows = (net?.rows ?? []).filter((r) => r && (r.left || r.pinL || r.pinR || r.out))
  if (!rows.length) return ''
  const head = `${net.name ?? '网络'}${net.note ? ' ── ' + net.note : ''}`

  // 无方框的网络（例如直接以线圈结尾的支路）：一行一根导线
  if (net.plain) {
    const lines = [head]
    for (const r of rows) lines.push(pad + (r.left ?? '') + (r.out ? '── ' + r.out : ''))
    for (const [i, c] of (net.comments ?? []).entries()) {
      if (!String(c ?? '').trim()) continue
      lines.push(i === 0 ? `${pad}说明：${c}` : ' '.repeat(st.indent + dw('说明：')) + c)
    }
    return lines.join('\n')
  }

  const leftW = Math.max(st.leftArea, Math.max(...rows.map((r) => dw(r.left ?? ''))) + st.gapMin)
  const pinLW = Math.max(0, ...rows.map((r) => dw(r.pinL ?? '')))
  const pinRW = Math.max(0, ...rows.map((r) => dw(r.pinR ?? '')))
  const inside = Math.max(st.boxMin, 2 + pinLW + st.gapMin + pinRW)

  const out = [head]
  out.push(pad + ' '.repeat(leftW) + '┌' + '─'.repeat(inside) + '┐')
  for (const r of rows) {
    const left = r.left ?? ''
    // 左侧内容若已以导线/触点符号收尾，就不再补空格（贴住更接近软件观感）
    const sp = /[├┤│─┐┘]/.test(left.slice(-1)) ? 0 : 1
    const wire = pad + left + ' '.repeat(sp) + '─'.repeat(Math.max(2, leftW - dw(left) - sp)) + '│'
    const l = ' ' + (r.pinL ?? '')
    const rr = (r.pinR ?? '') + ' '
    const mid = ' '.repeat(Math.max(1, inside - dw(l) - dw(rr)))
    out.push(wire + l + mid + rr + '│' + (r.out ? '── ' + r.out : ''))
  }
  out.push(pad + ' '.repeat(leftW) + '└' + '─'.repeat(inside) + '┘')
  for (const [i, c] of (net.comments ?? []).entries()) {
    if (!String(c ?? '').trim()) continue
    out.push(i === 0 ? `${pad}说明：${c}` : ' '.repeat(st.indent + dw('说明：')) + c)
  }
  return out.join('\n')
}

/** 渲染整份（标题 + 图例 + 各网络，网络之间空一行）。 */
export function renderSpec(spec) {
  const parts = []
  if (spec?.title) parts.push(spec.title, '═'.repeat(Math.max(8, dw(spec.title))))
  if (spec?.legend !== false) parts.push(typeof spec?.legend === 'string' ? spec.legend : LEGEND)
  for (const net of spec?.networks ?? []) {
    const t = renderNetwork(net, spec?.style ?? {})
    if (t) parts.push(t)
  }
  return parts.join('\n\n') + '\n'
}

/** 结构自检：返回问题列表（空数组 = 通过）。 */
export function lintSpec(spec) {
  const issues = []
  if (!Array.isArray(spec?.networks) || !spec.networks.length) issues.push('networks 为空')
  for (const [i, n] of (spec?.networks ?? []).entries()) {
    const at = `第 ${i + 1} 个网络（${n?.name ?? '无名'}）`
    if (!n?.name) issues.push(`${at}: 缺 name`)
    const rows = (n?.rows ?? []).filter((r) => r && (r.left || r.pinL || r.pinR || r.out))
    if (!rows.length) issues.push(`${at}: 没有有效行`)
    if (!n?.plain) {
      for (const r of rows) {
        if (r.out && !r.pinR) issues.push(`${at}: 行「${r.left ?? ''}」有 out 但没写 pinR（右侧引脚）`)
        if (/[\u4e00-\u9fff]/.test(String(r.left ?? ''))) issues.push(`${at}: 行「${r.left}」的 left 里混了中文——会破坏对齐，挪到 comments`)
        if (/[\u4e00-\u9fff]/.test(String(r.out ?? ''))) issues.push(`${at}: 行 out「${r.out}」里混了中文——挪到 comments`)
        if (/[\u4e00-\u9fff]/.test(String(r.pinL ?? '')) || /[\u4e00-\u9fff]/.test(String(r.pinR ?? ''))) {
          issues.push(`${at}: 引脚名里混了中文——引脚用软件里的英文名`)
        }
      }
    }
    for (const c of n?.comments ?? []) {
      if (/^\s*[①②③④⑤⑥⑦⑧⑨]/.test(String(c))) continue
    }
  }
  return issues
}
