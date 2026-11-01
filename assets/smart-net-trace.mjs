#!/usr/bin/env node
/**
 * smart-net-trace.mjs —— S7-200 SMART .smart 工程「网络级轨迹」提取
 *
 * 与既有工具的分工：
 *   smart-ladder-elements.mjs  只给「触点/写元件」（判读/写）
 *   smart-pin-dump.mjs         只给「地址形式操作数」（漏符号名形式）
 *   smart-block-instseq.mjs    只给「ASCII 指令名 + 符号引用」
 *   本工具把三者合到同一偏移轴：按偏移顺序输出 触点 / 写元件 / 指令盒（引脚名 + 操作数 + 常数），
 *   用于把一段块还原成「网络 = 触点序列 + 盒序列」的可读轨迹（不含串并联拓扑——那是未解盲区）。
 *
 * 记录结构（字节验证）：
 *   通用头 9B：01 01 XX 00 00 00 YY 03 01
 *     XX=01 触点（读） / XX=02 写元件（线圈、带 OUT 的盒、S-R 线圈） / XX=00 指令盒头
 *     YY=01 头后 9B 实例 + 11B 地址操作数；YY=02 头后 9B 实例 + 符号名记录 01 00 01 00 <len> <GBK>
 *   调用盒：头 9B + E9 03 <xx> 01 00 02 09 03 00 + <块名 GBK>\0
 *
 * 用法：
 *   node smart-net-trace.mjs <工程.smart> <起hex> <止hex> [--raw]
 *   --raw 同时打印每个盒窗口内的原始 hex（核对引脚归属时用）
 * 输出：每行「偏移  类型  内容」
 */
import fs from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
const A = parseInt(process.argv[3], 16)
const B = parseInt(process.argv[4], 16)
const RAW = process.argv.includes('--raw')
if (!file || !Number.isFinite(A) || !Number.isFinite(B)) {
  console.error('用法: node smart-net-trace.mjs <工程.smart> <起hex> <止hex> [--raw]')
  process.exit(2)
}

const buf = fs.readFileSync(file)
if (buf.readUInt32LE(0) !== 0x00334853) throw new Error('不是 SH3 头的 .smart 工程')
const len = buf.readUInt32LE(0x6c)
const doc = zlib.inflateSync(buf.subarray(0x70, 0x70 + len + 4096)).subarray(0, len)
const dec = new TextDecoder('gb18030')

const AREA = { 1: 'I', 2: 'Q', 0x10: 'V', 0x20: 'M', 0x40: 'T', 0x80: 'C', 0x200: 'SM', 0x2000: 'L' }
const TYPE = { 1: 'bit', 2: 'byte', 4: 'word', 8: 'dword' }
function addrName(t, area, v) {
  const a = AREA[area]
  if (t === 1) return (area === 0x40 || area === 0x80) ? a + v : a + (v >> 3) + '.' + (v & 7)
  return a + ({ 2: 'B', 4: 'W', 8: 'D' })[t] + v
}

// ---- 符号表：名字 → 地址（用符号名写的元素回查） ----
const symByName = new Map()
for (let i = 0; i < doc.length - 24; i++) {
  if (doc[i] !== 2 || doc[i + 1] !== 0) continue
  const ln = doc.readUInt16LE(i + 2)
  if (ln > 0 && ln < 40 && doc[i + 4 + ln] === 0 && doc[i + 5 + ln] === 1 &&
      doc[i + 6 + ln] === 2 && doc[i + 7 + ln] === 0) {
    const t = doc[i + 8 + ln]
    if (TYPE[t]) {
      const area = doc.readUInt32LE(i + 9 + ln), v = doc.readUInt32LE(i + 13 + ln)
      if (AREA[area]) {
        const nm = dec.decode(doc.subarray(i + 4, i + 4 + ln)).replace(/\0+$/, '')
        if (nm && !symByName.has(nm)) symByName.set(nm, addrName(t, area, v))
        i += 17 + ln
        continue
      }
    }
  }
}

const isHead = (p) => doc[p] === 1 && doc[p + 1] === 1 && doc[p + 3] === 0 && doc[p + 4] === 0 &&
  doc[p + 5] === 0 && doc[p + 7] === 3 && doc[p + 8] === 1

// 常数记录（8 字节）：01 0x <len 01|02|04> 01 <u32>
function constAt(p) {
  if (doc[p] !== 1) return null
  const ok1 = doc[p + 1] === 2 && [1, 2, 4].includes(doc[p + 2]) && doc[p + 3] === 1
  const ok2 = doc[p + 1] === 1 && [1, 2, 4].includes(doc[p + 2]) && doc[p + 3] === 1
  if (!ok1 && !ok2) return null
  const v = doc.readUInt32LE(p + 4)
  return v < 100000000 ? v : null
}

// 元素尾部端点号：同号＝并到同一个端点（并联），各异＝串联
function endpointAfter(p, size) {
  const lim = Math.min(p + size + 40, B)
  for (let e = p + size; e < lim; e++) {
    if (doc[e] !== 3 || doc[e + 1] !== 1) continue
    if (doc[e - 1] === 0 && doc[e - 2] === 0 && doc[e - 3] === 0 && doc[e - 4] === 0) return doc[e - 5]
    return doc[e - 3]
  }
  return null
}

