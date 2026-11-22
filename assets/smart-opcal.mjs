#!/usr/bin/env node
/**
 * smart-opcal.mjs —— 用「导出的 STL」核对解码器里的比较指令语法
 *
 * 为什么要有它：.smart 的元件记录只存一个 u16 操作码，不存助记符。把「哪个号码是什么指令」
 * 手写成对照表，等于把某一次校准的结果焊进代码——换工程、换版本就会错，而且无从核对。
 * 解码器现在按语法算（见 smart-lad.mjs 的 cmpName）：比较操作码是连续三块、每块 18 个 =
 * 6 个关系（= <> >= <= > <）× 3 个栈操作（LD / A / O）。
 * 本工具就是这条语法的核对器：拿同一工程的 STL 导出，逐条比「解码器算出来的助记符」与
 * 「软件导出的助记符」，对上多少条、错在哪一条，直接给出。
 *
 * 用法：
 *   node smart-opcal.mjs <工程.smart> <导出.awl|.txt>
 * 退出码：0 全对上；1 有对不上的条目（会列出 STL 真值与解码器算出的名字）。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const [smartPath, awlPath] = process.argv.slice(2)
if (!smartPath || !awlPath) {
  console.error('用法: node smart-opcal.mjs <工程.smart> <导出.awl|.txt>')
  process.exit(2)
}

/* ---- 与解码器同一条语法：比较操作码 → 助记符 ---- */
function cmpName(op) {
  if (op < 570 || op > 623) return null
  const i = op - 570
  const size = ['B', 'W', 'D'][Math.floor(i / 18)]
  const rel = ['=', '<>', '>=', '<=', '>', '<'][Math.floor((i % 18) / 3)]
  const stack = ['LD', 'A', 'O'][i % 3]
  return stack + size + rel
}

/* ---------------- STL 侧 ---------------- */
const BLOCK_DECL = /^(ORGANIZATION_BLOCK|SUBROUTINE_BLOCK|INTERRUPT_BLOCK)\s+([^:]+):/
const BLOCK_END = /^END_(ORGANIZATION|SUBROUTINE|INTERRUPT)_BLOCK/
const SKIP_MNEMONIC = new Set(['VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_TEMP', 'VAR', 'END_VAR', 'BEGIN', 'TITLE'])
const CMP_MNEMONIC = /^(LD|A|O)(B|W|D)?(<>|<=|>=|=|<|>)$/

function parseAwl(text) {
  const blocks = new Map()
  let cur = null
  let net = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('//')[0].trim()
    if (!line) continue
    let m = line.match(BLOCK_DECL)
    if (m) { cur = { name: m[2].trim(), nets: [] }; blocks.set(cur.name, cur); net = null; continue }
    if (BLOCK_END.test(line)) { cur = null; net = null; continue }
    if (!cur) continue
    if ((m = line.match(/^Network\s+(\d+)/))) { net = { no: Number(m[1]), ins: [] }; cur.nets.push(net); continue }
    if (!net) continue
    const mi = line.match(/^([A-Z][A-Z0-9_<>=!]*)\s*(.*)$/)
    if (!mi) continue
    const mn = mi[1]
    if (SKIP_MNEMONIC.has(mn)) continue
    const args = mi[2] ? mi[2].split(',').map((s) => s.trim()).filter(Boolean) : []
    net.ins.push({ m: mn, args })
  }
  return blocks
}

/* ---------------- .smart 侧 ---------------- */
const AREA = { 1: 'I', 2: 'Q', 0x10: 'V', 0x20: 'M', 0x40: 'T', 0x80: 'C', 0x200: 'SM', 0x2000: 'L' }
const TY = { 1: 'bit', 2: 'byte', 4: 'word', 8: 'dword' }

function addrOf(t, area, v) {
  const a = AREA[area]
  if (t === 1) return (area === 0x40 || area === 0x80) ? a + v : a + (v >> 3) + '.' + (v & 7)
  return `${a}${{ 2: 'B', 4: 'W', 8: 'D' }[t]}${v}`
}

function loadSmart(file) {
  const buf = fs.readFileSync(file)
  if (buf.readUInt32LE(0) !== 0x00334853) throw new Error('不是 SH3 头的 .smart 工程')
  const len = buf.readUInt32LE(0x6c)
  return zlib.inflateSync(buf.subarray(0x70, 0x70 + len + 4096)).subarray(0, len)
}

