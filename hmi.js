/**
 * hmi-decode —— 触摸屏（HMI）工程入口
 *
 * 覆盖三类屏，跟 PLC 侧分开（PLC 工程走 plc-decode）：
 *   ① 西门子 Smart Line（WinCC flexible SMART）工程 `.hmismart`
 *      —— 数据库直读（主路）：画面/元件/文本/变量；新旧两份出差异报告。
 *   ② 繁易 FStudio / Flexem 工程 `.fsprj`
 *      —— 画面 / 控件 / 控件地址表。
 *   ③ 威纶通 EasyBuilder Pro 工程 `.emtp` / 编译产物 `.exob`
 *      —— .emtp 加密读不动，改读同目录编译产物 .exob：出画面、文字对象、报警事件与文字库条目。
 *
 * 只读源工程；产物按各自约定落 「<工作区>\解码归档\<工程名>\HMI解码\」或「<工程目录>\解码归档\」。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'


const PY = 'python'
const TIMEOUT_MS = 300_000
/** 本插件自带资源目录（hmismart 解码器 / hmismart 差异 / FStudio 脚本） */
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'assets')
const SCRIPT_FSTUDIO_TABLES = join(ASSETS_DIR, 'fstudio-tables.py')
const SCRIPT_EBPRO_DECODE = join(ASSETS_DIR, 'ebpro-decode.mjs')

// ───────────────────────── 通用工具 ─────────────────────────

function psq(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * 会话工作区根：优先 agent.session.header.cwd（本会话真正的工作区），取不到才回落进程 cwd。
 * 若只看 process.cwd()（= dsh 进程启动目录），工作区在别处时会把产物写到启动目录去。
 */
function sessionBase(agent) {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : process.cwd()
}

/** 解码产物默认归档目录：<工作区>\解码归档\<工程文件名>\ */
function defaultArchiveDir(file, base) {
  return join(base || process.cwd(), '解码归档', basename(file, extname(file)))
}

/** 把命令名后的原始输入按 shell 引号规则切成参数（支持带空格路径）。 */
function splitArgs(rawInput) {
  const line = String(rawInput ?? '').trim()
  const args = []
  let cur = ''
  let quote = null
  for (const ch of line) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (cur.length > 0) { args.push(cur); cur = '' }
    } else {
      cur += ch
    }
  }
  if (cur.length > 0) args.push(cur)
  return args
}

/** 0.1.7 起 shell 是「先 execute 拿进程句柄、再 result() 取结果」两步，这里收成一步。 */
async function shellResult(ctx, spec) {
  const handle = await ctx.shell.execute(spec)
  return await handle.result()
}

/** 会话沙箱策略（拿不到就不传，行为与旧实现一致）。 */
function policyOf(ctx, agent) {
  return ctx.sandboxPolicy && agent ? ctx.sandboxPolicy.resolve({ session: agent.session }) : undefined
}

/** 前台跑一段 shell 命令，返回 { out, err, exitCode }。 */
async function runShell(ctx, command, workdir, signal, exec) {
  const policy = policyOf(ctx, exec?.agent)
  const spec = ctx.shell.resolve({
    command,
    workdir,
    timeoutMs: TIMEOUT_MS,
    ...policy ? { sandboxPolicy: policy } : {},
    ...signal ? { signal } : {},
  })
  const res = await shellResult(ctx, spec)
  return {
    out: String(res.stdout?.text ?? '').trim(),
    err: String(res.stderr?.text ?? '').trim(),
    exitCode: res.exitCode,
  }
}

/** 跑一个 Node 脚本（本插件 assets 里的 .mjs），失败抛错。 */
async function runNode(ctx, script, argv, workdir, signal, exec) {
  if (!existsSync(script)) throw new Error(`插件资源缺失: ${script}`)
  const { out, err, exitCode } = await runShell(ctx, `& node ${psq(script)} ${argv.map(psq).join(' ')}`, workdir, signal, exec)
  if (exitCode !== 0) throw new Error(`脚本退出码 ${exitCode}\n${err || out || '(无输出)'}`)
  return out
}

// ───────────────────────── 识别 ─────────────────────────

/**
 * 识别触摸屏工程：.hmismart（西门子 Smart Line）/ FStudio（.fsprj 或含 HMI\Frame 的工程目录）。
 * 目录判断放在读文件头之前——目录不能 readFileSync。
 */
