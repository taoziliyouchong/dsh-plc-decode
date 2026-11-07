/**
 * hmi-decode —— 触摸屏（HMI）工程入口
 *
 * 覆盖两类屏，跟 PLC 侧分开（PLC 工程走 plc-decode）：
 *   ① 西门子 Smart Line（WinCC flexible SMART）工程 `.hmismart`
 *      —— 解码出画面/变量/连接清单；新旧两份出差异报告（起始画面/画面表/画面名/配套文件）。
 *   ② 繁易 FStudio / Flexem 工程 `.fsprj`
 *      —— 扫元件文本（按语种分槽）＋出可导入文本库的多语言表。
 *
 * 只读源工程；产物按各自约定落 「<工作区>\解码归档\<工程名>\HMI解码\」或「<工程目录>\多语言产出\」。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'


const PY = 'python'
const TIMEOUT_MS = 300_000
/** 本插件自带资源目录（hmismart 解码器 / hmismart 差异 / FStudio 脚本） */
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'assets')
const SCRIPT_FSTUDIO = join(ASSETS_DIR, 'fstudio_i18n.py')
const SCRIPT_WINCC = join(ASSETS_DIR, 'wincc_i18n.py')
const SCRIPT_FSTUDIO_TABLES = join(ASSETS_DIR, 'fstudio-tables.py')

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

/** 跑 FStudio 的 Python 脚本（WinError 5 读锁重试一次）。 */
async function runPy(ctx, argv, workdir, signal, exec) {
  const command = `& ${PY} ${psq(SCRIPT_FSTUDIO)} ${argv.map(psq).join(' ')}`
  let r = await runShell(ctx, command, workdir, signal, exec)
  if (r.exitCode !== 0 && /PermissionError|WinError 5|OSError/.test(`${r.err} ${r.out}`)) {
    r = await runShell(ctx, command, workdir, signal, exec)
  }
  if (r.exitCode !== 0) throw new Error(`python 退出码 ${r.exitCode}\n${r.err || r.out || '(无输出)'}`)
  return r.out
}

