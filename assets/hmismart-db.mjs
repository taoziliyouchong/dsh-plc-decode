#!/usr/bin/env node
/**
 * hmismart-db.mjs —— 西门子 WinCC flexible SMART 工程（.hmismart）数据库直读解码
 *
 * 为什么有这条路径：.hmismart 本身就是 SQL Server 数据库文件（页 8192，头 01 0F 00 00）。
 * 画面 → 元件 → 文本的父子链在 HmiBasicTable.ParentId 上，直接查表就能拿到「哪句文字在哪个画面」；
 * 在二进制里扫字符串永远只能得到一堆无归属的文本。
 *
 * 用法：
 *   node hmismart-db.mjs <工程.hmismart> [输出目录]
 *
 * 输出（缺省写到 当前目录\解码归档\<工程名>\HMI解码\）：
 *   00-格式说明.md    容器格式与表结构说明
 *   10-画面.tsv       画面 / 文件夹 / 屏号 / 屏类型 / 元件数
 *   11-元件.tsv       画面 / 元件 / 子类型 / 位置 / 大小
 *   12-文本.tsv       画面 / 文件夹 / 元件 / 中文 / 英文 / 隐藏 / 系统消息 / 位置
 *   13-变量.tsv       变量名 / 设备号
 *   14-对象类型.tsv   对象类型码分布
 *   15-屏上文本.tsv   去重后的屏上文本（同一句多屏用「、」合并画面）
 *   08-统计.json
 *   HMI解码报告.md
 *
 * 依赖：本机装有 SQL Server LocalDB（WinCC flexible SMART 自带 WINCCFLEX2022 实例）。
 * 只读源工程：脚本先把文件整份复制到临时目录再附加，源文件不动。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
if (!args[0]) {
  console.error('用法: node hmismart-db.mjs <工程.hmismart> [输出目录]')
  process.exit(2)
}
const src = path.resolve(args[0])
if (!fs.existsSync(src)) { console.error('文件不存在: ' + src); process.exit(2) }
const projectName = path.basename(src, path.extname(src))
const outDir = path.resolve(args[1] || path.join(process.cwd(), '解码归档', projectName, 'HMI解码'))
fs.mkdirSync(outDir, { recursive: true })

/* ---------- 1. 调 PowerShell 附加数据库并导出 TSV ---------- */
const ps1 = path.join(HERE, 'hmismart-db.ps1')
if (!fs.existsSync(ps1)) { console.error('插件资源缺失: ' + ps1); process.exit(2) }

function findShell() {
  const cands = ['powershell.exe', 'pwsh.exe']
  for (const c of cands) {
    const r = spawnSync(c, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 30000 })
    if (r.status === 0) return c
  }
  return null
}
const shell = findShell()
if (!shell) { console.error('找不到 PowerShell（powershell.exe / pwsh.exe 都不可用），无法附加 LocalDB'); process.exit(3) }

const r = spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Source', src, '-Out', outDir],
  { encoding: 'utf8', timeout: 1800000, maxBuffer: 64 * 1024 * 1024 })
if (r.status !== 0) {
  console.error((r.stdout || '') + (r.stderr || ''))
  console.error('附加 LocalDB 失败：本机可能没装 SQL Server LocalDB，或数据库版本高于本机引擎。')
  process.exit(4)
}

/* ---------- 2. 表头改成中文 ---------- */
const HEAD = {
  '10-screen.tsv': ['画面', '文件夹', '屏号', '屏类型', '元件数'],
  '11-item.tsv': ['画面', '元件', '子类型', 'X', 'Y', '宽', '高'],
  '12-text.tsv': ['画面', '文件夹', '元件', '中文', '英文', '隐藏', '系统消息', '类型', 'X', 'Y'],
  '13-tag.tsv': ['变量', '设备号'],
  '14-type.tsv': ['类型码', '条数'],
}
const FINAL = {
  '10-screen.tsv': '10-画面.tsv',
  '11-item.tsv': '11-元件.tsv',
  '12-text.tsv': '12-文本.tsv',
  '13-tag.tsv': '13-变量.tsv',
  '14-type.tsv': '14-对象类型.tsv',
}
const readTsv = (f) => {
  const p = path.join(outDir, f)
  if (!fs.existsSync(p)) return { header: [], rows: [] }
  const raw = fs.readFileSync(p, 'utf8').split('\n').filter(l => l.length)
  const rows = raw.slice(1).map(l => l.split('\t'))
  return { header: raw[0] ? raw[0].split('\t') : [], rows }
}
const writeTsv = (name, header, rows) => {
  const body = [header.join('\t'), ...rows.map(r => r.join('\t'))].join('\n') + '\n'
  fs.writeFileSync(path.join(outDir, name), body, 'utf8')
}