function findBlocks(d) {
  const marks = []
  const dec = new TextDecoder('gb18030')
  for (let i = 0; i < d.length - 12;) {
    if (d[i] === 0x0d && d[i + 1] === 0x00) {
      const ln = d[i + 2] | (d[i + 3] << 8)
      if (ln > 0 && ln < 40 && i + 4 + ln + 6 <= d.length) {
        const nm = dec.decode(d.subarray(i + 4, i + 4 + ln)).trim()
        let zeros = 0
        for (let q = i + 4 + ln; q < i + 4 + ln + 6; q++) if (d[q] === 0) zeros++
        if (nm && zeros >= 6) { marks.push({ off: i, name: nm }); i += 4 + ln; continue }
      }
    }
    i += 1
  }
  return marks
}

function firstOperand(d, p) {
  const q = p + 18
  if (d[q] === 2 && d[q + 1] === 0 && TY[d[q + 2]] && AREA[d.readUInt32LE(q + 3)]) {
    return addrOf(d[q + 2], d.readUInt32LE(q + 3), d.readUInt32LE(q + 7))
  }
  return null
}

/** 第二个操作数：地址或常数（常数编码 01 02 <len> 01 <u32>） */
function secondOperand(d, p, limit = 0x40) {
  for (let q = p + 18 + 11; q < Math.min(p + 18 + limit, d.length - 10); q++) {
    if (d[q] === 1 && d[q + 1] === 2 && d[q + 3] === 1) {
      const v = d.readUInt32LE(q + 4)
      if (v < 100000000) return String(v)
    }
    if (d[q] === 2 && d[q + 1] === 0 && TY[d[q + 2]] && AREA[d.readUInt32LE(q + 3)]) {
      return addrOf(d[q + 2], d.readUInt32LE(q + 3), d.readUInt32LE(q + 7))
    }
  }
  return null
}

/** 块内的比较元件（按出现顺序）：操作码在比较段、带两个操作数 */
function compareElements(d, from, to) {
  const out = []
  for (let p = from; p < to - 20; p++) {
    if (!(d[p] === 1 && d[p + 1] === 1 && [1, 2].includes(d[p + 2]) && d[p + 3] === 0 &&
          d[p + 4] === 0 && d[p + 7] === 3 && d[p + 8] === 1)) continue
    const opid = d.readUInt16LE(p - 2)
    if (opid < 570 || opid > 623) continue
    const a = firstOperand(d, p) ?? secondOperand(d, p)
    if (a) out.push({ opid, a })
  }
  return out
}

function norm(s) { return String(s).replace(/\s+/g, '').toUpperCase() }

/* ---------------- 核对 ---------------- */
const d = loadSmart(smartPath)
const awl = parseAwl(fs.readFileSync(awlPath, 'utf8'))
const marks = findBlocks(d)

let checked = 0
let ok = 0
const bad = []
const missing = []

for (let k = 0; k < marks.length; k++) {
  const b = marks[k]
  const end = k + 1 < marks.length ? marks[k + 1].off : d.length
  const elems = compareElements(d, b.off, end)
  if (!elems.length) continue
  const stlBlock = awl.get(b.name)
  if (!stlBlock) { missing.push({ block: b.name, why: 'STL 里没有同名块' }); continue }

  let cursor = 0
  for (const net of stlBlock.nets) {
    for (const s of net.ins) {
      if (!CMP_MNEMONIC.test(s.m) || s.args.length < 2) continue
      let found = -1
      for (let i = cursor; i < elems.length; i++) {
        const a = norm(elems[i].a)
        // STL 里常数可能写在前面（如 AD<> +0, VD828），两侧都试
        if (a === norm(s.args[0]) || a === norm(s.args[1] ?? '')) { found = i; break }
      }
      if (found < 0) { missing.push({ block: b.name, net: net.no, stl: `${s.m} ${s.args.join(', ')}` }); continue }
      const e = elems[found]
      cursor = found + 1
      checked++
      const calc = cmpName(e.opid)
      if (calc === s.m) ok++
      else bad.push({ block: b.name, net: net.no, opid: e.opid, stl: s.m, calc, args: s.args.join(', ') })
    }
  }
}

// 触点／线圈／结构指令的码不在这里推导：它们的取反（A/AN、O/ON）与槽式网络的存在方式
// 不在操作码里，按顺序配对会串（实测主程序网络 4 整段是槽式存法）。这几类码属格式层，
// 读法写在技能文档里；本工具只负责「比较指令」这一类——它原先靠手抄，现在按语法算，由工具核对。
console.log(`比较指令核对：${checked} 条（对上 ${ok}，对不上 ${bad.length}）`)
for (const x of bad.slice(0, 20)) {
  console.log(`  对不上  ${x.block} 网络${x.net}  op=${x.opid}  STL=${x.stl}  解码器算=${x.calc}  （${x.args}）`)
}
if (missing.length) {
  console.log(`未能核对：${missing.length} 条`)
  for (const x of missing.slice(0, 10)) console.log('  ' + JSON.stringify(x))
}
process.exit(bad.length ? 1 : 0)