/** 跑本插件 assets 里的任意 Python 脚本（WinError 5 读锁重试一次）。 */
async function runPyScript(ctx, script, argv, workdir, signal, exec) {
  if (!existsSync(script)) throw new Error(`插件资源缺失: ${script}`)
  const command = `& ${PY} ${psq(script)} ${argv.map(psq).join(' ')}`
  let r = await runShell(ctx, command, workdir, signal, exec)
  if (r.exitCode !== 0 && /PermissionError|WinError 5|OSError/.test(`${r.err} ${r.out}`)) {
    r = await runShell(ctx, command, workdir, signal, exec)
  }
  if (r.exitCode !== 0) throw new Error(`python 退出码 ${r.exitCode}\n${r.err || r.out || '(无输出)'}`)
  return r.out
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
  if (existsSync(join(abs, 'HMI', 'Frame'))) return { kind: 'fstudio', project: abs }
  const head = readFileSync(abs).subarray(0, 4)
  if (head.length === 4 && head[0] === 0x01 && head[1] === 0x0F && head[2] === 0x00 && head[3] === 0x00) {
    return { kind: 'hmismart', abs }
  }
  throw new Error(
    `不是可识别的触摸屏工程（前 4 字节: ${[...head].map(b => b.toString(16).padStart(2, '0')).join(' ')}）: ${file}\n`
    + '支持两类: .hmismart（西门子 WinCC flexible SMART 触摸屏工程）/ .fsprj 或含 HMI\\Frame 的 FStudio 工程目录。\n'
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
 * 解码 .hmismart：调 assets/hmismart-decode.mjs（Node）＋ assets/hmismart-report.mjs 出人读报告。
 * 默认产物落「<工作区>\解码归档\<工程名>\HMI解码\」。只读源工程。
 */
async function decodeHmismart(ctx, file, outDir, base, signal, exec) {
  const target = outDir || join(defaultArchiveDir(file, base), 'HMI解码')
  mkdirSync(target, { recursive: true })
  const decoder = join(ASSETS_DIR, 'hmismart-decode.mjs')
  const reporter = join(ASSETS_DIR, 'hmismart-report.mjs')

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
  const { out, err, exitCode } = await runShell(ctx, `& ${PY} ${psq(script)} ${argv.map(psq).join(' ')}`, workdir, signal, exec)
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

async function scanFstudio(ctx, fileOrDir, outDirArg, exec) {
  const proj = requireFstudio(fileOrDir)
  const outDir = outDirArg ? resolve(outDirArg) : join(proj, '多语言产出')
  mkdirSync(outDir, { recursive: true })
  const jsonPath = join(outDir, '元件文本扫描.json')
  const out = await runPy(ctx, ['scan', proj, jsonPath], sessionBase(exec?.agent), exec?.signal, exec)
  return `扫描完成：\n${out}\n明细 JSON: ${jsonPath}`
}

async function makeFstudio(ctx, fileOrDir, outDirArg, dict, exec) {
  const proj = requireFstudio(fileOrDir)
  const outDir = outDirArg ? resolve(outDirArg) : join(proj, '多语言产出')
  mkdirSync(outDir, { recursive: true })
  const argv = ['make', proj, outDir]
  if (dict) argv.push(resolve(dict))
  const out = await runPy(ctx, argv, sessionBase(exec?.agent), exec?.signal, exec)
  return `FStudio 多语言产出：\n${out}\n`
    + `对照表: ${join(outDir, '元件多语言对照表.xlsx')}\n`
    + `导入表: ${join(outDir, '文本库导入表.xlsx')}（FStudio 文本库 → 导入）\n`
    + '下一步：把导入表导进文本库，再逐元件勾「使用文本库」指到条目。'
}

/**
 * 已导出的文本库表换语种列：第三语种（如韩语）整列换掉，其余列原样。
 * 词典给第三语种译文（json 的 "pt"/"ko"，或 py 的 ELEMENT_PT/ELEMENT_KO）。
 */
async function retagFstudio(ctx, src, outArg, dict, lang, minStatus, exec) {
  const abs = resolve(src)
  if (!existsSync(abs)) throw new Error(`源表不存在: ${src}`)
  if (!dict) throw new Error('参数 dict 必填：给第三语种词典（.json 的 {"pt": {…}} 或 .py 的 ELEMENT_PT = {…}）')
  const dpath = resolve(dict)
  if (!existsSync(dpath)) throw new Error(`词典不存在: ${dpath}`)
  const out = outArg ? resolve(outArg) : join(dirname(abs), `文本库导入表_${lang || 'third'}.xlsx`)
  const argv = ['retag', abs, out, dpath]
  if (lang) argv.push(lang)
  if (Number.isFinite(minStatus) && minStatus >= 2) argv.push(String(Math.trunc(minStatus)))
  const log = await runPy(ctx, argv, sessionBase(exec?.agent), exec?.signal, exec)
  return `${log}\n导入: FStudio → 文本库 → 导入 → 选这份表（列名已按目标语种 LCID 写好）。`
}

// ───────────────────────── 注册面 ─────────────────────────

const SKILLS = [
  {
    name: 'hmi-decode-workflow',
    description: '触摸屏工程读取工作流：.hmismart 全解（画面/变量/连接）与新旧差异、.srt 项目文本旁路读法、FStudio 多语言入口。接触摸屏（HMI）工程任务时加载。',
    file: 'hmi-decode-workflow.md',
  },
  {
    name: 'fstudio-i18n-workflow',
    description: 'FStudio/Flexem 触摸屏多语言翻译的正确工作流：三步（扫元件文本→出对照表→出可导入表）与踩坑清单（列名逐字符一致、元件文字写死不走文本库、原工程英文槽常是错填）。接多语言/翻译类触摸屏任务时加载。',
    file: 'fstudio-i18n-workflow.md',
  },
  {
    name: 'wincc-text-i18n-workflow',
    description: '西门子 WinCC flexible/SMART 项目文本（Screens/Others/Messages 三件套 xls）翻译流程：格式契约（第 1 列是匹配键、换行是真换行、$_ignore 不许动）、分型判据、错译串位的识别、一源一译、术语表与出 .xls 的写法。接「触摸屏项目文本翻译/英文没填/导回英文」类任务时加载。',
    file: 'wincc-text-i18n-workflow.md',
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
  // ── 工具一：触摸屏工程统一入口（.hmismart 解码 / FStudio 文本扫描）──
  ctx.tools.register({
    name: 'hmi-decode',
    description: '触摸屏/组态（HMI）工程统一入口：.hmismart（西门子 WinCC flexible SMART）→ 画面/变量/连接；.fsprj 或含 HMI\\Frame 的 FStudio 工程目录 → 扫元件文本；.nbp（欧姆龙 NB-Designer，XML）→ 画面/控件/地址；.mcp / .mcgs（MCGS·LSTP Studio，Access 库）→ 画面/变量/报警/策略。用户提供触摸屏或组态工程文件、要求读取/理解/核对其内容时调用。只读，不改动工程文件。PLC 工程请用 plc-decode。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '触摸屏工程：.hmismart 路径，或 .fsprj / FStudio 工程目录（含 HMI\\Frame 的那一层）。' },
        outDir: { type: 'string', description: '可选：输出目录；缺省 .hmismart 写工作区「解码归档\\<工程文件名>\\HMI解码\\」，FStudio 写 <工程目录>\\多语言产出\\。' },
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
      const tables = await decodeFstudio(ctx, project, outDir, exec)
      const scan = await scanFstudio(ctx, project, undefined, exec)
      return {
        ok: true,
        text: `FStudio 工程（类型: fstudio / Flexem FStudio）:\n${tables.text}\n产物目录: ${tables.target}\n${scan}\n下一步: 要出对照表与可导入文本库的表，用工具 fstudio-i18n。`,
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

  // ── 工具三：FStudio 只扫元件文本，先看清要翻什么 ──
  ctx.tools.register({
    name: 'fstudio-scan-texts',
    description: '扫描 FStudio/Flexem 工程里全部静态文本元件的文字（按语种分槽）：每个元件的各语种槽内容、以及文本库现状，出明细 JSON。用于「先看清有哪些文字要翻、哪些没进库」。只读。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'FStudio 工程：.fsprj 路径或工程目录。' },
        outDir: { type: 'string', description: '可选：输出目录；缺省写 <工程目录>\\多语言产出\\。' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const file = typeof args.file === 'string' ? args.file.trim() : ''
      if (!file) throw new Error('参数 file 不能为空')
      if (!existsSync(resolve(file))) throw new Error(`路径不存在: ${file}`)
      const outDir = typeof args.outDir === 'string' && args.outDir.trim() ? resolve(args.outDir.trim()) : undefined
      return { ok: true, text: await scanFstudio(ctx, file, outDir, exec) }
    },
  })

  // ── 工具四：FStudio 多语言一步到位，出对照表 + 可导入表 ──
  ctx.tools.register({
    name: 'fstudio-i18n',
    description: 'FStudio/Flexem 触摸屏多语言：扫工程里全部静态文本元件（按语种分槽的中/英/韩等文字），出多语言对照表与可直接导入 FStudio 文本库的表（列名与软件导出的 TextLib 表一致）。用户说「触摸屏多语言/翻译」「文本库没翻译」「画面文字切语种不变」「元件文本入库」时调用。只读工程，产物写输出目录。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'FStudio 工程：.fsprj 路径，或工程目录（含 HMI\\Frame 的那一层）。' },
        outDir: { type: 'string', description: '可选：输出目录；缺省写 <工程目录>\\多语言产出\\。' },
        dict: { type: 'string', description: '可选：词典文件（.py 含 ELEMENT_EN/LONG_EN、ELEMENT_PT/LONG_PT 或 ELEMENT_KO/LONG_KO，或 .json 平表 / {"en":{…},"pt":{…}}），给中文配译文。' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const file = typeof args.file === 'string' ? args.file.trim() : ''
      if (!file) throw new Error('参数 file 不能为空')
      if (!existsSync(resolve(file))) throw new Error(`路径不存在: ${file}`)
      const outDir = typeof args.outDir === 'string' && args.outDir.trim() ? resolve(args.outDir.trim()) : undefined
      const dict = typeof args.dict === 'string' && args.dict.trim() ? args.dict.trim() : ''
      return { ok: true, text: await makeFstudio(ctx, file, outDir, dict, exec) }
    },
  })

  // ── 工具五：已导出的文本库表换语种列（第三语种整列换掉）──
  ctx.tools.register({
    name: 'fstudio-retag',
    description: '把 FStudio 已导出的文本库表（TextLib 表：Guid/Name/Status/各语种列）整列换语种：第三语种列（如韩语）换成词典给的目标语种（巴葡 pt / 葡葡 pt-pt / 俄 ru / 西 es …），中英文列、行序、Guid、Status 原样保留，出可直接导回文本库的表。用户说「这个导出的文本库表把韩语去掉换成葡萄牙语」「文本库表换语种/加语种」时调用。只读源表。',
    parameters: {
      type: 'object',
      properties: {
        src: { type: 'string', description: 'FStudio 导出的文本库表：.xls 或 .xlsx（含 Guid/Name/Status 列）。' },
        dict: { type: 'string', description: '词典：.json（{"pt": {"中文":"译文"}} 或平表 {"中文":"译文"}）或 .py（ELEMENT_PT = {…}）。' },
        out: { type: 'string', description: '可选：输出 xlsx 路径；缺省写源表同目录「文本库导入表_<语种>.xlsx」。' },
        lang: { type: 'string', description: '可选：语种键 pt(巴西葡语)/pt-pt(葡萄牙葡语)/ko/ru/es/vi/th/ar；缺省按词典里有的语种自动取。' },
        minStatus: { type: 'number', description: '可选：把状态数不足的条目补到这个状态数（如 2）。新增状态行 Guid 留空、Status 递增、文字与首行相同——屏上开关/指示灯是双状态元件，库里条目只有一个状态时状态 1 会显示空白。' },
      },
      required: ['src', 'dict'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const src = typeof args.src === 'string' ? args.src.trim() : ''
      if (!src) throw new Error('参数 src 不能为空')
      const dict = typeof args.dict === 'string' ? args.dict.trim() : ''
      const out = typeof args.out === 'string' && args.out.trim() ? args.out.trim() : ''
      const lang = typeof args.lang === 'string' && args.lang.trim() ? args.lang.trim() : ''
      const minStatus = typeof args.minStatus === 'number' ? args.minStatus : 0
      return { ok: true, text: await retagFstudio(ctx, src, out, dict, lang, minStatus, exec) }
    },
  })

  // ── 工具六：WinCC flexible 项目文本导出表多语言（Screens/Others/Messages 三件套）──
  ctx.tools.register({
    name: 'wincc-text-i18n',
    description: 'WinCC flexible/SMART 项目文本导出表（Screens.xls / Others.xls / Messages.xls 三件套）多语言处理：scan 分型出待译清单（未译/空译/$_ignore/非中文同形，并标出一源多译）、apply 按「中文原文→译文」映射回写目标语言列并出同扩展名 .xls、check 自检（键列未动、无未译、无残留 $_ignore、无串位、无一源多译）。用户说「触摸屏翻译/项目文本翻译/英文没填/导回英文」时调用。产物写回源表同路径同名覆盖（改前备份原件）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['scan', 'apply', 'check'], description: 'scan＝分型出清单；apply＝按映射回写；check＝自检产物。' },
        files: { type: 'array', items: { type: 'string' }, description: 'scan/apply 用：项目文本导出表路径（.xls 或 .xlsx），可多个。' },
        dict: { type: 'string', description: 'apply 用：映射文件（.tsv 两列「源文本<TAB>译文」，或 .json 平表）；换行在映射里写 \\n。' },
        outdir: { type: 'string', description: '可选：输出目录；缺省写会话工作区「翻译_项目文本\\」。' },
        src: { type: 'string', description: 'check 用：原始导出表路径。' },
        out: { type: 'string', description: 'check 用：回写后的产物路径。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const action = String(args.action || 'scan').trim()
      const files = Array.isArray(args.files) ? args.files.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : []
      const base = sessionBase(exec?.agent)
      const outdir = typeof args.outdir === 'string' && args.outdir.trim()
        ? resolve(args.outdir.trim())
        : join(base, '翻译_项目文本')
      if (action === 'scan' || action === 'apply') {
        if (files.length === 0) throw new Error('scan/apply 需要 files（项目文本导出表路径）')
        for (const f of files) if (!existsSync(resolve(f))) throw new Error(`文件不存在: ${f}`)
        if (action === 'scan') {
          return { ok: true, text: await runPyScript(ctx, SCRIPT_WINCC, ['scan', '--files', ...files.map(f => resolve(f)), '--outdir', outdir], base, exec?.signal, exec) }
        }
        const dict = typeof args.dict === 'string' && args.dict.trim() ? resolve(args.dict.trim()) : ''
        if (!dict) throw new Error('apply 需要 dict（映射文件 .tsv/.json）')
        if (!existsSync(dict)) throw new Error(`映射文件不存在: ${dict}`)
        return { ok: true, text: await runPyScript(ctx, SCRIPT_WINCC, ['apply', '--files', ...files.map(f => resolve(f)), '--dict', dict, '--outdir', outdir], base, exec?.signal, exec) }
      }
      if (action === 'check') {
        const src = typeof args.src === 'string' && args.src.trim() ? resolve(args.src.trim()) : ''
        const out = typeof args.out === 'string' && args.out.trim() ? resolve(args.out.trim()) : ''
        if (!src || !out) throw new Error('check 需要 src 与 out')
        if (!existsSync(src)) throw new Error(`文件不存在: ${src}`)
        if (!existsSync(out)) throw new Error(`文件不存在: ${out}`)
        return { ok: true, text: await runPyScript(ctx, SCRIPT_WINCC, ['check', '--src', src, '--out', out, '--outdir', outdir], base, exec?.signal, exec) }
      }
      throw new Error(`未知 action: ${action}（可用 scan / apply / check）`)
    },
  })

  // ── 命令一：触摸屏工程入口 ──
  ctx.commands.register({
    name: 'hmi-decode',
    description: '触摸屏工程入口：.hmismart 解码（画面/变量/连接）/ FStudio 工程文本扫描',
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
        const text = await scanFstudio(ctx, project, outDir, { agent })
        return { kind: 'success', text }
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

  // ── 技能（两篇资产）──
  ctx.commands.register({
    name: 'fstudio-retag',
    description: '把 FStudio 导出的文本库表整列换语种（如去掉韩语换成葡萄牙语），可顺带补足状态行',
    input: { hint: '<导出的TextLib表> <词典.json> [输出.xlsx] [语种键 pt/pt-pt/ko/ru] [最少状态数 如2]' },
    handler: async ({ rawInput, agent }) => {
      try {
        const parts = splitArgs(rawInput)
        if (parts.length < 2) {
          return ({ kind: 'error', text: '用法: /fstudio-retag <导出的TextLib表.xls> <词典.json> [输出.xlsx] [语种键] [最少状态数]（带空格路径请加引号）' })
        }
        const minStatus = parts[4] && /^\d+$/.test(parts[4]) ? Number(parts[4]) : 0
        const text = await retagFstudio(ctx, parts[0], parts[2], parts[1], parts[3], minStatus, { agent })
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
