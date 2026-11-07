#!/usr/bin/env node
/**
 * smart-ladder-auto.mjs —— .smart 工程 → 盒式文字梯形图（自动出图）
 *
 * 链路：spawn smart-lad.mjs 拿每块每网络的 LAD 指令序列（LD/A/O/AN/ON/EU/ED/LPS/LRD/LPP/=/S/R + 比较触点 + [盒] 占位）
 *      → 折叠成 lad-branches 的支路 spec（母线 + 多支路 + 盒 + 线圈）
 *      → spawn lad-branches.mjs 渲染（版式单一正文在它那里，这里不复制渲染逻辑）
 *
 * V1 边界（诚实声明）：
 *   · 支持主形态：母线触点(LD) + 串/并联触点 + 边沿 + 比较触点 + S/R/=/线圈 + 单层 LPS/LRD/LPP 支路；
 *   · 指令盒（TON/CTU/CALL 等无法从元件记录拿实参的）画占位框（BOX#位次），实参用 smart-box-pins 查；
 *   · 嵌套 LPS（栈深>2）、ALD/OLD 复杂栈运算按原样标注，不猜。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pExecFile = promisify(execFile)

const ASSETS_DIR = dirname(fileURLToPath(import.meta.url))
const SMART_LAD = join(ASSETS_DIR, 'smart-lad.mjs')
const LAD_BRANCHES = join(ASSETS_DIR, 'lad-branches.mjs')

/* ---------- 解析 smart-lad 文本 ---------- */

/** 把 smart-lad 的输出按块/网络拆成指令行 */
export function parseLadText(text) {
  const blocks = []
  let cur = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    const bm = line.match(/^## 块：(.+)$/)
    if (bm) { cur = { name: bm[1], nets: [] }; blocks.push(cur); continue }
    if (!cur) continue
    const nm = line.match(/^Network (\d+)$/)
    if (nm) { cur.nets.push({ no: Number(nm[1]), ins: [] }); continue }
    if (!line || line.startsWith('#')) continue
    if (!cur.nets.length) cur.nets.push({ no: cur.nets.length + 1, ins: [] })
    cur.nets[cur.nets.length - 1].ins.push(line)
  }
  return blocks
}

/* ---------- 指令 → 触点/盒/线圈 ---------- */

const CMP_RE = /^(L|A|O)(W|D)?(<>|<=|>=|=|<|>)$/
const RAIL_PASS = /^(SM0\.0|Always_On|First_Scan_On)$/i

/** 一个触点的文字画法：地址在左、触点符号在右 */
function contact(addr, negate, edge) {
  if (edge) return `──${edge}├`
  return `──${addr} ─${negate ? '┤/├' : '┤ ├'}`
}

/** 比较触点：两个操作数都内联（┤>=I LW0, +31├），不丢操作数 */
function cmpContact(size, rel, a, b) {
  const sym = `${size === 'D' ? 'D' : 'I'}${rel}`
  return `──┤${sym}│ ${a}, ${b}├`
}

/** 一条指令行 → 对 cur 的增量；返回 {kind, wire?, coil?, box?} 或 null(纯增量) */
function applyIns(line, st) {
  // [盒] 占位
  const bm = line.match(/^\[盒\]\s*←\s*位次\s*(\d+)/)
  if (bm) return { kind: 'box', name: `BOX#${bm[1]}` }

  const m = line.match(/^(\S+)\s*(.*)$/)
  if (!m) return null
  const op = m[1]
  const args = m[2] ? m[2].split(',').map((s) => s.trim()) : []

  const cm = op.match(CMP_RE)
  if (cm) {
    if (args.length < 2) return null
    st.cur += cmpContact(cm[2], cm[3], args[0], args[1])
    return null
  }

  switch (op) {
    case 'LD': case 'LDN':
      st.cur = RAIL_PASS.test(args[0]) ? '' : contact(args[0], op === 'LDN')
      if (!st.cur) st.rail = args[0]
      return null
    case 'A': st.cur += contact(args[0], false); return null
    case 'AN': st.cur += contact(args[0], true); return null
    case 'O': st.cur += contact(args[0], false).replace('──', '─┬─'); return null
    case 'ON': st.cur += contact(args[0], true).replace('──', '─┬─'); return null
    case 'EU': st.cur += contact('', false, '┤P'); return null
    case 'ED': st.cur += contact('', false, '┤N'); return null
    case 'LPS': st.stack.push(st.cur); return null
    case 'LRD': if (st.stack.length) st.cur = st.stack[st.stack.length - 1]; return null
    case 'LPP': st.cur = st.stack.pop() ?? st.cur; return null
    case '=':
      return { kind: 'row', wire: st.cur, coil: args[0] }
    case 'S': case 'R':
      return { kind: 'row', wire: st.cur, coil: `${op} ${args.join(', ')}` }
    case 'ALD': case 'OLD':
      st.cur += '──(ALD/OLD 汇合)'
      return null
    default:
      // TON/CTU/MOV_ 等 smart-lad 直接给出的盒行：画占位框
      return { kind: 'box', name: op.slice(0, 12), tail: args.join(' ') }
  }
}