const DATA = {}
for (const [en, zh] of Object.entries(FINAL)) {
  DATA[en] = readTsv(en)
  writeTsv(zh, HEAD[en], DATA[en].rows)
  try { fs.unlinkSync(path.join(outDir, en)) } catch {}
}

/* ---------- 3. 屏上文本：去重 + 多屏合并 ---------- */
const text = DATA['12-text.tsv'].rows.map(r => ({
  screen: r[0] || '', folder: r[1] || '', item: r[2] || '',
  zh: (r[3] || '').replace(/^\s*<text>/i, '').replace(/<\/text>\s*$/i, '').replace(/<text>/gi, '').replace(/<\/text>/gi, ''),
  en: r[4] || '', hidden: r[5] === 'True', sysmsg: r[6] === 'True', type: r[7] || '',
}))

const keyOf = s => s.replace(/\s+/g, '').trim()
const merged = new Map() // key -> { text, screens:Set, folders:Set }
for (const t of text) {
  const zh = t.zh.trim()
  if (!zh) continue
  const k = keyOf(zh)
  if (!merged.has(k)) merged.set(k, { text: zh.replace(/\s+$/, ''), screens: new Set(), folders: new Set() })
  const m = merged.get(k)
  if (t.screen) m.screens.add(t.screen)
  if (t.folder && t.folder !== 'HmiScreenFolder') m.folders.add(t.folder)
}

const screenOrder = DATA['10-screen.tsv'].rows
  .map(r => ({ name: r[0], num: parseInt(r[2], 10) }))
  .filter(s => s.name)
const orderOf = (() => {
  const m = new Map()
  screenOrder.forEach((s, i) => m.set(s.name, isNaN(s.num) ? 9000 + i : s.num))
  return n => m.has(n) ? m.get(n) : 8000
})()

const dumpRows = [...merged.values()].map(v => {
  const screens = [...v.screens].sort((a, b) => orderOf(a) - orderOf(b) || a.localeCompare(b))
  const folders = [...v.folders].sort()
  return [folders.length ? folders.join('、') : '', screens.join('、'), v.text]
}).sort((a, b) => (a[0] || '').localeCompare(b[0] || '') || (a[1] || '').localeCompare(b[1] || '') || a[2].localeCompare(b[2]))

writeTsv('15-屏上文本.tsv', ['文件夹', '画面', '文本'], dumpRows)

/* ---------- 4. 统计与报告 ---------- */
const screens = DATA['10-screen.tsv'].rows
const items = DATA['11-item.tsv'].rows
const tags = DATA['13-tag.tsv'].rows
const zhOnly = [...merged.values()].filter(v => /[\u4e00-\u9fff]/.test(v.text))

const byScreen = new Map()
for (const t of text) {
  if (!t.screen || !/[\u4e00-\u9fff]/.test(t.zh)) continue
  byScreen.set(t.screen, (byScreen.get(t.screen) || 0) + 1)
}
const screenRank = [...byScreen.entries()].sort((a, b) => b[1] - a[1])

const stat = {
  file: src, size: fs.statSync(src).size,
  pageSize: 8192,
  screens: screens.length,
  items: items.length,
  textRows: text.length,
  uniqueTexts: merged.size,
  uniqueChinese: zhOnly.length,
  tags: tags.length,
  screensWithChinese: byScreen.size,
  generatedAt: new Date().toISOString(),
}
fs.writeFileSync(path.join(outDir, '08-统计.json'), JSON.stringify(stat, null, 2), 'utf8')

