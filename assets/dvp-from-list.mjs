#!/usr/bin/env node
/**
 * dvp-from-list.mjs —— 用 WPLSoft 导出的指令表（CSV）当底本，出可讲的程序清单
 *
 * 为什么不用二进制反汇编当底本：.dvp 的梯形图是一张"格子图"（每 40 字节一列、每格 5 字节），
 * 列内格位表示串并联，不是执行顺序；按文件顺序读出来的指令序列与软件指令表对不上。
 * WPLSoft 自己导出的指令表是**逐条顺序**的真值，用它做底本，程序一条不差；
 * 二进制解码只负责补设备注释（指令表里没有名字）。
 *
 * 用法：
 *   node dvp-from-list.mjs <指令表.csv> [--report <解码报告.md>] [--out <输出.md>]
 */
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const csvPath = args[0]
if (!csvPath) { console.error('用法: node dvp-from-list.mjs <指令表.csv> [--report 解码报告.md] [--out 输出.md]'); process.exit(2) }
const getOpt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null }
const reportPath = getOpt('--report')
const outPath = getOpt('--out') || path.join(path.dirname(csvPath), '程序_指令表.md')

/* ---------- 指令表 ---------- */
const raw = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '')
const rows = []
for (const line of raw.split(/\r?\n/)) {
  const cells = line.split(',').map((s) => s.trim()).filter(Boolean)
  if (cells.length >= 2 && /^\d{6}$/.test(cells[0])) rows.push({ step: cells[0], op: cells[1], args: cells.slice(2) })
}
if (!rows.length) { console.error('指令表里没有可识别的行（应形如 000000,LD,M1000）'); process.exit(2) }

/* ---------- 设备注释（从解码报告里取） ---------- */
const comments = new Map()
if (reportPath && fs.existsSync(reportPath)) {
  const text = fs.readFileSync(reportPath, 'utf8')
  const seg = text.split('【设备注释')[1]
  if (seg) {
    for (const line of seg.split(/\r?\n/)) {
      const m = line.match(/^\s+([A-Z]+\d+)\s*=\s*(.+)$/)
      if (m) comments.set(m[1], m[2].trim())
    }
  }
}

/* ---------- 出文档 ---------- */
const out = []
out.push('# 程序指令表（WPLSoft 导出为底本）')
out.push('')
out.push(`- 指令表：${path.basename(csvPath)}（${rows.length} 步）`)
if (reportPath) out.push(`- 设备注释：${path.basename(reportPath)}（${comments.size} 条）`)
out.push('')
out.push('> 说明：顺序、助记符、操作数逐条取自软件导出的指令表；`#` 后是设备注释。二进制解码只用来补名字。')
out.push('')

let lastGroup = -1
for (const r of rows) {
  const g = Math.floor(Number(r.step) / 100)
  if (g !== lastGroup) {
    out.push('')
    out.push(`## 步 ${String(g * 100).padStart(6, '0')}–${String(g * 100 + 99).padStart(6, '0')}`)
    out.push('')
    out.push('```')
    lastGroup = g
  }
  const argTxt = r.args.join(' ')
  const dev = (r.args[0] || '').replace(/[^A-Z0-9]/g, '')
  const cmt = comments.get(dev)
  out.push(`${r.step}  ${(r.op + '        ').slice(0, 8)} ${argTxt.padEnd(24)}${cmt ? ' # ' + cmt : ''}`)
}
out.push('```')
out.push('')

/* ---------- 统计 ---------- */
const hist = new Map()
for (const r of rows) hist.set(r.op, (hist.get(r.op) || 0) + 1)
out.push('## 指令统计')
out.push('')
out.push('| 指令 | 次数 |')
out.push('|---|---|')
for (const [k, v] of [...hist.entries()].sort((a, b) => b[1] - a[1])) out.push(`| ${k} | ${v} |`)
out.push('')

fs.writeFileSync(outPath, out.join('\n'), 'utf8')
console.log(`已生成：${outPath}`)
console.log(`指令 ${rows.length} 步，注释 ${comments.size} 条`)