function identify(file) {
  const abs = resolve(file)
  if (!existsSync(abs)) throw new Error(`路径不存在: ${file}`)
  const low = abs.toLowerCase()
  if (low.endsWith('.fsprj')) return { kind: 'fstudio', project: dirname(abs) }
  if (low.endsWith('.hmismart')) return { kind: 'hmismart', abs }
  // 2026-11-01 新增两类组态工程（都是文件格式取证后接的，不靠截图）：
  //   .nbp        = 欧姆龙 NB-Designer（工程索引 XML，画面在同目录 HMI*/HMI*.whe）
  //   .mcp/.mcgs  = MCGS / LSTP Studio（Microsoft Access 数据库，表里就是画面/变量/报警）
  if (low.endsWith('.nbp')) return { kind: 'nb', abs }
  if (low.endsWith('.mcp') || low.endsWith('.mcgs') || low.endsWith('.mcp.mcgs')) return { kind: 'mcgs', abs }
  // 威纶通 EasyBuilder Pro：.emtp 工程本体加密读不动，解码取同工程编译产物 .exob
  if (low.endsWith('.emtp') || low.endsWith('.exob')) return { kind: 'ebpro', abs }
  if (existsSync(join(abs, 'HMI', 'Frame'))) return { kind: 'fstudio', project: abs }
  const head = readFileSync(abs).subarray(0, 4)
  if (head.length === 4 && head[0] === 0x01 && head[1] === 0x0F && head[2] === 0x00 && head[3] === 0x00) {
    return { kind: 'hmismart', abs }
  }
  throw new Error(
    `不是可识别的触摸屏工程（前 4 字节: ${[...head].map(b => b.toString(16).padStart(2, '0')).join(' ')}）: ${file}\n`
    + '支持: .hmismart（西门子 WinCC flexible SMART）/ .fsprj 或含 HMI\\Frame 的 FStudio 工程目录 / .nbp（欧姆龙 NB）/ .mcp·.mcgs（MCGS）/ .emtp·.exob（威纶通 EasyBuilder Pro）。\n'
    + '提示: PLC 工程（.project / .dvp / .smart / .smartlib）请用 plc-decode。'
  )
}

/** .fsprj → 工程目录；目录原样返回 */
function fstudioProjectDir(fileOrDir) {
  const abs = resolve(fileOrDir)
  return abs.toLowerCase().endsWith('.fsprj') ? dirname(abs) : abs
}

function requireFstudio(fileOrDir) {
  const proj = fstudioProjectDir(fileOrDir)
  if (!existsSync(join(proj, 'HMI', 'Frame'))) {
    throw new Error(`不是 FStudio 工程目录（找不到 HMI\\Frame）：${proj}`)
  }
  return proj
}

// ───────────────────────── 西门子 Smart Line .hmismart ─────────────────────────

/**
 * 解码 .hmismart。
 * 主路：assets/hmismart-db.mjs —— 工程文件本身是 SQL Server MDF，附加到 LocalDB 直查
 *       HmiBasicTable / HmiTextTable，直接拿到「画面 → 元件 → 文本」的归属链。
 * 备路：assets/hmismart-decode.mjs —— 二进制扫描（本机无 LocalDB 时兜底，只出无归属的文本与对象名）。
 * 默认产物落「<工作区>\解码归档\<工程名>\HMI解码\」。只读源工程。
 */
async function decodeHmismart(ctx, file, outDir, base, signal, exec) {
  const target = outDir || join(defaultArchiveDir(file, base), 'HMI解码')
  mkdirSync(target, { recursive: true })
  const dbDecoder = join(ASSETS_DIR, 'hmismart-db.mjs')
  const decoder = join(ASSETS_DIR, 'hmismart-decode.mjs')
  const reporter = join(ASSETS_DIR, 'hmismart-report.mjs')

  let dbLog = ''
  if (existsSync(dbDecoder)) {
    try {
      dbLog = await runNode(ctx, dbDecoder, [file, target], dirname(target), signal, exec)
      return {
        outd: target,
        text: [
          dbLog,
          '下一步: 读 HMI解码报告.md（规模 + 文本最多的画面）；画面｜元件｜文本逐条见 12-文本.tsv，去重后的屏上文本见 15-屏上文本.tsv。',
        ].filter(Boolean).join('\n'),
      }
    } catch (e) {
      dbLog = `（数据库直读不可用，退回二进制扫描: ${String(e.message || e).split('\n')[0]}）`
    }
  }

  const decodeLog = await runNode(ctx, decoder, [file, target], dirname(target), signal, exec)
  let reportLog = ''
  if (existsSync(reporter)) {
    try {
      reportLog = await runNode(ctx, reporter, [target, basename(file, extname(file))], dirname(target), signal, exec)
    } catch (e) {
      reportLog = `（报告生成跳过: ${e.message}）`
    }
  }
  return {
    outd: target,
    text: [
      dbLog,
      decodeLog,
      reportLog,
      '',
      `产物目录: ${target}`,
      '下一步: 读 HMI解码报告.md（结论+画面/变量/连接清单）；需要原始证据时读 01-对象记录.tsv / 02-对象分类.md / 03-建表脚本.sql。',
    ].filter(Boolean).join('\n'),
  }
}

