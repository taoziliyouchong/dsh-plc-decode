#!/usr/bin/env node
/**
 * dvp-ladder.mjs —— 台达 DVP 文字梯形图（从解码器指令表还原，不自己读字节）
 *
 * 数据源唯一：`dvp_decode.py --json` 输出的每条指令（op + args，含 ORB/ANB/MPS/MRD/MPP）。
 * 报告里解得出什么，图上就画什么：未定名功能码画 `?`/`??` 盒，未识别记录画成触点并在说明里点名，
 * 不再静默省略。版式与西门子那侧同一个渲染器（lad-branches）。
 *
 * CLI：node dvp-ladder.mjs <insts.json> [from] [to]
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pExecFile = promisify(execFile)
const ASSETS_DIR = dirname(fileURLToPath(import.meta.url))
const LAD_BRANCHES = join(ASSETS_DIR, 'lad-branches.mjs')

const CONTACTS = [
  [/^(LD|AND|OR)$/, (a) => `┤${a}├`],
  [/^(LDI|ANI|ORI)$/, (a) => `┤/${a}├`],
  [/^(LDP|ANDP|ORP)$/, (a) => `┤${a}↑├`],
  [/^(LDF|ANDF|ORF)$/, (a) => `┤${a}↓├`],
]
const CONTACT_RE = /^(LD|LDI|LDP|LDF|AND|ANI|ANDP|ANDF|OR|ORI|ORP|ORF)$/
const CMP_RE = /^(\?)?CMP[（(]([^)）]*)[)）]$/

function contactGlyph(op, args) {
  const a = args.join(' ')
  for (const [re, f] of CONTACTS) if (re.test(op)) return f(a)
  return `┤${op}${a ? ' ' + a : ''}├`
}

/** 指令流 → 支路行；acc 是「母线到输出」的导线文字，ORB/ANB 按块合并。 */
function branchRows(insts) {
  const rows = []
  const notes = []
  let acc = ''
  let hasAcc = false
  const blocks = []
  const stack = []
  const pushAcc = () => { if (hasAcc) { blocks.push(acc); acc = ''; hasAcc = false } }
  const add = (s) => { acc += s; hasAcc = true }

  // 行首 LD M1000 是母线本身（rail），不再画成第一个触点
  const list = insts.slice()
  if (list[0] && list[0].op === 'LD' && (list[0].args ?? [])[0] === 'M1000') list.shift()
  for (const raw of list) {
    const op = String(raw.op ?? '')
    const args = (raw.args ?? []).map(String)
    if (CONTACT_RE.test(op)) {
      const g = contactGlyph(op, args)
      if (op.startsWith('OR')) add('∥' + g)
      else if (op.startsWith('LD')) { pushAcc(); add(g) }
      else add(g)
      continue
    }
    const cm = CMP_RE.exec(op)
    if (cm) {
      const g = `┤${cm[2] || '?'} ${args.join(' ')}├`
      if (!hasAcc && rows.length) add(rows[rows.length - 1].wire + '∥' + g)
      else add(g)
      continue
    }
    if (op.startsWith('〔?') || op.startsWith('?CMP[')) {
      add(`┤${op}├`)
      notes.push(`未识别记录 ${op}（报告「未识别记录」一节可对字节）`)
      continue
    }
    if (op === 'MPS') { stack.push(acc); continue }
    if (op === 'MRD') { acc = stack[stack.length - 1] ?? ''; hasAcc = acc !== ''; continue }
    if (op === 'MPP') { acc = stack.pop() ?? ''; hasAcc = acc !== ''; continue }
    if (op === 'ORB') {
      const b = blocks.pop()
      if (b !== undefined) { acc = b + '∥' + acc; hasAcc = true }
      else notes.push('ORB 前没有可合并的上一个块（未还原）')
      continue
    }
    if (op === 'ANB') {
      const b = blocks.pop()
      if (b !== undefined) { acc = b + acc; hasAcc = true }
      else notes.push('ANB 前没有可合并的上一个块（未还原）')
      continue
    }
    // TMR/CTR 这类「带 EN、输出还继续走」的盒：画在导线上，不当终止输出
    if (op === 'TMR' || op === 'CTR') { add(`[${op} ${args.join(' ')}]`); continue }
    // 其余一律当输出：OUT / SET / RST / 功能盒；输出不消费条件（同一串条件可带多个线圈）
    rows.push({ wire: acc, op, args })
  }
  if (hasAcc && !rows.length) notes.push(`末尾还剩一段未接输出的条件（${acc}）`)
  return { rows, notes }
}

