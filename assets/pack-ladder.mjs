#!/usr/bin/env node
// pack-ladder.mjs —— .smart → 全部块的「盒式文字梯形图」（解码包的人看件）
//
// 链路：spawn 本插件 assets/smart-lad.mjs 拿每块每网络的 LAD 指令序列
//      → 用本插件 assets/smart-ladder-auto.mjs 的 parseLadText / netToSpec 折叠成支路 spec
//      → spawn 本插件 assets/lad-branches.mjs 渲染（版式只有那一份）
// 自己只做一件事：把所有块、所有网络串起来写成一份文件，并把盒列宽按实际内容收窄（省 token）。
//
// 用法: node pack-ladder.mjs <工程.smart> <输出.txt> [只看某块]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pExec = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SMART_LAD = process.env.PACK_LADDER_SMART_LAD || path.join(HERE, 'smart-lad.mjs')
const LADDER_ASSET = process.env.PACK_LADDER_ASSET || path.join(HERE, 'smart-ladder-auto.mjs')
const LAD_BRANCHES = process.env.PACK_LADDER_BRANCHES || path.join(HERE, 'lad-branches.mjs')

const [smart, outFile, onlyBlock] = process.argv.slice(2)
if (!smart) { console.error('用法: node pack-ladder.mjs <工程.smart> <输出.txt> [只看某块]'); process.exit(2) }

const raw = execFileSync(process.execPath, [SMART_LAD, smart], { encoding: 'utf8', maxBuffer: 64 << 20 })
let parseLadText, netToSpec
try {
  const mod = await import(pathToFileURL(LADDER_ASSET).href)
  parseLadText = mod.parseLadText
  netToSpec = mod.netToSpec
} catch (e) {
  console.error(`梯形图渲染件不可用（${LADDER_ASSET}）：${e.message}`)
  process.exit(3)
}

const blocks = parseLadText(raw)
if (!blocks.length) { console.error('smart-lad 没解析出块'); process.exit(4) }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-ladder-'))
let seq = 0
const jobs = []
for (const b of blocks) {
  if (onlyBlock && b.name !== onlyBlock) continue
  for (const n of b.nets) {
    if (!n.ins.length) continue
    const spec = netToSpec(n.no, n.ins)
    if (!spec.rows.length) continue
    // 盒列宽按实际内容收窄：最长的支路导线之后留 3 列即可（原来是写死的 74）
    const railLen = (spec.rail || '').length
    const need = Math.max(9 + railLen + 2, ...spec.rows.map(r => 9 + (r.wire || '').length)) + 3
    spec.boxCol = Math.min(spec.boxCol ?? 74, need)
    jobs.push({ block: b.name, spec })
  }
}

const LIMIT = 6
const results = new Array(jobs.length)
let next = 0
async function worker() {
  while (true) {
    const i = next++
    if (i >= jobs.length) return
    const f = path.join(dir, `n${seq++}.json`)
    fs.writeFileSync(f, JSON.stringify(jobs[i].spec), 'utf8')
    try {
      const { stdout } = await pExec(process.execPath, [LAD_BRANCHES, f], { encoding: 'utf8', maxBuffer: 8 << 20 })
      results[i] = stdout.replace(/\s+$/, '')
    } catch (e) { results[i] = `（网络 ${jobs[i].spec.title} 渲染失败：${String(e.message).slice(0, 80)}）` }
  }
}
await Promise.all(Array.from({ length: LIMIT }, () => worker()))
fs.rmSync(dir, { recursive: true, force: true })

const parts = []
let curBlock = null
for (let i = 0; i < jobs.length; i++) {
  if (jobs[i].block !== curBlock) { curBlock = jobs[i].block; parts.push(`## ${curBlock}`) }
  parts.push(results[i]); parts.push('')
}
const text = parts.join('\n').replace(/\n{3,}/g, '\n\n')
if (outFile) fs.writeFileSync(outFile, text, 'utf8')
else process.stdout.write(text)
console.log(JSON.stringify({ 块: blocks.filter(b => !onlyBlock || b.name === onlyBlock).length, 网络: jobs.length, 字节: Buffer.byteLength(text, 'utf8') }))