/** 两份 .hmismart 的差异报告（脚本自己决定落盘位置）。 */
async function diffHmismart(ctx, oldAbs, newAbs, outDirArg, agent, signal) {
  const script = join(ASSETS_DIR, 'hmismart-diff.mjs')
  const argv = [oldAbs, newAbs]
  if (outDirArg) argv.push(outDirArg)
  const out = await runNode(ctx, script, argv, sessionBase(agent), signal, { agent })
  return `${out}\n下一步: 读报告「1. 起始画面配置」一节——两份值不同即改动点；指向「已删除」的画面会导致重启跳到别的画面。`
}

// ───────────────────────── 繁易 FStudio .fsprj ─────────────────────────

/** 跑任意本插件自带的 Python 脚本（argv 走 shell 引号）。 */
async function runPyFile(ctx, script, argv, workdir, signal, exec) {
  if (!existsSync(script)) throw new Error(`插件资源缺失: ${script}`)
  const { out, err, exitCode } = await runShell(ctx, `$env:PYTHONIOENCODING='utf-8'; & ${PY} ${psq(script)} ${argv.map(psq).join(' ')}`, workdir, signal, exec)
  if (exitCode !== 0) throw new Error(`脚本退出码 ${exitCode}\n${err || out || '(无输出)'}`)
  return out
}

/** FStudio 出结构化表：读 HMI\System\fs2.s3db（SQLite），写 画面/控件/变量 tsv。 */
async function decodeFstudio(ctx, fileOrDir, outDirArg, exec) {
  const proj = requireFstudio(fileOrDir)
  const target = outDirArg ? resolve(outDirArg) : join(proj, '解码归档')
  mkdirSync(target, { recursive: true })
  const out = await runPyFile(ctx, SCRIPT_FSTUDIO_TABLES, [proj, target], sessionBase(exec?.agent), exec?.signal, exec)
  return { text: out, target }
}

// ───────────────────────── 威纶通 EasyBuilder Pro .emtp / .exob ─────────────────────────

/**
 * EBpro 工程解码：读同工程编译产物 .exob（.emtp 本体加密读不动），出画面/文字对象/报警事件/文字库。
 * 默认产物落「<工作区>\解码归档\<工程名>\HMI解码\」。只读源文件。
 */
async function decodeEbpro(ctx, file, outDirArg, exobArg, exec) {
  const abs = resolve(file)
  const target = outDirArg ? resolve(outDirArg) : join(defaultArchiveDir(abs, sessionBase(exec?.agent)), 'HMI解码')
  mkdirSync(target, { recursive: true })
  const argv = [abs, target]
  if (exobArg) argv.push('--exob', resolve(exobArg))
  const out = await runNode(ctx, SCRIPT_EBPRO_DECODE, argv, dirname(target), exec?.signal, exec)
  return `${out}\n产物目录: ${target}\n先读 HMI解码报告.md；原始表在 10-画面.tsv / 11-文字对象.tsv / 12-报警事件.tsv / 13-文字库.tsv。`
}

// ───────────────────────── 注册面 ─────────────────────────

