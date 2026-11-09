#!/usr/bin/env node
/**
 * hmi-auto-decode.mjs —— 触摸屏工程统一解码入口（一个脚本吃所有同类文件）
 *
 * 为什么有这个：每种屏工程本来各有解码器（.hmismart 走数据库直读、FStudio 走 SQLite、
 * NB 走 XML、MCGS 走 Access、EBpro 走编译产物），脚本散在 assets 里，每次都要先判类型再挑一个。
 * 这里把「判类型 → 调对应解码器 → 落到统一归档目录」收成一步，产物只写 解码归档\，
 * 工作区不落任何中间文件。
 *
 * 用法：
 *   node hmi-auto-decode.mjs <工程文件或工程目录> [输出目录]
 *
 * 支持：.hmismart（西门子 WinCC flexible SMART）
 *       .fsprj / 含 HMI\Frame 的工程目录（繁易 FStudio）
 *       .nbp（欧姆龙 NB-Designer）  .mcp / .mcgs（MCGS·LSTP）
 *       .emtp / .exob（威纶通 EasyBuilder Pro）
 *       无扩展名但文件头是 01 0F 00 00 的 .hmismart 副本
 *
 * 输出（缺省）：<当前目录>\解码归档\<工程文件名>\HMI解码\
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const script = (f) => path.join(HERE, f)
const PY = process.env.DSH_PYTHON || 'python'

function usage() {
  console.error('用法: node hmi-auto-decode.mjs <工程文件或工程目录> [输出目录]')
  console.error('支持: .hmismart / .fsprj(或含 HMI\\Frame 的目录) / .nbp / .mcp / .mcgs / .emtp / .exob')
  process.exit(2)
}

const args = process.argv.slice(2).filter((a) => a !== '')
if (!args.length) usage()
const input = path.resolve(args[0])
if (!fs.existsSync(input)) {
  console.error('路径不存在: ' + input)
  process.exit(2)
}
const projectName = path.basename(input, path.extname(input))
const outDir = args[1]
  ? path.resolve(args[1])
  : path.join(process.cwd(), '解码归档', projectName, 'HMI解码')

/** 判定工程类型：目录先判，其次扩展名，最后文件头（.hmismart 副本常被改名） */
function detect(p) {
  const st = fs.statSync(p)
  if (st.isDirectory()) {
    if (fs.existsSync(path.join(p, 'HMI', 'Frame'))) return { kind: 'fstudio', target: p }
    // 目录里只有一个工程文件时直接吃它
    const inner = fs.readdirSync(p).filter((n) => /\.(hmismart|fsprj|nbp|mcp|mcgs|emtp|exob)$/i.test(n))
    if (inner.length === 1) return detect(path.join(p, inner[0]))
    return { kind: 'unknown', target: p }
  }
  const low = p.toLowerCase()
  if (low.endsWith('.fsprj')) return { kind: 'fstudio', target: path.dirname(p) }
  if (low.endsWith('.hmismart')) return { kind: 'hmismart', target: p }
  if (low.endsWith('.nbp')) return { kind: 'nb', target: p }
  if (low.endsWith('.mcp') || low.endsWith('.mcgs')) return { kind: 'mcgs', target: p }
  if (low.endsWith('.emtp') || low.endsWith('.exob')) return { kind: 'ebpro', target: p }
  const head = fs.readFileSync(p).subarray(0, 4)
  if (head.length === 4 && head[0] === 0x01 && head[1] === 0x0f && head[2] === 0x00 && head[3] === 0x00) {
    return { kind: 'hmismart', target: p }
  }
  return { kind: 'unknown', target: p }
}

function run(cmd, argv, label) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 1800000, maxBuffer: 64 * 1024 * 1024 })
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim()
  if (r.status !== 0) {
    throw new Error(`${label} 退出码 ${r.status}\n${out || '(无输出)'}`)
  }
  return out
}

const det = detect(input)
if (det.kind === 'unknown') {
  console.error('认不出这是哪类触摸屏工程：' + input)
  console.error('支持: .hmismart / .fsprj(或含 HMI\\Frame 的目录) / .nbp / .mcp / .mcgs / .emtp / .exob')
  process.exit(3)
}
fs.mkdirSync(outDir, { recursive: true })

let log = ''
let note = ''
try {
  if (det.kind === 'hmismart') {
    try {
      log = run('node', [script('hmismart-db.mjs'), det.target, outDir], 'hmismart 数据库直读')
    } catch (e) {
      note = '数据库直读不可用，退回二进制扫描（只出无归属文本）：' + String(e.message).split('\n')[0]
      log = run('node', [script('hmismart-decode.mjs'), det.target, outDir], 'hmismart 二进制扫描')
    }
  } else if (det.kind === 'fstudio') {
    log = run(PY, [script('fstudio-tables.py'), det.target, outDir], 'FStudio 解码')
  } else if (det.kind === 'nb') {
    log = run('node', [script('nb-decode.mjs'), det.target, outDir], 'NB-Designer 解码')
  } else if (det.kind === 'mcgs') {
    log = run('node', [script('mcgs-decode.mjs'), det.target, outDir], 'MCGS 解码')
  } else if (det.kind === 'ebpro') {
    log = run('node', [script('ebpro-decode.mjs'), det.target, outDir], 'EBpro 解码')
  }
} catch (e) {
  console.error('解码失败：' + (e instanceof Error ? e.message : String(e)))
  process.exit(4)
}

console.log(log)
if (note) console.log('注意：' + note)

/* ---------- 西门子 .hmismart：解码完直接出「画面｜文本」两列 Excel ----------
 * 规则不在我脑子里，在 hmismart-screen-xlsx.py 里，固定这几条：
 *   1) 只取 HmiTextTable.TextType = Screens（画面上的文字；属性名、变量名、字体名不收）
 *   2) 只取 Language0 含汉字的（纯英文/纯数字/英数混排不收）
 *   3) 首字符是 ASCII 字母或数字的不收（A_进料1关、Q0.0 这类）
 *   4) Template 模板屏不收
 *   5) 同句去空白差异归一，取空格最少的写法
 *   6) 同一句多屏出现只留一行，画面列用「、」合并，按屏号排序
 *   7) 「XX开」＋「XX关」合成「XX开/关」
 */
let xlsx = ''
if (det.kind === 'hmismart' && !note) {
  try {
    xlsx = path.join(outDir, '屏幕文本.xlsx')
    run(PY, [script('hmismart-screen-xlsx.py'), outDir, xlsx], '屏幕文本表')
  } catch (e) {
    xlsx = ''
    console.log('（两列 Excel 生成失败，TSV 仍可用: ' + String(e.message).split('\n')[0] + '）')
  }
}

console.log('')
console.log(`类型: ${det.kind}`)
console.log(`产物目录: ${outDir}`)
if (xlsx) console.log(`屏上文本: ${xlsx}`)
