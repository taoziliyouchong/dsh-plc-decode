// mcgs-decode.mjs —— MCGS / LSTP Studio 工程解码（.MCP / .MCP.mcgs）
//
// 格式：文件头 `Standard Jet` = Microsoft Access 数据库（Jet 4.0）。
// 用 32 位 PowerShell 的 OleDb 读（64 位宿主没有 Jet 驱动）。
// 关键表：WndUser 画面 / Data 变量 / Alarm 报警 / Stgy 策略 / WndControl 控件。
//
// 用法：node mcgs-decode.mjs <工程.MCP> [输出目录]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const PS32 = 'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe'
const TABLES = [
  ['WndUser', '画面', ['iID', 'strName', 'strNote']],
  ['Data', '变量', ['iDataID', 'strName', 'strNote', 'strUnit', 'iDataType', 'strInitValue']],
  ['Alarm', '报警', ['iAlarmID', 'strNote', 'iPriority']],
  ['Stgy', '策略', ['iStgyID', 'strStgyName', 'strStgyComment']],
  ['WndControl', null, null],
]

function readTables(dbPath) {
  const body = TABLES.map(([t, , cols]) => {
    // 注意：这里的 ${...} 必须全部在 Node 侧展开 —— 写进 ps1 后 PowerShell 会把 ${x} 当变量插值，
    // 之前就是因为它把 SQL 里的 ${sel}/${t} 吃掉，导致 “'' is not a valid name”。
    const sel = cols ? cols.map((c) => `[${c}]`).join(',') : '*'
    const sql = `SELECT ${sel} FROM [${t}]`
    const cnt = `SELECT COUNT(*) FROM [${t}]`
    return `
try {
  $c = $cn.CreateCommand(); $c.CommandText = "${cnt}"; $n = $c.ExecuteScalar()
  $c = $cn.CreateCommand(); $c.CommandText = "${sql}"
  $rd = $c.ExecuteReader()
  $rows = @()
  while ($rd.Read()) {
    $o = [ordered]@{}
    for ($i=0; $i -lt $rd.FieldCount; $i++) { $o[$rd.GetName($i)] = $rd.GetValue($i) }
    $rows += [pscustomobject]$o
  }
  $rd.Close()
  $out['${t}'] = [pscustomobject]@{ count = $n; rows = $rows }
} catch { $out['${t}'] = [pscustomobject]@{ count = -1; error = $_.Exception.Message } }
`
  }).join('\n')
  const ps = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$out = [ordered]@{}
$cn = New-Object System.Data.OleDb.OleDbConnection("Provider=Microsoft.Jet.OLEDB.4.0;Data Source=${dbPath.replace(/"/g, '""')};")
$cn.Open()
${body}
$cn.Close()
$out | ConvertTo-Json -Depth 6 -Compress
`
  const tmp = path.join(os.tmpdir(), `mcgs-${Date.now()}.ps1`)
  // PowerShell 5.1 读 .ps1 时按 ANSI 解析中文，必须带 BOM 才认 UTF-8
  fs.writeFileSync(tmp, '\ufeff' + ps, 'utf8')
  try {
    const raw = execFileSync(PS32, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], {
      encoding: 'utf8', maxBuffer: 64 << 20, timeout: 180000,
    })
    fs.rmSync(tmp, { force: true })
    return JSON.parse(raw.trim() || '{}')
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw new Error(`读取 MCGS 数据库失败：${String(e.message).split('\n')[0]}`)
  }
}

function main() {
  const file = process.argv[2]
  if (!file) {
    console.error('用法: node mcgs-decode.mjs <工程.MCP> [输出目录]')
    process.exit(2)
  }
  const abs = path.resolve(file)
  if (!fs.existsSync(abs)) { console.error(`文件不存在: ${file}`); process.exit(2) }
  const head = fs.readFileSync(abs).subarray(4, 19).toString('binary')
  if (!head.includes('Standard Jet')) {
    console.error(`不是 MCGS/Access 工程（文件头: ${head.replace(/[^\x20-\x7e]/g, '.')}）`)
    process.exit(3)
  }
  const outDir = process.argv[3] ? path.resolve(process.argv[3])
    : path.join(path.dirname(abs), '解码归档', path.basename(abs, path.extname(abs)))
  fs.mkdirSync(outDir, { recursive: true })

  const data = readTables(abs)
  const L = []
  L.push(`# ${path.basename(abs)} · MCGS 解码`)
  L.push('')
  L.push(`- 源文件: ${path.basename(abs)}（${(fs.statSync(abs).size / 1024).toFixed(0)} KB，Access/Jet 数据库）`)
  const wnd = data.WndUser?.rows || []
  L.push(`- 规模: 画面 ${wnd.length} / 变量 ${data.Data?.count ?? '?'} / 报警 ${data.Alarm?.count ?? '?'} / 策略 ${data.Stgy?.count ?? '?'}`)
  L.push('')
  L.push('## 画面')
  L.push('')
  L.push('| ID | 画面名 | 备注 |')
  L.push('|---|---|---|')
  for (const r of wnd) L.push(`| ${r.iID} | ${r.strName || ''} | ${(r.strNote || '').replace(/\|/g, '/')} |`)
  const vars = data.Data?.rows || []
  if (vars.length) {
    L.push('')
    L.push('## 变量')
    L.push('')
    L.push('| ID | 名字 | 注释 | 单位 | 类型 | 初值 |')
    L.push('|---|---|---|---|---|---|')
    for (const r of vars) L.push(`| ${r.iDataID} | ${r.strName || ''} | ${(r.strNote || '').replace(/\|/g, '/')} | ${r.strUnit || ''} | ${r.iDataType ?? ''} | ${r.strInitValue ?? ''} |`)
  }
  const alms = data.Alarm?.rows || []
  if (alms.length) {
    L.push('')
    L.push('## 报警')
    L.push('')
    L.push('| ID | 内容 | 优先级 |')
    L.push('|---|---|---|')
    for (const r of alms) L.push(`| ${r.iAlarmID} | ${(r.strNote || '').replace(/\|/g, '/')} | ${r.iPriority ?? ''} |`)
  }
  const stg = data.Stgy?.rows || []
  if (stg.length) {
    L.push('')
    L.push('## 策略（脚本）')
    L.push('')
    L.push('| ID | 名字 | 注释 |')
    L.push('|---|---|---|')
    for (const r of stg) L.push(`| ${r.iStgyID} | ${r.strStgyName || ''} | ${(r.strStgyComment || '').replace(/\|/g, '/')} |`)
  }
  const errs = Object.entries(data).filter(([, v]) => v && v.error)
  if (errs.length) {
    L.push('')
    L.push('## 读取失败的表')
    for (const [k, v] of errs) L.push(`- ${k}: ${v.error}`)
  }
  const report = L.join('\n') + '\n'
  fs.writeFileSync(path.join(outDir, '解码报告.md'), report, 'utf8')
  fs.writeFileSync(path.join(outDir, '表数据.json'), JSON.stringify(data, null, 1), 'utf8')
  console.log(`OK ${path.basename(abs)} → ${outDir}`)
  console.log(`   画面 ${wnd.length} / 变量 ${data.Data?.count ?? '?'} / 报警 ${data.Alarm?.count ?? '?'} / 策略 ${data.Stgy?.count ?? '?'}`)
}

main()