const SKILLS = [
  {
    name: 'hmi-decode-workflow',
    description: '触摸屏工程读取工作流：.hmismart 全解（画面/变量/连接）与新旧差异、.srt 项目文本旁路读法。接触摸屏（HMI）工程任务时加载。',
    file: 'hmi-decode-workflow.md',
  },
]

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
    required: ['ok', 'text'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

export function registerHmi(ctx) {
  // ── 工具一：触摸屏工程统一入口（.hmismart 解码 / FStudio 画面·控件·地址表）──
  ctx.tools.register({
    name: 'hmi-decode',
    description: '触摸屏/组态（HMI）工程统一入口：.hmismart（西门子 WinCC flexible SMART）→ 画面/变量/连接；.fsprj 或含 HMI\\Frame 的 FStudio 工程目录 → 画面/控件/控件地址表；.nbp（欧姆龙 NB-Designer，XML）→ 画面/控件/地址；.mcp / .mcgs（MCGS·LSTP Studio，Access 库）→ 画面/变量/报警/策略；.emtp / .exob（威纶通 EasyBuilder Pro）→ 画面/文字对象/报警事件/文字库（读编译产物）。用户提供触摸屏或组态工程文件、要求读取/理解/核对其内容时调用。只读，不改动工程文件。PLC 工程请用 plc-decode。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '触摸屏工程：.hmismart，或 .fsprj / FStudio 工程目录（含 HMI\\Frame 的那一层），或 .nbp / .mcp / .mcgs / .emtp / .exob。' },
        outDir: { type: 'string', description: '可选：输出目录；缺省 .hmismart 写工作区「解码归档\\<工程文件名>\\HMI解码\\」，FStudio 写 <工程目录>\\解码归档\\。' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const file = typeof args.file === 'string' ? args.file.trim() : ''
      if (!file) throw new Error('参数 file 不能为空')
      const outDir = typeof args.outDir === 'string' && args.outDir.trim() ? resolve(args.outDir.trim()) : undefined
      const { kind, abs, project } = identify(file)
      if (kind === 'hmismart') {
        const result = await decodeHmismart(ctx, abs, outDir, sessionBase(exec?.agent), exec?.signal, exec)
        return { ok: true, text: `已解码完成（类型: hmismart / WinCC flexible SMART 触摸屏工程）:\n${result.text}` }
      }
      if (kind === 'mcgs' || kind === 'nb') {
        // 两个组态工程解码器：脚本自己写「解码报告.md + 结构化 json」到 outDir
        const script = join(ASSETS_DIR, kind === 'mcgs' ? 'mcgs-decode.mjs' : 'nb-decode.mjs')
        const target = outDir || join(defaultArchiveDir(abs, sessionBase(exec?.agent)), 'HMI解码')
        mkdirSync(target, { recursive: true })
        const out = await runNode(ctx, script, [abs, target], dirname(target), exec?.signal, exec)
        return {
          ok: true,
          text: `已解码完成（类型: ${kind === 'mcgs' ? 'mcgs / MCGS·LSTP 组态工程（Access 库）' : 'nb / NB-Designer 工程（XML）'}）:\n${out}\n产物目录: ${target}`,
        }
      }
      if (kind === 'ebpro') {
        const text = await decodeEbpro(ctx, abs, outDir, undefined, exec)
        return { ok: true, text: `已解码完成（类型: ebpro / 威纶通 EasyBuilder Pro）:\n${text}` }
      }
      const tables = await decodeFstudio(ctx, project, outDir, exec)
      return {
        ok: true,
        text: `FStudio 工程（类型: fstudio / Flexem FStudio）:\n${tables.text}\n产物目录: ${tables.target}`,
      }
    },
  })

  // ── 工具二：西门子触摸屏新旧工程差异（.hmismart 对 .hmismart）──
  ctx.tools.register({
    name: 'hmi-diff-project',
    description: '对比新旧两份 WinCC flexible SMART 触摸屏工程（.hmismart）：起始画面配置（决定重启后显示哪个画面）/画面表记录/画面名清单/配套文件（.srt 项目文本、.data 组态数据）差异。用户要"对比新旧触摸屏工程""查画面为什么跳错""这份改了什么"时调用。只读，不改动工程文件。',
    parameters: {
      type: 'object',
      properties: {
        old: { type: 'string', description: '旧工程 .hmismart 路径（绝对或相对当前工作目录）。' },
        new: { type: 'string', description: '新工程 .hmismart 路径。' },
        outDir: { type: 'string', description: '可选：报告输出目录；缺省写工作区「解码归档\\<旧工程名>\\HMI差异_<时间戳>\\」。' },
      },
      required: ['old', 'new'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const oldF = typeof args.old === 'string' ? args.old.trim() : ''
      const newF = typeof args.new === 'string' ? args.new.trim() : ''
      if (!oldF || !newF) throw new Error('参数 old / new 都不能为空')
      const oAbs = resolve(oldF)
      const nAbs = resolve(newF)
      if (!existsSync(oAbs)) throw new Error(`旧工程不存在: ${oldF}`)
      if (!existsSync(nAbs)) throw new Error(`新工程不存在: ${newF}`)
      const outDirArg = typeof args.outDir === 'string' && args.outDir.trim() ? resolve(args.outDir.trim()) : undefined
      return { ok: true, text: await diffHmismart(ctx, oAbs, nAbs, outDirArg, exec?.agent, exec?.signal) }
    },
  })

  // ── 工具七：威纶通 EasyBuilder Pro 工程解码（读编译产物 .exob）──
  ctx.tools.register({
    name: 'ebpro-decode',
    description: '威纶通 EasyBuilder Pro（EBpro）工程解码：.emtp 工程本体压缩+加密读不动，改读同工程编译产物 .exob，解出画面清单（按大号标签对象推定）、每个文字对象（所属画面/类型码/语言槽/文字/文字度量/偏移）、报警事件文本、文字库条目；产物为「HMI解码报告.md + 00-格式说明.md + 10-画面.tsv / 11-文字对象.tsv / 12-报警事件.tsv / 13-文字库.tsv + 08-统计.json」。用户给 .emtp / .exob 要求「解码 / 读画面 / 看有哪些画面和文字」时调用。只读源文件。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'EBpro 工程 .emtp 路径 / 编译产物 .exob 路径 / 工程目录（给 .emtp 或目录时自动找同名 .exob）。' },
        outDir: { type: 'string', description: '可选：输出目录；缺省写工作区「解码归档\\<工程文件名>\\HMI解码\\」。' },
        exob: { type: 'string', description: '可选：显式指定编译产物 .exob（与 file 不同名时用）。' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const file = typeof args.file === 'string' ? args.file.trim() : ''
      if (!file) throw new Error('参数 file 不能为空')
      if (!existsSync(resolve(file))) throw new Error(`路径不存在: ${file}`)
      const outDir = typeof args.outDir === 'string' && args.outDir.trim() ? args.outDir.trim() : ''
      const exob = typeof args.exob === 'string' && args.exob.trim() ? args.exob.trim() : ''
      return { ok: true, text: await decodeEbpro(ctx, file, outDir, exob, exec) }
    },
  })

  // ── 命令一：触摸屏工程入口 ──
  ctx.commands.register({
    name: 'hmi-decode',
    description: '触摸屏工程入口：.hmismart 解码（画面/变量/连接）/ FStudio 画面·控件·地址表',
    input: { hint: '<.hmismart 路径 | .fsprj 或 FStudio 工程目录> [输出目录]' },
    handler: async ({ rawInput, agent }) => {
      try {
        const parts = splitArgs(rawInput)
        if (parts.length < 1) return ({ kind: 'error', text: '用法: /hmi-decode <.hmismart | .fsprj | FStudio 工程目录> [输出目录]（带空格路径请加引号）' })
        const outDir = parts[1] ? resolve(parts[1]) : undefined
        const { kind, abs, project } = identify(parts[0])
        if (kind === 'hmismart') {
          const result = await decodeHmismart(ctx, abs, outDir, sessionBase(agent), undefined, { agent })
          return { kind: 'success', text: `已解码完成（类型: hmismart）:\n${result.text}` }
        }
        const tables = await decodeFstudio(ctx, project, outDir, { agent })
        return { kind: 'success', text: `已解码完成（类型: fstudio）:\n${tables.text}\n产物目录: ${tables.target}` }
      } catch (error) {
        return ({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  // ── 命令二：触摸屏新旧工程差异 ──
  ctx.commands.register({
    name: 'hmi-diff',
    description: '对比新旧两个 WinCC flexible SMART 触摸屏工程 .hmismart（起始画面/画面表/画面名/配套文件差异）',
    input: { hint: '<旧.hmismart 路径> <新.hmismart 路径> [输出目录]' },
    handler: async ({ rawInput, agent }) => {
      try {
        const parts = splitArgs(rawInput)
        if (parts.length < 2) return ({ kind: 'error', text: '用法: /hmi-diff <旧.hmismart> <新.hmismart> [输出目录]（带空格路径请加引号）' })
        for (const q of parts.slice(0, 2)) {
          if (!existsSync(resolve(q))) return ({ kind: 'error', text: `文件不存在: ${q}` })
        }
        const outDirArg = parts[2] ? resolve(parts[2]) : undefined
        const text = await diffHmismart(ctx, resolve(parts[0]), resolve(parts[1]), outDirArg, agent, undefined)
        return { kind: 'success', text }
      } catch (error) {
        return ({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  ctx.skills.registerProvider(() => ({
    name: 'hmi-decode',
    list: () => Promise.resolve(SKILLS.map(s => ({
      name: s.name,
      description: s.description,
      invocation: { modelInvocable: false, userInvocable: true },
      provider: 'hmi-decode',
      source: 'bundled',
      resourceBase: { kind: 'directory', path: new URL('./assets/', import.meta.url).pathname },
      rank: BUNDLED_SKILL_RANK,
      locator: new URL(`./assets/${s.file}`, import.meta.url),
    }))),
    async get(candidate) {
      const s = SKILLS.find(x => x.name === candidate.name) ?? SKILLS[0]
      return { ...candidate, content: readFileSync(new URL(`./assets/${s.file}`, import.meta.url), 'utf8') }
    },
  }))
}