// 元素：XX=01 触点 / XX=02 写元件
function elementAt(p) {
  if (!isHead(p)) return null
  const kind = doc[p + 2]
  if (kind !== 1 && kind !== 2) return null
  const y = doc[p + 6]
  if (y === 1) {
    if (doc[p + 18] !== 2 || doc[p + 19] !== 0) return null
    const t = doc[p + 20], area = doc.readUInt32LE(p + 21)
    if (!TYPE[t] || !AREA[area]) return null
    const name = addrName(t, area, doc.readUInt32LE(p + 25))
    return { off: p, kind, label: name, size: 29, ep: endpointAfter(p, 29) }
  }
  if (y === 2) {
    if (!(doc[p + 18] === 1 && doc[p + 19] === 0 && doc[p + 20] === 1 && doc[p + 21] === 0)) return null
    const l = doc[p + 22]
    if (!(l > 0 && l < 60)) return null
    const nm = dec.decode(doc.subarray(p + 23, p + 23 + l)).replace(/\0+$/, '')
    if (!/^[\u4e00-\u9fffA-Za-z_0-9]+$/.test(nm)) return null
    const a = symByName.get(nm)
    return { off: p, kind, label: a ? `${nm} (${a})` : nm, size: 23 + l, ep: endpointAfter(p, 23 + l) }
  }
  return null
}

// 盒：XX=00；窗口 = 到下一个「记录起点」为止，窗内收集 指令名/引脚名、操作数、常数、内嵌块名
function boxAt(p) {
  if (!isHead(p) || doc[p + 2] !== 0) return null
  let end = p + 9
  for (let q = p + 9; q < Math.min(p + 0x140, B); q++) {
    if (q > p + 9 && (isHead(q) || (doc[q] === 0xe9 && doc[q + 1] === 3 && doc[q + 3] === 1 && doc[q + 5] === 2))) { end = q; break }
    end = q
  }
  const win = doc.subarray(p, end)
  const dec2 = new TextDecoder('gb18030')
  const names = []
  for (let i = 0; i < win.length; i++) {
    if (win[i] === 0 && /[A-Za-z]/.test(String.fromCharCode(win[i + 1] || 0))) {
      let q = i + 1
      while (q < win.length && /[A-Za-z0-9_]/.test(String.fromCharCode(win[q]))) q++
      const s = win.subarray(i + 1, q).toString('latin1')
      if (s.length >= 2 && win[q] === 0) names.push({ i, s })
    }
  }
  // 内嵌被调块名：E9 03 xx 01 00 02 09 03 00 <GBK>\0
  let callee = null
  for (let i = 0; i + 10 < win.length; i++) {
    if (win[i] === 0xe9 && win[i + 1] === 3 && win[i + 3] === 1 && win[i + 5] === 2 && win[i + 6] === 9 && win[i + 7] === 3 && win[i + 8] === 0) {
      let q = i + 9
      while (q < win.length && win[q] !== 0) q++
      if (win[q] === 0) { callee = dec2.decode(win.subarray(i + 9, q)); break }
    }
  }
  const ops = [], consts = []
  for (let i = 0; i + 11 <= win.length; i++) {
    if (win[i] === 2 && win[i + 1] === 0 && TYPE[win[i + 2]] && AREA[win.readUInt32LE(i + 3)]) {
      ops.push({ i, name: addrName(win[i + 2], win.readUInt32LE(i + 3), win.readUInt32LE(i + 7)) })
      i += 10; continue
    }
    if (win[i] === 1 && win[i + 1] === 2 && win[i + 3] === 1) {
      const v = win.readUInt32LE(i + 4)
      if (v < 1000000) { consts.push({ i, name: 'K=' + v }); i += 6 }
    }
  }
  const instr = names.length ? names[0].s : '(?)'
  const pins = names.slice(1).map(n => n.s)
  return { off: p, kind: 0, instr, pins, ops, consts, callee, size: end - p, end, raw: RAW ? win : null }
}

const rows = []
for (let p = A; p < B - 30;) {
  const e = elementAt(p)
  if (e) { rows.push(e); p += e.size; continue }
  const c = constAt(p)
  if (c !== null) { rows.push({ off: p, kind: 3, value: c }); p += 8; continue }
  const x = boxAt(p)
  if (x) { rows.push(x); p += Math.max(x.size, 9); continue }
  p++
}

// 相邻重复元素（同一元件的地址形式 + 符号名形式）标记
const TAG = { 1: '触点', 2: '写', 3: '常数' }
for (let i = 0; i < rows.length; i++) {
  const r = rows[i]
  const off = '0x' + r.off.toString(16).padStart(6, '0')
  if (r.kind === 3) {
    console.log(`${off}  常数   ${r.value}`)
  } else if (r.kind === 1 || r.kind === 2) {
    const ep = r.ep === null ? '' : `   <端 ${r.ep}>`
    console.log(`${off}  ${TAG[r.kind]}   ${r.label}${ep}`)
  } else {
    const head = r.callee ? `调用 ${r.callee}` : r.instr
    const pinTxt = r.pins.length ? '[' + r.pins.join('|') + ']' : ''
    const opTxt = r.ops.map(o => o.name).join(' ')
    const kTxt = r.consts.map(c => c.name).join(' ')
    console.log(`${off}  盒   ${head}  ${pinTxt} ${opTxt}${kTxt ? '  ' + kTxt : ''}`)
    if (RAW) {
      for (let q = 0; q < r.raw.length; q += 16) {
        const s = r.raw.subarray(q, q + 16)
        const h = Array.from(s).map(b => b.toString(16).padStart(2, '0')).join(' ')
        const as = Array.from(s).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('')
        console.log(`        +0x${q.toString(16).padStart(3, '0')}  ${h.padEnd(48)}  ${as}`)
      }
    }
  }
}
console.log(`\n（0x${A.toString(16)}~0x${B.toString(16)}：元素 ${rows.filter(r => r.kind).length}，盒 ${rows.filter(r => r.kind === 0).length}）`)
