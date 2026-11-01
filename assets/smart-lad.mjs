// smart-lad.mjs —— 从 S7-200 SMART .smart 直接还原每个块的「LAD 指令序列」（= 串/并联结构），不依赖软件导出 STL
//
// 原理（破解，用导出的 .awl 逐网络回归验证 16/16）：
//   · 每个元件记录 = [u32 序号][u16 操作码][9B 头][9B 实例][载荷]；序号 = 该指令在网络里的位次
//   · 结构指令（LPS/LRD/LPP/EU/ED）单独成记录：[u32 序号][1B 操作码][02 01 01 00 00]
//   · 比较指令的第二个操作数（常数）紧跟其后：[01 02 <len> 01][u32 值]
//
// 用法: node smart-lad.mjs <工程.smart> [块名] [--net=N]
import fs from 'node:fs'
import zlib from 'node:zlib'

const AREA = { 1: 'I', 2: 'Q', 0x10: 'V', 0x20: 'M', 0x40: 'T', 0x80: 'C', 0x200: 'SM', 0x2000: 'L' }
const TY = { 1: 'bit', 2: 'byte', 4: 'word', 8: 'dword' }
// 操作码表（验证）：元件记录第二个 u16
const OPID = {
  510: 'LD', 511: 'A', 512: 'O', 513: 'ON', 514: 'AN',
  532: '=', 534: 'S', 536: 'R',
  588: 'LDW=', 589: 'LW=', 590: 'OW=', 591: 'W=',
  592: 'LDW<>', 600: 'LDW>', 601: 'LW>', 602: 'LDW<', 603: 'LW<',
  604: 'OW>', 605: 'OW<', 606: 'OW<>', 607: 'OW>=', 608: 'OW<=',
  700: 'CTU_PV', 730: '*I', 736: 'INCW', 781: 'MOVW', 855: 'TON',
}
// 结构指令记录里那一个字节
const CTRL = { 0x0b: 'EU', 0x0d: 'ED', 0x11: 'LPS', 0x12: 'LRD', 0x13: 'LPP' }

const file = process.argv[2]
const wantBlock = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null
const wantNet = (process.argv.find(a => a.startsWith('--net=')) || '').replace('--net=', '')
if (!file) { console.error('用法: node smart-lad.mjs <工程.smart> [块名] [--net=N]'); process.exit(1) }

const buf = fs.readFileSync(file)
if (buf.readUInt32LE(0) !== 0x00334853) throw new Error('不是 SH3 头的 .smart 工程')
const docLen = buf.readUInt32LE(0x6c)
const d = zlib.inflateSync(buf.subarray(0x70, 0x70 + docLen + 4096)).subarray(0, docLen)
const gbk = new TextDecoder('gb18030')

// 符号表：名字 → 地址（用于把符号名形式的记录解析回地址）
const sym = new Map()
for (let i = 0; i < d.length - 24; i++) {
  if (d[i] !== 2 || d[i + 1] !== 0) continue
  const ln = d.readUInt16LE(i + 2)
  if (ln > 0 && ln < 40 && i + 17 + ln < d.length && d[i + 4 + ln] === 0 && d[i + 5 + ln] === 1 && d[i + 6 + ln] === 2 && d[i + 7 + ln] === 0) {
    const t = d[i + 8 + ln]
    if (TY[t] && AREA[d.readUInt32LE(i + 9 + ln)]) {
      const n = gbk.decode(d.subarray(i + 4, i + 4 + ln)).replace(/\0+$/, '')
      if (n && !sym.has(n)) sym.set(n, addrOf(t, d.readUInt32LE(i + 9 + ln), d.readUInt32LE(i + 13 + ln)))
    }
    i += 17 + ln
    continue
  }
}