/** 一个网络的指令行数组 → lad-branches spec */
export function netToSpec(no, lines) {
  const st = { cur: '', stack: [], rail: 'SM0.0' }
  const rows = []
  for (const line of lines) {
    const r = applyIns(line, st)
    if (!r) continue
    if (r.kind === 'row') {
      rows.push({ wire: st.cur || '──', coil: r.coil })
      st.cur = st.stack.length ? st.stack[st.stack.length - 1] : ''
    } else if (r.kind === 'box') {
      rows.push({ wire: st.cur || '──', box: { name: r.name, pins: [{ name: 'EN', src: 'cond' }] } })
      st.cur = st.stack.length ? st.stack[st.stack.length - 1] : ''
    }
  }
  if (rows.length && rows.length > 1) {
    rows[0].wire = '┬' + rows[0].wire
    for (let i = 1; i < rows.length; i++) rows[i].wire = '└' + rows[i].wire
  }
  return {
    title: `网络${no}`,
    rail: st.rail,
    boxCol: 74,
    rows,
    vfill: rows.length > 1 ? [{ col: 9, from: 0, to: rows.length - 1 }] : [],
  }
}

/* ---------- 渲染（复用 lad-branches，单一正文） ---------- */

async function renderNet(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'lad-auto-'))
  const f = join(dir, 'n.json')
  writeFileSync(f, JSON.stringify(spec), 'utf8')
  const { stdout } = await pExecFile(process.execPath, [LAD_BRANCHES, f], { encoding: 'utf8', maxBuffer: 4 << 20 })
  return stdout.replace(/\s+$/, '')
}

/** 主入口：工程文件 + 块名（可选网络号）→ 文字梯形图 */
export async function autoLadder({ file, block, net, title }) {
  const { stdout } = await pExecFile(process.execPath, [SMART_LAD, file, ...(block ? [block] : [])], {
    encoding: 'utf8', maxBuffer: 32 << 20,
  })
  const blocks = parseLadText(stdout)
  if (!blocks.length) throw new Error(`smart-lad 没解析出块：${file}`)
  const picked = block ? blocks.find((b) => b.name === block) : blocks[0]
  if (!picked) throw new Error(`没找到块「${block}」，现有：${blocks.map((b) => b.name).join('、')}`)

  const parts = [title ?? `${picked.name} · 盒式梯形图（自动生成）`, '']
  let count = 0
  for (const n of picked.nets) {
    if (net && n.no !== Number(net)) continue
    if (!n.ins.length) continue
    const spec = netToSpec(n.no, n.ins)
    if (!spec.rows.length) continue
    parts.push(await renderNet(spec), '')
    count++
  }
  if (!count) throw new Error('该块没有可渲染的网络')
  const note = '说明：BOX#n＝指令盒占位（实参用 smart-box-pins 按位次/区间查）；比较触点两操作数内联标注。'
  return parts.join('\n') + '\n' + note + '\n'
}

/* CLI：node smart-ladder-auto.mjs <工程.smart> [块名] [网络号] [输出.txt] */
if (process.argv[1] && process.argv[1].endsWith('smart-ladder-auto.mjs')) {
  const [file, block, net, out] = process.argv.slice(2)
  autoLadder({ file, block, net })
    .then((text) => {
      process.stdout.write(out ? `${text}\n（已写入 ${out}）\n` : text)
      if (out) writeFileSync(out, text, 'utf8')
    })
    .catch((e) => { console.error(String(e)); process.exit(1) })
}
