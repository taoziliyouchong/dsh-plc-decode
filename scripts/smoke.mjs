#!/usr/bin/env node
/**
 * 冒烟测试：装载插件、核对注册面，可选对一个真实工程跑一次完整解码。
 *
 * 用法：
 *   node scripts/smoke.mjs                      # 只测装载与注册面
 *   node scripts/smoke.mjs <PLC 工程文件路径>    # 额外解码一次，核对产物落盘
 *
 * 退出码 0 表示全部通过；任一断言失败时退出码 1。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject, name as pluginName } from '../index.js'

const EXPECTED_TOOLS = 19
const EXPECTED_COMMANDS = 20

let failed = 0
const pass = (m) => console.log(`  ok   ${m}`)
const fail = (m) => { failed++; console.log(`  FAIL ${m}`) }

/** 解码产物落盘检查：四格式各自的入口文件 */
const INDEX_FILES = {
  project: '00-索引.md',
  dvp: '00-索引.md',
  smart: '00-目录.md',
  smartlib: '00-目录.md',
}

/**
 * 用子进程代替 DSH 的 shell 服务：插件只依赖 resolve/execute/result 三个方法，
 * 这里把命令交给 PowerShell 执行。插件在 runPy 里钉了 PYTHONIOENCODING=utf-8，
 * python 输出是 UTF-8，所以这里也按 UTF-8 解码（2026-11-05 前是 GBK）。
 */
function createShell() {
  return {
    resolve: (spec) => spec,
    execute: async (spec) => {
      const r = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', spec.command],
        { cwd: spec.workdir || process.cwd(), timeout: spec.timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
      )
      const utf8 = new TextDecoder('utf-8')
      return {
        result: async () => ({
          exitCode: r.status ?? 1,
          timedOut: r.error?.code === 'ETIMEDOUT',
          aborted: false,
          stdout: { text: utf8.decode(r.stdout ?? Buffer.alloc(0)) },
          stderr: { text: utf8.decode(r.stderr ?? Buffer.alloc(0)) },
        }),
      }
    },
  }
}

const tools = new Map()
const commands = new Map()
const skillProviders = []
const ctx = {
  tools: { register: (t) => tools.set(t.name, t) },
  commands: { register: (c) => commands.set(c.name, c) },
  skills: { registerProvider: (factory) => skillProviders.push(factory) },
  shell: createShell(),
  sandboxPolicy: { resolve: () => undefined },
}

function checkPlugin() {
  console.log(`插件：${pluginName}`)
  if (!pluginName || pluginName !== 'dsh-plc-decode') fail(`插件名应为 dsh-plc-decode，实际 ${pluginName}`)
  else pass('插件名')
  if (!inject.includes('tools') || !inject.includes('commands')) fail(`inject 缺项：${inject.join(', ')}`)
  else pass(`inject：${inject.join(', ')}`)
}

function checkPython() {
  const r = spawnSync('python', ['--version'], { encoding: 'utf8' })
  if (r.status === 0) pass(`python 可用：${(r.stdout || r.stderr || '').trim()}`)
  else console.log('  note 未找到 python：.project / .dvp 解码需要 Python 3.9+（.smart 不受影响）')
}

function checkRegistrations() {
  if (tools.size !== EXPECTED_TOOLS) fail(`工具数应为 ${EXPECTED_TOOLS}，实际 ${tools.size}`)
  else pass(`工具数 ${tools.size}`)
  if (commands.size !== EXPECTED_COMMANDS) fail(`命令数应为 ${EXPECTED_COMMANDS}，实际 ${commands.size}`)
  else pass(`命令数 ${commands.size}`)

  for (const [toolName, tool] of tools) {
    if (typeof tool.execute !== 'function') fail(`工具 ${toolName} 缺 execute`)
    if (!tool.description || tool.description.length < 10) fail(`工具 ${toolName} 缺描述`)
    const schema = tool.parameters
    if (!schema || schema.type !== 'object' || typeof schema.properties !== 'object') fail(`工具 ${toolName} 参数 schema 不合法`)
  }
  if (!failed) pass('各工具 execute / description / 参数 schema')

  for (const [cmdName, cmd] of commands) {
    if (typeof cmd.handler !== 'function') fail(`命令 /${cmdName} 缺 handler`)
    if (!cmd.description) fail(`命令 /${cmdName} 缺描述`)
  }
  pass('各命令 handler / description')

  if (skillProviders.length === 0) fail('未注册技能 provider')
  else pass(`技能 provider ${skillProviders.length} 个`)
}

async function checkBadFile() {
  const dir = mkdtempSync(join(tmpdir(), 'plc-decode-smoke-'))
  const bad = join(dir, 'not-a-project.smart')
  writeFileSync(bad, Buffer.from('NOPE12345678'), 'utf8')
  try {
    await tools.get('plc-decode').execute({ file: bad }, {})
    fail('坏文件应报"不是可识别的 PLC 工程文件"，实际未抛错')
  } catch (error) {
    if (/不是可识别的 PLC 工程文件/.test(String(error.message))) pass('坏文件报错路径')
    else fail(`坏文件报错内容异常：${error.message}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function checkDecode(fileArg) {
  if (!existsSync(fileArg)) { fail(`工程文件不存在：${fileArg}`); return }
  const outDir = mkdtempSync(join(tmpdir(), 'plc-decode-out-'))
  const started = Date.now()
  try {
    const value = await tools.get('plc-decode').execute({ file: fileArg, outDir }, {})
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    const kind = /类型: (\w+)/.exec(value?.text ?? '')?.[1]
      ?? (fileArg.toLowerCase().endsWith('.smartlib') ? 'smartlib' : fileArg.toLowerCase().endsWith('.smart') ? 'smart' : fileArg.toLowerCase().endsWith('.dvp') ? 'dvp' : 'project')
    const index = join(outDir, INDEX_FILES[kind] ?? '00-索引.md')
    if (existsSync(index)) pass(`解码 ${fileArg}（${kind}，${seconds}s），产物入口 ${INDEX_FILES[kind]}`)
    else fail(`解码完成但缺产物入口：${index}\n${value?.text ?? ''}`)
  } catch (error) {
    fail(`解码失败：${error.message}`)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
}

console.log('== 装载 ==')
await apply(ctx)
checkPlugin()
checkRegistrations()
console.log('== 依赖 ==')
checkPython()
console.log('== 错误路径 ==')
await checkBadFile()

const fileArg = process.argv[2]
if (fileArg) {
  console.log('== 端到端解码 ==')
  await checkDecode(fileArg)
} else {
  console.log('== 端到端解码：跳过（未给工程文件路径）==')
}

console.log(failed ? `\n失败 ${failed} 项` : '\n全部通过')
process.exit(failed ? 1 : 0)