function addrOf(t, area, v) {
  const a = AREA[area]
  if (t === 1) return (area === 0x40 || area === 0x80) ? a + v : a + (v >> 3) + '.' + (v & 7)
  return a + ({ 2: 'B', 4: 'W', 8: 'D' })[t] + v
}
function operand(p) {                       // p = 元素头；返回 {name, form, negated?}
  const q = p + 18
  if (d[q] === 2 && d[q + 1] === 0 && TY[d[q + 2]] && AREA[d.readUInt32LE(q + 3)]) {
    return addrOf(d[q + 2], d.readUInt32LE(q + 3), d.readUInt32LE(q + 7))
  }
  if (d[q] === 1 && d[q + 1] === 0 && d[q + 2] === 1 && d[q + 3] === 0) {
    const l = d[q + 4]
    return '"' + gbk.decode(d.subarray(q + 5, q + 5 + l)) + '"'
  }
  return null
}
function constAfter(p, limit = 0x40) {      // 比较指令的第二个操作数（常数）或地址（跳过它自己的第一个操作数）
  for (let q = p + 18 + 11; q < Math.min(p + 18 + limit, d.length - 10); q++) {
    if (d[q] === 1 && d[q + 1] === 2 && d[q + 3] === 1) {
      const v = d.readUInt32LE(q + 4)
      if (v < 100000000) return (d[q + 2] === 4 ? (v | 0) : v).toString()
    }
    if (d[q] === 2 && d[q + 1] === 0 && TY[d[q + 2]] && AREA[d.readUInt32LE(q + 3)]) {
      return addrOf(d[q + 2], d.readUInt32LE(q + 3), d.readUInt32LE(q + 7))
    }
  }
  return null
}

/** 槽式网络的标记块：单字节 P/N/S/R，后面跟 ≥16 个 0 */
function markBefore(p) {
  const hits = []
  for (let q = p - 0x40; q >= Math.max(0, p - 0x160); q--) {
    const c = d[q]
    if ((c === 0x50 || c === 0x4e || c === 0x53 || c === 0x52) && d[q + 1] === 0 && d[q + 2] === 0) {
      let z = 0; for (let t = q + 1; t < q + 40 && d[t] === 0; t++) z++
      if (z >= 16) hits.push({ q, ch: String.fromCharCode(c) })
      if (hits.length >= 2) break
    }
  }
  // 线圈标记距元件头约 0x69，边沿标记约 0x119
  const coil = hits.find(h => p - h.q >= 0x40 && p - h.q <= 0x90 && (h.ch === 'S' || h.ch === 'R'))
  const edge = hits.find(h => p - h.q > 0x90 && p - h.q <= 0x160 && (h.ch === 'P' || h.ch === 'N'))
  return [coil, edge]
}

/** 符号名记录里的名字（Y=2 形式） */
function symbolOf(p) {
  const q = p + 18
  if (d[q] === 1 && d[q + 1] === 0 && d[q + 2] === 1 && d[q + 3] === 0) {
    const l = d[q + 4]
    if (l > 0 && l < 60) {
      const name = gbk.decode(d.subarray(q + 5, q + 5 + l))
      return '"' + name + '"'
    }
  }
  return null
}

/** 抽一个字节区间里的指令记录 */
function extract(A, B) {
  const isHeadP = (p) => d[p] === 1 && d[p + 1] === 1 && [1, 2].includes(d[p + 2]) && d[p + 3] === 0 && d[p + 4] === 0 && d[p + 7] === 3 && d[p + 8] === 1
  // 预扫：槽式线圈的位置（符号名形式的触点只在槽式网络里才算指令）
  const coilAt = []
  for (let p = A; p < B; p++) if (isHeadP(p)) { const mk = markBefore(p); if (mk[0]) coilAt.push(p) }
  const recs = []
  for (let p = A; p < B; p++) {
    // 结构指令
    if (d[p + 5] === 0x02 && d[p + 6] === 0x01 && d[p + 7] === 0x01 && d[p + 8] === 0x00 && d[p + 9] === 0x00 && CTRL[d[p + 4]]) {
      recs.push({ p, idx: d.readUInt32LE(p), ins: CTRL[d[p + 4]], arg: '' })
      continue
    }
    // 槽式网络的分支标记（b6=2 记录 = 新支路，等价 LRD）
    if (d[p] === 1 && d[p + 1] === 1 && d[p + 2] === 0 && d[p + 3] === 0 && d[p + 4] === 0 && d[p + 6] === 2 && d[p + 7] === 3 && d[p + 8] === 1) {
      recs.push({ p, idx: -1, ins: 'LRD', arg: '', slot: true, marker: true })
      continue
    }
    // 元件
    if (d[p] === 1 && d[p + 1] === 1 && [1, 2].includes(d[p + 2]) && d[p + 3] === 0 && d[p + 4] === 0 && d[p + 7] === 3 && d[p + 8] === 1) {
      const y = d[p + 6]
      const arg0 = operand(p)
      if (y === 1 && arg0) {
        const opid = d.readUInt16LE(p - 2), idx = d.readUInt32LE(p - 6)
        const ins = OPID[opid]
        if (ins) {
          let extra = ''
          if (/^LDW|^LW|^OW|^W/.test(ins) && /[<>=]/.test(ins)) { const c = constAfter(p); if (c !== null) extra = ', ' + c }
          recs.push({ p, idx, ins, arg: arg0 + extra })
          continue
        }
      }
      // 槽式 / 符号名形式：线圈看 P/N/S/R 标记块
      const mk = markBefore(p)
      const coil = mk[0] && mk[0].ch === 'S' ? 'S' : mk[0] && mk[0].ch === 'R' ? 'R' : null
      if (coil) {
        const edge = mk[1] && mk[1].ch === 'P' ? 'EU' : mk[1] && mk[1].ch === 'N' ? 'ED' : null
        const name = arg0 || (y === 2 ? symbolOf(p) : null)
        if (name) {
          if (edge) recs.push({ p, idx: -1, ins: edge, arg: '', slot: true })
          recs.push({ p, idx: -1, ins: coil, arg: name, slot: true, fromMark: true })
          continue
        }
      }
      if (y === 2) {
        // 符号名形式（触点）：只在槽式网络里（附近有槽式线圈）才算指令，否则是副本
        if (!coilAt.some(c => Math.abs(c - p) < 0x400)) continue
        const arg = arg0 || symbolOf(p)
        if (!arg) continue
        const tail = d.subarray(p + 18, p + 96)
        let code = null
        for (let i = 0; i < tail.length - 4; i++) {
          if (tail[i + 1] === 0x03 && tail[i + 2] === 0x01 && tail[i] >= 1 && tail[i] <= 3) { code = tail[i]; break }
        }
        const ins = code === 0x01 ? 'LD' : code === 0x02 ? 'A' : code === 0x03 ? 'O' : null
        if (ins) recs.push({ p, idx: -1, ins, arg, slot: true, sym: true })
      }
      continue
    }
  }
  return recs
}

