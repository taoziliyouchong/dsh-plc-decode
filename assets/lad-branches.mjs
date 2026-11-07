#!/usr/bin/env node
// lad-branches.mjs v2 —— 画「一条母线 + 多条并联支路（支路内可再并联）」的文字梯形图
//
// 画法＝软件观感：触点/导线在左、指令盒画方框带引脚、线圈画在导线上。
// （v1 用 [INCW VW222] / (S …) 的行末写法，用户看过说"不是梯形图"，已废。）
//
// 为什么需要它：
//   · stl-to-ladder 把 LPS/LRD/LPP 拆出的并联支路当成并列的独立行（每条重复母线元件），并联结构看不见；
//   · lad-box-inputs 只画「一个盒 + 多路并联输入」；ladder-render 一行只能一个盒、画不了盒与线圈混排。
//   母线上挂多条支路、末端是盒或线圈的网络用它画：内容由 spec 给、列位由脚本补，不手敲对齐。
//
// 用法：node lad-branches.mjs spec.json
// spec：{
//   title?: string,
//   rail?: string,                  // 母线文字（默认 SM0.0），画在第一条支路行
//   boxCol?: number,                // 盒左边线列（默认按最长支路自动算）
//   rows: [ { wire, box?, coil? } ],
//   vfill?: [ { col, from, to } ],  // 支路内的竖向连接：第 from 条支路 → 第 to 条支路
//   comments?: [ string ]
// }
//   wire   该支路的元件画法，**从母线列(9)开始写**：第一列 = 母线竖线接点（┬ ├ └）或空格
//          支路内二次并联：父行在分岔列写 ┬、子行在分岔列写 └，中间用 vfill 补竖线
//   box    { name, pins: [ { name, src } ] }；src:"cond" = 本支路导线接到该引脚，
//          其他值 = 值写在盒左侧的导线上（如 "VW222" / "0" / "6000"）
//   coil   "S M23.1" / "R M23.0, 2"（画成 ──( S M23.1 )）
// 只写 ASCII 与制图字符；中文只出现在 title 与 comments。
import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) {
  console.error('用法：node lad-branches.mjs spec.json')
  process.exit(2)
}
const spec = JSON.parse(readFileSync(file, 'utf8'))
const rows = (spec.rows ?? []).filter((r) => r && r.wire)
if (!rows.length) {
  console.error('spec.rows 为空')
  process.exit(2)
}

const BUS = 9
const grid = []
const ensure = (r) => { while (grid.length <= r) grid.push([]) }
const put = (r, c, s) => {
  ensure(r)
  const row = grid[r]
  while (row.length < c) row.push(' ')
  let i = c
  for (const ch of s) row[i++] = ch
}
const putCh = (r, c, ch) => {
  ensure(r)
  const row = grid[r]
  while (row.length < c) row.push(' ')
  row[c] = ch
}
const getCh = (r, c) => (grid[r] ?? [])[c] ?? ' '
const fill = (r, c0, c1, ch) => { for (let c = c0; c < c1; c++) putCh(r, c, ch) }

const longest = Math.max(...rows.map((r) => (r.wire ?? '').length))
const boxCol = spec.boxCol ?? Math.max(34, BUS + longest + 4)
const BOXW = Math.max(18, ...rows.map((r) => ((r.box?.name ?? '').length + 14)))

const lineRows = []
let line = 0
for (const r of rows) {
  const w = r.wire ?? ''
  if (r.coil) {
    // 末端线圈：左段从母线列按 wire 排，再补横线到 boxCol，保证多支路线圈同列对齐
    put(line, BUS, w)
    fill(line, BUS + w.length, boxCol, '─')
    put(line, boxCol, `( ${r.coil} )`)
    lineRows.push(line)
    line += 1
    continue
  }
  if (r.box) {
    const pins = r.box.pins ?? []
    const top = line
    put(top, boxCol, '┌' + '─'.repeat(BOXW) + '┐')
    let ln = top + 1
    pins.forEach((p, i) => {
      if (p.src === 'cond') {
        put(ln, BUS, w + '─'.repeat(Math.max(2, boxCol - BUS - w.length)))
        lineRows.push(ln)
      } else {
        const v = String(p.src ?? '')
        const vc = Math.max(BUS + 2, boxCol - 3 - v.length)
        put(ln, vc, v)
        fill(ln, vc + v.length + 1, boxCol, '─')
      }
      put(ln, boxCol, `│ ${String(p.name ?? '').padEnd(BOXW - 2, ' ')}│`)
      ln += 1
      if (i === 0 && pins.length > 1) {
        put(ln, boxCol, `│ ${String(r.box.name ?? '').padEnd(BOXW - 2, ' ')}│`)
        ln += 1
      }
    })
    if (pins.length <= 1) {
      put(ln, boxCol, `│ ${String(r.box.name ?? '').padEnd(BOXW - 2, ' ')}│`)
      ln += 1
    }
    put(ln, boxCol, '└' + '─'.repeat(BOXW) + '┘')
    if (!pins.some((p) => p.src === 'cond')) lineRows.push(top)
    line = ln + 1
    continue
  }
  if (!r.box && !r.coil && /^\s/.test(w)) {
    // 纯标签行（触点名对齐用）：原样输出，不画导线、不补横线
    put(line, BUS, w)
    lineRows.push(line)
    line += 1
    continue
  }
  put(line, BUS, w)
  fill(line, BUS + w.length, boxCol, '─')
  put(line, boxCol, `( ${r.coil} )`)
  lineRows.push(line)
  line += 1
}

const first = Math.min(...lineRows)
const last = Math.max(...lineRows)
for (let r = first; r <= last; r++) {
  const ch = getCh(r, BUS)
  if (!'┬├└│'.includes(ch)) putCh(r, BUS, '│')
}
for (const v of spec.vfill ?? []) {
  const a = lineRows[v.from] ?? first
  const b = lineRows[v.to] ?? last
  for (let r = a + 1; r < b; r++) if (!'┬├└│'.includes(getCh(r, v.col))) putCh(r, v.col, '│')
}

if (spec.rail !== '') {
  const railText = spec.rail ?? 'SM0.0'
  put(first, 2, railText)
  fill(first, 2 + railText.length + 1, BUS, '─')
}

const out = []
if (spec.title) out.push(spec.title)
for (const row of grid) out.push((row ?? []).join('').replace(/\s+$/, ''))
if (spec.comments?.length) {
  out.push('')
  for (const [i, c] of spec.comments.entries()) out.push((i === 0 ? '说明：' : '      ') + c)
}
console.log(out.join('\n'))