function toSpecRows(rows) {
  return rows.map((r, i) => {
    const mark = rows.length === 1 ? '──' : i === 0 ? '┬──' : i === rows.length - 1 ? '└──' : '├──'
    const wire = mark + r.wire
    if (/^(SET|RST)$/.test(r.op)) return { wire, coil: `${r.op} ${r.args.join(' ')}` }
    if (r.op === 'OUT') return { wire, coil: r.args[0] ?? '' }
    if (r.args.length === 0) return { wire, coil: r.op }
    return {
      wire,
      box: {
        name: r.op,
        pins: [
          { name: 'EN', src: 'cond' },
          ...r.args.map((a, k) => ({ name: k === r.args.length - 1 ? 'OUT' : `IN${k + 1}`, src: a })),
        ],
      },
    }
  })
}

async function renderNet(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'dvp-lad-'))
  const f = join(dir, 'n.json')
  writeFileSync(f, JSON.stringify(spec), 'utf8')
  const { stdout } = await pExecFile(process.execPath, [LAD_BRANCHES, f], { encoding: 'utf8', maxBuffer: 8 << 20 })
  return stdout.replace(/\s+$/, '')
}

/** json：[{ seg, line, insts:[{op,args}] }]；段号按「首条是 LD M1000」的网络编号，与报告网络号一致。 */
export async function dvpLadder({ json, from, to, title, outFile }) {
  const data = JSON.parse(readFileSync(json, 'utf8'))
  const nets = data.filter((r) => {
    const first = (r.insts ?? [])[0] ?? {}
    return first.op === 'LD' && (first.args ?? [])[0] === 'M1000'
  })
  if (!nets.length) throw new Error('指令表里没有网络（首条 LD M1000）')

  const lo = from ? Number(from) : 1
  const hi = to ? Number(to) : nets.length
  const parts = [
    title ?? '台达 DVP 梯形图（由解码器指令表还原）',
    '',
    '说明：段 N＝网络 N（与解码报告的网络号一致，不是报告行号）；图上每个元件都来自解码器指令表，未定名指令画 ?/?? 盒。',
    '',
  ]
  const GROUP = 6
  for (let k = 0; k < nets.length; k++) {
    const no = k + 1
    if (no < lo || no > hi) continue
    const { rows, notes } = branchRows(nets[k].insts ?? [])
    if (!rows.length) {
      parts.push(`段 ${no}（无输出，仅条件）`, '')
      continue
    }
    const specRows = toSpecRows(rows)
    for (let g = 0; g < specRows.length; g += GROUP) {
      const grp = specRows.slice(g, g + GROUP)
      const spec = {
        title: specRows.length > GROUP ? `段 ${no}（${g + 1}-${g + grp.length}/${specRows.length} 支）` : `段 ${no}`,
        rail: 'M1000',
        rows: grp,
        comments: notes,
      }
      parts.push(await renderNet(spec), '')
    }
  }
  const out = parts.join('\n')
  if (outFile) writeFileSync(outFile, out, 'utf8')
  return out
}

/* CLI */
if (process.argv[1] && process.argv[1].endsWith('dvp-ladder.mjs')) {
  const [json, from, to] = process.argv.slice(2)
  dvpLadder({ json, from, to })
    .then((t) => process.stdout.write(t))
    .catch((e) => { console.error(String(e)); process.exit(1) })
}