fs.writeFileSync(path.join(outDir, '00-格式说明.md'), `# .hmismart 格式说明

## 容器

\`.hmismart\` **就是 SQL Server 数据库文件（MDF）**。

- 文件头：\`01 0F 00 00 08 02 00 00\`，与 \`model.mdf\` 同构
- 页大小 **8192** 字节（不是 4096）；文件长度可被 8192 整除
- 打开方式：整份复制 → 附加到 SQL Server LocalDB 实例 \`WINCCFLEX2022\`（\`FOR ATTACH_REBUILD_LOG\`）→ 直查表

## 关键表

| 表 | 作用 | 关键字段 |
|---|---|---|
| \`HmiBasicTable\` | 对象树，所有对象的统一登记 | \`ObjId\` / \`ObjName\` / \`ParentId\` / \`ObjTypeCode\` / \`Deleted\` |
| \`HmiScreenTable\` | 画面属性 | \`Id\` / \`Number\` / \`ScreenDeviceType\` / \`ByteBlob\` |
| \`HmiScreenItemTable\` | 元件几何 | \`Id\` / \`Layer\` / \`LocationX/Y\` / \`SizeX/Y\` |
| \`HmiTextTable\` | 文本（每对象一条，多语言分槽） | \`Id\` / \`Language0..31\` / \`IsHiddenText\` / \`IsSystemMessageText\` |

## 对象类型码（\`ObjTypeCode\`）

| 类型码 | 含义 |
|---|---|
| \`1687591545\` | 画面 |
| \`-2139304638\` | 画面文件夹 |
| \`-1426153460\` | 画面元件 |
| \`-1504425023\` | 文本对象 |
| \`-805315726\` | 非显示属性（Appearance / PropertyTag） |
| \`1179361025\` | HMI 变量 |

## 归属链

\`\`\`
HmiTextTable.Id  = HmiBasicTable(文本对象).ObjId
HmiBasicTable(文本对象).ParentId   = HmiBasicTable(元件).ObjId
HmiBasicTable(元件).ParentId       = HmiBasicTable(画面).ObjId
\`\`\`

## 容易踩的坑

- 页大小是 **8192**，按 4096 切会全错位。
- 文件里的 gzip 段只是 .NET DataSet 的增量块，**不是**对象数据；靠扫 gzip 只能得到无归属文本。
- 属性 blob 是 Utah 序列化（magic \`DBTM\` / \`Utah\`），不是加密；但属性里不含「元件→文本」的边，别在那条路上耗。
- 源工程被 WinCC 打开时会被独占；复制要带 \`FileShare::ReadWrite|Delete\`。
- 残留的 LocalDB 库会锁住源文件（\`RECOVERY_PENDING\`），先 \`sqllocaldb stop WINCCFLEX2022 -k\` 再复制。
`, 'utf8')

const md = []
md.push(`# HMI 解码报告（${projectName}）`)
md.push('')
md.push(`- 源文件：\`${src}\``)
md.push(`- 大小：${(stat.size / 1048576).toFixed(1)} MB（8192 字节/页）`)
md.push('')
md.push('## 一、规模')
md.push('')
md.push(`- 画面：**${stat.screens}** 个（其中 ${stat.screensWithChinese} 个含中文文本）`)
md.push(`- 元件：**${stat.items}** 条`)
md.push(`- 文本对象：**${stat.textRows}** 条；去重后 **${stat.uniqueTexts}** 句，含中文 **${stat.uniqueChinese}** 句`)
md.push(`- 变量：**${stat.tags}** 个`)
md.push('')
md.push('## 二、文本最多的画面')
md.push('')
for (const [name, n] of screenRank.slice(0, 15)) md.push(`- ${name}：${n} 条`)
md.push('')
md.push('## 三、怎么用')
md.push('')
md.push('- 要逐条看屏上文字：读 `12-文本.tsv`（画面｜元件｜中文｜英文｜位置）')
md.push('- 要拿去翻译的清单：读 `15-屏上文本.tsv`（已去重，同一句多屏用「、」合并）')
md.push('- 要核对画面结构：读 `10-画面.tsv` / `11-元件.tsv`')
md.push('- 坐标可判元件是否落在屏内；但屏尺寸要自己确认（`HmiScreenTable.ScreenDeviceType` 只给型号，不给分辨率）')
fs.writeFileSync(path.join(outDir, 'HMI解码报告.md'), md.join('\n') + '\n', 'utf8')

console.log(`画面 ${stat.screens} / 元件 ${stat.items} / 文本 ${stat.textRows}（去重 ${stat.uniqueTexts}，含中文 ${stat.uniqueChinese}）/ 变量 ${stat.tags}`)
console.log('产物目录: ' + outDir)