const BLOCKMARK = /^[\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9_]{1,39}$/
function findBlocks() {
  const marks = []
  for (let i = 0; i < d.length - 6;) {
    if (d[i] === 0x0d && d[i + 1] === 0x00) {
      const ln = d[i + 2] | (d[i + 3] << 8)
      if (ln > 0 && ln < 40 && i + 4 + ln <= d.length) {
        const nm = gbk.decode(d.subarray(i + 4, i + 4 + ln)).trim()
        if (BLOCKMARK.test(nm)) marks.push({ off: i, name: nm })
        i += 4 + ln; continue
      }
    }
    i += 1
  }
  return marks
}

const blocks = findBlocks()
if (!blocks.length) { console.log('（未识别到块标记）'); process.exit(0) }
let out = []
for (let k = 0; k < blocks.length; k++) {
  const b = blocks[k]
  if (wantBlock && b.name !== wantBlock) continue
  const end = k + 1 < blocks.length ? blocks[k + 1].off : d.length
  const recs = extract(b.off, end)
  if (!recs.length) continue
  // 槽式/符号副本去重：与附近（±0x1000）"地址形式指令"完全相同的，视为存档副本
  const realRecs = recs.filter(r => !r.slot)
  const dropSet = new Set()
  recs.forEach((r, i) => {
    if (!r.slot || r.marker) return
    const raw = r.arg.startsWith('"') ? (sym.get(r.arg.slice(1, -1)) || r.arg) : r.arg.split(',')[0].trim()
    const win = /^(S|R|=)$/.test(r.ins) ? 0x3000 : 0x500
    if (realRecs.some(o => o.ins === r.ins && o.arg.split(',')[0].trim() === raw && Math.abs(o.p - r.p) < win)) dropSet.add(i)
  })
  // 线圈被当副本丢掉时，它前面那条边沿也要一起丢
  recs.forEach((r, i) => { if ((r.ins === 'EU' || r.ins === 'ED') && dropSet.has(i + 1)) dropSet.add(i) })
  const recs2 = recs.filter((r, i) => !dropSet.has(i))
  // 按 idx 回退切网络（槽式条目 idx=-1 不参与边界判定，只按文件顺序落在当前位置）
  const nets = []; let cn = [], last = -1
  const keep = []
  for (const r of recs2) {
    // 紧跟的"同操作数 + 同指令"副本（存档第二份）不算指令
    const prev = keep[keep.length - 1]
    if (r.slot && prev && prev.arg === r.arg && prev.ins === r.ins) continue
    keep.push(r)
  }
  for (let i = 0; i < keep.length; i++) {
    const r = keep[i], p = keep[i - 1]
    if (!r.slot) {
      // 打包网络：序号回退，或刚从槽式段出来 → 新网络
      if (r.idx <= last || (p && p.slot)) { nets.push(cn); cn = []; last = -1 }
      last = r.idx
    } else if (p && !p.slot && keep[i + 1] && keep[i + 1].slot && keep[i + 2] && keep[i + 2].slot && keep[i + 3] && keep[i + 3].slot) {
      // 打包 → 槽式（连续三条以上才算一个槽式网络）：槽式网络自成一格
      nets.push(cn); cn = []; last = -1
    }
    cn.push(r)
  }
  if (cn.length) nets.push(cn)
  // 组内二次去重：打包网络里残留的槽式副本（同组内已有同指令同地址的真身）
  for (const n of nets) {
    const real = n.filter(r => !r.slot)
    if (!real.length) continue
    for (let i = n.length - 1; i >= 0; i--) {
      const r = n[i]
      if (!r.slot || r.marker) continue
      const raw = r.arg.startsWith('"') ? (sym.get(r.arg.slice(1, -1)) || r.arg) : r.arg.split(',')[0].trim()
      if (real.some(o => o.ins === r.ins && o.arg.split(',')[0].trim() === raw)) n.splice(i, 1)
    }
  }
  // 分支标记（LRD）只在"槽式网络"里成图：该网络含标记块定类型的线圈
  for (const n of nets) {
    const isSlot = n.some(r => r.fromMark)
    if (!isSlot) {
      for (let i = n.length - 1; i >= 0; i--) if (n[i].marker) n.splice(i, 1)
      continue
    }
    const firstCoil = n.findIndex(r => r.fromMark)
    // 第一条支路之前的 LRD 无意义，丢掉；再补 LPS / LPP
    for (let i = firstCoil - 1; i >= 0; i--) if (n[i].marker) n.splice(i, 1)
    for (const r of n) if (r.marker) r.ins = 'LRD'
    const idx = n.findIndex(r => r.fromMark)
    const at = idx > 0 && (n[idx - 1].ins === 'EU' || n[idx - 1].ins === 'ED') ? idx - 1 : idx
    n.splice(at, 0, { ins: 'LPS', arg: '', slot: true })
    // LPP 落在最后一条支路之前（末支路不属于并联块）
    const k = n.length
    if (k >= 2 && (n[k - 2].ins === 'EU' || n[k - 2].ins === 'ED') && /^(S|R|=)$/.test(n[k - 1].ins)) {
      if (n[k - 3] && n[k - 3].marker) n.splice(k - 3, 1)      // 末支路的标记不是 LRD（它属于 LPP 之后那条）
      const kk = n.length
      n.splice(kk - 2, 0, { ins: 'LPP', arg: '', slot: true })
    } else n.push({ ins: 'LPP', arg: '', slot: true })
  }
  out.push(`## 块：${b.name}`)
  nets.forEach((n, i) => {
    if (wantNet && String(i + 1) !== wantNet) return
    out.push(`Network ${i + 1}`)
    // 注意：齐序号缺口：那些位次是指令盒（盒有独立记录，不产生元件行）
    const idxs = n.filter(r => !r.slot && r.idx >= 0).map(r => r.idx)
    const lo = idxs.length ? Math.min(...idxs) : -1
    const hi = idxs.length ? Math.max(...idxs) : -1
    const have = new Set(idxs)
    let shown = []
    for (const r of n) {
      if (!r.slot && r.idx >= 0) shown.push({ at: r.idx, line: `${r.ins.padEnd(6)} ${r.arg}`.trimEnd() })
      else shown.push({ at: -1, line: `${r.ins.padEnd(6)} ${r.arg}`.trimEnd() })
    }
    // 在同一网络内按位次插入缺口的占位行（槽式行保持原位）
    const outLines = []
    let k = 0
    for (let t = lo; t >= 0 && t <= hi; t++) {
      while (k < shown.length && shown[k].at === -1) { outLines.push(shown[k].line); k++ }
      if (!have.has(t)) { outLines.push(`[盒]    ← 位次 ${t}（指令盒记录，未列元件行）`); continue }
      if (k < shown.length && shown[k].at === t) { outLines.push(shown[k].line); k++ }
    }
    while (k < shown.length) { outLines.push(shown[k].line); k++ }
    out.push(...outLines)
  })
}
console.log([
  '# 说明：本表是 LAD 指令序列（= 串/并联结构）：LD/A/O/AN/ON 触点、EU/ED 边沿、LPS/LRD/LPP 并联支路、=/S/R 线圈、LDW>/OW< 等比较（带第二操作数）。',
  '# 指令盒（含库调用 CALL）不产生元件行：网络内位次缺号处标 [盒]；盒的实参用 smart-box-pins 或软件里的 CALL 行读。',
  '',
  ...out,
].join('\n'))
