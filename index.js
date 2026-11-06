/**
 * PLC 工程文件解码插件（DeepSeek Harness / Cordis）
 *
 * 一个入口承载多品牌 PLC 工程文件的解码与分析：
 *   - `.project`（PK 头）→ CoDeSys / LeadSysStudio：read_project.py（ST 源码 + 报告 + 静态校验）
 *   - `.dvp`（57 01 01 00 头）→ 台达 WPLSoft / ISPSoft：dvp_decode.py（结构 / 注释 / 指令表）
 *   - `.smart`（SH3 头）→ 西门子 S7-200 SMART 工程：内嵌解码器（块 / 符号表 / 指令 + 操作数）
 *   - `.smartlib`（DEM 头）→ 西门子 SMART 库：内嵌解码器（库变量 + 注释流）
 *   - 新旧工程对比（.project 或已解码目录）→ 逻辑变化报告（区分真实变化与保存噪音）
 *
 * 实现策略：
 *   - codesys / dvp 用插件自带的 Python 脚本（assets/codesys-tools/），只依赖标准库
 *   - smart 用内嵌 Node 解码器：块级指令、操作数流、用户 + 系统符号表
 *   - 工程版本对比用纯函数 compareDecodedDirs
 *
 * 只读分析，不改动工程文件；解码产物默认写入工作区 `解码归档/<工程文件名>/`。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { writeSmartPack, writeSourcePack } from './assets/decode-pack.mjs'
import { registerHmi } from './hmi.js'

export const name = 'dsh-plc-decode'
export const inject = ['skills', 'tools', 'commands', 'shell', 'sandboxPolicy']

/** 报错尾行：插件出问题时，使用者第一眼看的就是错误文本。 */
const FEEDBACK_HINT = '遇到问题：加 QQ 号 2171960697，或开 Issue https://github.com/taoziliyouchong/dsh-plc-decode/issues'

/** 插件配置（DSH 官方 Config 机制：cordis.patch.yml 里本插件行的 config 传进 apply）。
 *  2026-11-05 加：让装插件的人不改代码就能换解码产物的存放位置。 */
export const Config = z.object({
  archiveDir: z.string().default('解码归档')
    .description('解码产物归档根目录。相对路径按当前会话工作区解析，绝对路径原样使用。默认「解码归档」。'),
})

/** 生效中的归档根目录；apply 时由 config.archiveDir 覆盖，未配置即默认值（与旧版行为一致）。 */
let ARCHIVE_ROOT = '解码归档'

/** 归档根目录的绝对路径：绝对路径原样用，相对路径拼会话工作区。 */
function archiveRootPath(base) {
  return isAbsolute(ARCHIVE_ROOT) ? ARCHIVE_ROOT : join(base || process.cwd(), ARCHIVE_ROOT)
}

const PY = 'python'
const TIMEOUT_MS = 300_000
/** 本插件自带的资源目录（smart 连线/网表脚本等） */
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'assets')
/** CoDeSys/DVP 解码用 Python 脚本：插件自带，只依赖标准库，不引用外部工程目录。 */
const CODESYS_TOOLS_DIR = join(ASSETS_DIR, 'codesys-tools')

// ───────────────────────── 通用工具 ─────────────────────────

const globalDecoder = new TextDecoder('gb18030')
function gbk(buf) {
  return globalDecoder.decode(buf)
}

function psq(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function timestamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 会话工作区根：优先 agent.session.header.cwd（本会话真正的工作区），取不到才回落进程 cwd。
 */
function sessionBase(agent) {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : process.cwd()
}

/** 解码产物默认归档目录：<工作区>\解码归档\<项目文件夹名>\
 *  用工程所在文件夹名建目录（不用工程文件名）：不同文件夹里的同名工程文件（如各自的同名 .dvp）不会互相覆盖；
 *  同一文件夹里有多个工程文件时用「文件夹名_文件名」区分。 */
function defaultArchiveDir(file, base) {
  const dir = dirname(file)
  const stem = basename(file, extname(file))
  const folder = basename(dir)
  let name = folder || stem
  try {
    const siblings = readdirSync(dir).filter((n) => /\.(smart|smartlib|dvp|project)$/i.test(n))
    if (siblings.length > 1) name = `${folder}_${stem}`
  } catch { /* 读不到目录就退回文件名 */ }
  return join(archiveRootPath(base), name)
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

/** 通过 ctx.shell 前台运行一个 Python 脚本（继承会话沙箱策略 + WinError 5 重试一次）。 */
async function runPy(ctx, script, args, workdir, signal, exec) {
  const cmd = `$env:PYTHONIOENCODING='utf-8'; & ${PY} ${psq(join(CODESYS_TOOLS_DIR, script))} ${args.map(psq).join(' ')}`
  const policy = ctx.sandboxPolicy && exec && exec.agent
    ? ctx.sandboxPolicy.resolve({ session: exec.agent.session })
    : undefined
  const spec = ctx.shell.resolve({
    command: cmd,
    workdir,
    timeoutMs: TIMEOUT_MS,
    ...policy ? { sandboxPolicy: policy } : {},
    ...signal ? { signal } : {},
  })
  let res = await shellResult(ctx, spec)
  if (res.exitCode !== 0 && /PermissionError|WinError 5|OSError/.test(`${res.stderr.text} ${res.stdout.text}`)) {
    res = await shellResult(ctx, spec)
  }
  const out = res.stdout.text.trim()
  const err = res.stderr.text.trim()
  if (res.exitCode !== 0) {
    const reason = err || out || '(无输出)'
    const detail = res.timedOut ? '（超时）' : res.aborted ? '（已中止）' : ''
    return { ok: false, text: `python 退出码 ${res.exitCode}${detail}\n${reason}` }
  }
  return { ok: true, text: out }
}

/** 识别工程类型（按文件头 4 字节） */
function identify(file) {
  const raw = readFileSync(file)
  const head = raw.subarray(0, 4)
  if (head.length === 4 && head[0] === 0x50 && head[1] === 0x4B && (head[2] === 0x03 || head[2] === 0x05) && head[3] === 0x04) {
    return { kind: 'project', raw }
  }
  if (head.length === 4 && head[0] === 0x57 && head[1] === 0x01 && head[2] === 0x01 && head[3] === 0x00) {
    return { kind: 'dvp', raw }
  }
  if (head.length === 4 && head[0] === 0x53 && head[1] === 0x48 && head[2] === 0x33 && head[3] === 0x00) {
    return { kind: 'smart', raw }
  }
  if (head.length === 4 && head[0] === 0x44 && head[1] === 0x45 && head[2] === 0x4D && head[3] === 0x00) {
    return { kind: 'smartlib', raw }
  }
  if (head.length === 4 && head[0] === 0x01 && head[1] === 0x0F && head[2] === 0x00 && head[3] === 0x00) {
    return { kind: 'hmismart', raw }
  }
  throw new Error(
    `不是可识别的 PLC 工程文件（前 4 字节: ${[...head].map(b => b.toString(16).padStart(2, '0')).join(' ')}）: ${file}\n`
    + '支持四种: .project（CoDeSys V3.5 ZIP 容器）/ .dvp（台达）/ .smart（西门子 SMART 工程）/ .smartlib（西门子库）。\n'
    + '触摸屏工程（.hmismart / .fsprj）不在本插件范围——请用 HMI 解码工具。'
  )
}

// ── HMI 触摸屏工程（.hmismart / .fsprj）不在本插件范围：本插件只处理 .project / .dvp / .smart / .smartlib。 ──

// ───────────────────────── CodeSys / 台达（Python 脚本） ─────────────────────────

/** 校验 .project/.dvp 工程文件（按文件头），返回 { abs, dir, kind }。 */
function requireProject(proj, usage) {
  if (!proj) throw new Error(usage)
  const abs = resolve(proj)
  if (!existsSync(abs)) throw new Error(`文件不存在: ${proj}`)
  const head = readFileSync(abs).subarray(0, 4)
  const isZip = head.length === 4 && head[0] === 0x50 && head[1] === 0x4B
    && (head[2] === 0x03 || head[2] === 0x05) && head[3] === 0x04
  const isDvp = head.length === 4 && head[0] === 0x57 && head[1] === 0x01
    && head[2] === 0x01 && head[3] === 0x00
  if (!isZip && !isDvp) {
    throw new Error(
      `不是可识别的 PLC 工程文件（前 4 字节: ${[...head].map(b => b.toString(16).padStart(2, '0')).join(' ')}）: ${proj}\n`
      + '支持两种: .project（CoDeSys V3.5 ZIP 容器，雷赛 LeadSys Studio 保存产生）；\n'
      + '         .dvp（台达 WPLSoft/ISPSoft 工程，57 01 01 00 头）。\n'
      + '提示: .i6x / .coppkg / .rar 等是 IDE 安装包或设备包，不是可解码的 PLC 工程。'
    )
  }
  return { abs, dir: dirname(abs), kind: isDvp ? 'dvp' : 'project' }
}

/** 校验 .dvp 文件（台达专用，带针对性提示）。 */
function requireDvp(dvp, usage) {
  if (!dvp) throw new Error(usage)
  const abs = resolve(dvp)
  if (!existsSync(abs)) throw new Error(`文件不存在: ${dvp}`)
  const head = readFileSync(abs).subarray(0, 4)
  const isDvp = head.length === 4 && head[0] === 0x57 && head[1] === 0x01
  if (!isDvp) {
    throw new Error(
      `不是有效的台达 DVP 工程文件（缺少 WPLSoft 特征头 57 01，前 4 字节: ${[...head].map(b => b.toString(16).padStart(2, '0')).join(' ')}）: ${dvp}\n`
      + '提示: 台达触摸屏工程 (.dpa/.dcf) 与 PLC 工程 (.dvp) 不同；.dvp 由 WPLSoft/ISPSoft 保存 PLC 程序产生。'
    )
  }
  return abs
}

/** 预建输出目录及其子目录（治 WinError 5：目录存在时 python makedirs exist_ok 不再报错）。
 *  2026-11-05：dvp 产物只有「解码报告.md」，不再为它建 extracted/、pous/ 两个空目录。 */
function precreateOutDir(outd, kind = 'project') {
  for (const sub of kind === 'dvp' ? [''] : ['', 'extracted', 'pous']) {
    try { mkdirSync(join(outd, sub), { recursive: true }) } catch { /* 留给 python */ }
  }
}

/** 解码 .project/.dvp 到统一归档 `<工作区>\解码归档\<工程文件名>\`（原默认写工程旁 `导出_<时间戳>`，与工作区归档规则冲突）；
 *  调用方给了 outDir 就用它。 */
async function decodeCodesysProject(ctx, projPath, signal, exec, outDir, base) {
  const { abs, dir, kind } = requireProject(projPath, '需要一个 .project / .dvp 工程文件路径（带空格请加引号）')
  const outd = outDir || defaultArchiveDir(abs, base)
  precreateOutDir(outd, kind)
  const result = kind === 'dvp'
    ? await runPy(ctx, 'dvp_decode.py', [abs, '-o', outd], dir, signal, exec)
    : await runPy(ctx, 'read_project.py', [abs, outd], dir, signal, exec)
  // 加密 .project（不是 zip，整文件高熵）：read_project.py 报 BadZipFile。
  // 强硬解码通道：同目录常有 <工程>.precompilecache（zip），里面有全部标识符与中文名，
  // 抽出来至少能回答「有哪些变量/功能点」，并明确告诉调用方逻辑读不到。
  let degraded = false
  let out = result
  if (!out.ok && kind === 'project') {
    const fb = await runPy(ctx, 'precompile_extract.py', [abs, outd], dir, signal, exec)
    if (fb.ok) { out = fb; degraded = true }
    else throw new Error(`${out.text}\n\n（已尝试加密工程降级通道，也失败）\n${fb.text}`)
  }
  if (!out.ok) throw new Error(out.text)
  // 导航件：人看 ST（pous/）或指令表报告，AI 先读本页；失败不影响解码结果
  let packNote = ''
  if (!degraded) {
    try {
      const pk = writeSourcePack({ outd, kind, projName: basename(abs), projFile: abs })
      packNote = `索引: ${join(outd, '00-索引.md')}${pk.pous ? `（POU/对象 ${pk.pous} 个）` : ''}\n`
    } catch { /* 忽略 */ }
  }
  const tail = degraded
    ? '\n⚠ 该工程是加密保存（不是 zip）：只解出符号名与中文名，读不到逻辑与梯形图。要逻辑请让原作者在软件里「另存为非加密工程」或导出 ST。'
    : ''
  return { outd, kind: degraded ? 'project-加密降级' : kind, text: packNote + out.text + tail }
}

/** 解码 .dvp 为文本直出（stdout 报告，不落盘；delta-dvp-read 工具/命令形态）。 */
async function decodeDvpText(ctx, dvpPath, signal, exec) {
  const abs = requireDvp(dvpPath, '需要一个 .dvp 工程文件路径（带空格请加引号）')
  const dir = dirname(abs)
  const result = await runPy(ctx, 'dvp_decode.py', [abs], dir, signal, exec)
  if (!result.ok) throw new Error(result.text)
  return { abs, dir, text: result.text }
}

// ───────────────────────── SMART（内嵌增强版解码器） ─────────────────────────

/** 常见块名白名单：补足短名与拉丁字母开头的块名（0x0D 名记录扫描时放宽用，可自行增补）。 */
const KNOWN_BLOCKS = ['主程序', '初始化', '手动', '自动', '报警', '输出', 'S_ITR']
// 库块/用户库块名（0D00 记录但无标准指令盒头，需强行解码）
const LIB_BLOCKS = ['MBUS_CTRL', 'MBUS_MSG', 'MBUSM1', 'MBUSM2', 'INT_0']

/** 解容器：SH3（工程）或 DEM（库）→ zlib 流 → 内部文档 Buffer */
function decodeContainer(raw) {
  const magic = raw.subarray(0, 4).toString('ascii')
  if (magic === 'SH3\x00' || raw[0] === 0x53) {
    const want = raw.readUInt32LE(0x6C)
    const body = inflateSync(raw.subarray(0x70))
    return { kind: 'project', version: raw.subarray(4, 16).toString('ascii').replace(/\0/g, ''), want, data: body }
  }
  if (magic === 'DEM\x00' || raw[0] === 0x44) {
    const want = raw.readUInt32LE(0x40)
    const body = inflateSync(raw.subarray(0x44))
    return { kind: 'library', version: raw.subarray(4, 16).toString('ascii').replace(/\0/g, ''), want, data: body }
  }
  throw new Error(`不是可识别的 SMART 文件（magic: ${magic}），支持 .smart（SH3 头）/ .smartlib（DEM 头）`)
}

/** 提取所有可读串（GBK 中文 + ASCII） */
function extractTexts(data) {
  const out = []
  const len = data.length
  for (let i = 0; i < len - 1;) {
    const b = data[i]
    if (b >= 0x81 && b <= 0xFE && data[i + 1] >= 0x40 && data[i + 1] <= 0xFE) {
      let j = i
      while (j < len - 1) {
        const a = data[j]
        if (a >= 0x81 && a <= 0xFE && data[j + 1] >= 0x40 && data[j + 1] <= 0xFE) j += 2
        else if (a >= 0x20 && a < 0x7F) j += 1
        else break
      }
      if (j - i >= 3) out.push({ off: i, text: gbk(data.subarray(i, j)) })
      i = j + 1
    } else if (b >= 0x20 && b < 0x7F) {
      let j = i
      while (j < len && data[j] >= 0x20 && data[j] < 0x7F) j += 1
      if (j - i >= 3) out.push({ off: i, text: data.subarray(i, j).toString('ascii') })
      i = j
    } else {
      i += 1
    }
  }
  return out
}

/** POU 块清单（tag 0x0D 名记录）：项目树块 + 库块 + 任意中文名块 */
function findPous(data) {
  const marks = []
  for (let i = 0; i < data.length - 6;) {
    if (data[i] === 0x0D && data[i + 1] === 0x00) {
      const ln = data[i + 2] | (data[i + 3] << 8)
      if (ln > 0 && ln < 40 && i + 4 + ln <= data.length) {
        const nm = gbk(data.subarray(i + 4, i + 4 + ln)).trim()
        if (KNOWN_BLOCKS.includes(nm) || LIB_BLOCKS.includes(nm) || /^[\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9_]{1,39}$/.test(nm)) {
          marks.push({ off: i, name: nm })
        }
        i += 4 + ln
        continue
      }
    }
    i += 1
  }
  return marks
}

const INST_RE = /^(MOV_W|MOV_B|MOV_DW|MUL_I|MUL_DI|INC_W|INC_DW|ADD_I|ADD_DI|SUB_I|SUB_DI|DIV_I|DIV_DI|WAND_DW|WOR_DW|WXOR_DW|SHL_DW|SHR_DW|BCD_I|I_BCD|S_ITR|INT_0|MBUS_CTRL|MBUS_MSG|READ_RTC|SET_RTC|HSC0_|HSC2_|B_I|I_B|NET_EXE|PID_EXE|TON|TOF|TONR|CTU|CTD|CTUD|ENI|DISI|HSC|BCD|LPS|LRD|LPP|SCRT|XMT|RCV|ATCH|DTCH|DIV|MOD|ABS|NEG|SWAP|FILL|ROTL|ROTR)$/

/** 指令盒头：01 01 00 00 00 <序号 00-0F ×1-2> 03 01
 *  全文件验证：序号字节不限于 02/05/06（旧版只认 02/05/06 03 01，漏掉约 85% 盒头，
 *  导致"一条记录带 30+ 操作数"的盒子流未切分）。
 *  注意：子记录/元数据块同样以 01 01 00 00 00 开头（如 01 03 01 01 02 00 00 00 01 03 01），
 *  必须校验"最小信号"——头后 48B 内出现引脚名 ASCII（IN/OUT/EN/指令名…）或操作数对，否则为元数据假头。 */
function findHeads(data) {
  const heads = []
  for (let i = 0; i < data.length - 12;) {
    if (data[i] === 0x01 && data[i + 1] === 0x01 && data[i + 2] === 0x00 && data[i + 3] === 0x00 && data[i + 4] === 0x00) {
      const b6 = data[i + 5]
      const tail = (b6 <= 0x0F && data[i + 6] === 0x03 && data[i + 7] === 0x01)
        || (b6 <= 0x0F && data[i + 6] <= 0x0F && data[i + 7] === 0x03 && data[i + 8] === 0x01)
      if (tail) {
        const body = data.subarray(i + 5, Math.min(i + 48, data.length))
        const hasAscii = /[\x20-\x7e]{2,}/.test(body.toString('binary'))
        let hasOp = false
        for (let j = 0; j + 4 <= body.length - 7; j++) {
          if (body[j] === 0x02 && body[j + 1] === 0x00 && [0x01, 0x02, 0x04, 0x08].includes(body[j + 2])) { hasOp = true; break }
        }
        // 网络行元数据盒：操作数计数以 "<count> 00 00 03/04" 编码（如 19 00 00 03、20 00 00 04），无 02 00 对
        const hasMeta = /.{2}[\x00-\x7f]?[\x00-\x7f]?[\x00-\x7f]?\x00\x00\x0?[34]/.test(body.toString('binary'))
        if (hasAscii || hasOp || hasMeta) { heads.push(i); i += 1; continue }
      }
    }
    i += 1
  }
  return heads
}

/** 非指令名（引脚/元数据名/噪声），findName 的 ASCII 泛匹配须排除，否则 IN1/OUT/EN/ENO 被当指令名 */
const NAME_BLACKLIST = new Set(['IN1', 'IN2', 'IN3', 'IN4', 'OUT', 'OUT1', 'OUT2', 'EN', 'ENO', 'IN', 'NOP', 'LD', 'END'])

function findName(data, off, nxt) {
  const seg = data.subarray(off, Math.min(nxt, off + 160))
  // 子程序调用盒内嵌被调块名（`E9 03 <xx> 01 00 02 09 03 00 <GBK名>` 已按字节验证：常见中文块名均命中）
  const ci = seg.indexOf(0xE9)
  if (ci >= 0 && ci + 9 < seg.length && seg[ci + 1] === 0x03 && seg[ci + 3] === 0x01
    && seg[ci + 4] === 0x00 && seg[ci + 5] === 0x02 && seg[ci + 6] === 0x09 && seg[ci + 7] === 0x03 && seg[ci + 8] === 0x00) {
    let e = ci + 9
    let cnt = 0
    while (e < seg.length && seg[e] !== 0 && cnt < 30) { e++; cnt++ }
    const nm = gbk(seg.subarray(ci + 9, e)).trim()
    if (nm && (KNOWN_BLOCKS.includes(nm) || LIB_BLOCKS.includes(nm) || /^[\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9_]{0,39}$/.test(nm))) return nm
  }
  const m = /([A-Z][A-Z0-9_]{2,20})\x00/.exec(seg.toString('binary'))
  if (m && INST_RE.test(m[1])) return m[1]
  // 兜底：文本段里的中文标识符（2–20 字），按出现顺序取第一个
  const cm = /[\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9_]{1,19}/.exec(gbk(seg.subarray(0, 80)))
  if (cm) return cm[0]
  return '?'
}

// 区域码 0x80 = 计数器 C（编号存在 addr 字段）。旧注 '库内部' 是误读（判据见下条）：
// ① CTU 盒的"计数器号"槽里出现 0x80+编号（计数器只能落 C 区）；② 子程序 BOOL 输出参数可绑 0x80+编号 = 用户可选地址；
// ③ 库存储区引用验证在 V 区（.smartlib 内部变量也是 V/L 区）。
const AREA = {
  0x001: 'I', 0x002: 'Q', 0x010: 'V', 0x020: 'M', 0x040: 'T',
  0x200: 'SM', 0x2000: 'L', 0x080: 'C', 0x103: '未连接',
}

function fmtOperand(type, area, val) {
  if (area === 0x103) return '未连接'
  const a = AREA[area] ?? `?0x${area.toString(16)}`
  if (type === 0x01) { // bit
    if (a === 'T') return `T${val}`
    if (a === 'V') return `V${val >> 3}.${val & 7}` // V 区位布尔
    if (['I', 'Q', 'M', 'SM'].includes(a)) return `${a}${val >> 3}.${val & 7}`
    if (a === 'L') return `L${val >> 3}.${val & 7}`
    if (a === 'C') return `C${val}`
    return `?(${a},${val})`
  }
  const suf = { 0x02: 'B', 0x04: 'W', 0x08: 'D' }[type] ?? '?'
  if (a === 'V') return `V${suf}${val}`
  if (a === 'SM') return `SM${suf}${val}`
  if (a === 'L') return `L${suf}${val}`
  if (a === 'C') return `C${suf}${val}`
  return `?t${type}(${a},${val})`
}

/** 指令实例操作数（02 00 type area addr 11B 对） */
function extractOperands(data, a, b) {
  const out = []
  for (let s = a; s < b - 12;) {
    const j = data.indexOf(0x02, s)
    if (j < 0 || j + 11 > b) break
    if (data[j + 1] !== 0x00) { s = j + 1; continue }
    const t = data[j + 2]
    if ([0x01, 0x02, 0x04, 0x08].includes(t) && j + 11 <= b) {
      const area = data.readUInt32LE(j + 3)
      const val = data.readUInt32LE(j + 7)
      if (AREA[area] !== undefined) {
        out.push(fmtOperand(t, area, val))
        s = j + 3
        continue
      }
    }
    s = j + 1
  }
  return out
}

/** 符号表（用户 + 系统）行：02 00 <len> <名> 00 01 02 00 01 <d1> <d2> */
function findSymbols(data, start, end, areaMap, smByteMode) {
  const rows = []
  for (let i = start; i < end - 8;) {
    if (data[i] === 0x02 && data[i + 1] === 0x00) {
      const ln = data[i + 2] | (data[i + 3] << 8)
      if (ln > 0 && ln < 60 && i + 4 + ln + 12 <= end) {
        const nb = data.subarray(i + 4, i + 4 + ln)
        if ([...nb].every(b => b === 0 || (b >= 0x20 && b < 0x7F) || b >= 0x81)) {
          const nm = gbk(nb)
          let j = i + 4 + ln
          if (data[j] === 0) j += 1
          if (data[j] === 0x01 && data[j + 1] === 0x02 && data[j + 2] === 0x00 && data[j + 3] === 0x01) {
            const d1 = data.readUInt32LE(j + 4)
            const d2 = data.readUInt32LE(j + 8)
            if (areaMap[d1] !== undefined) {
              const a = areaMap[d1]
              if (smByteMode) {
                rows.push({ name: nm, addr: d2 < 16 ? `SM0.${d2}` : `SMB${Math.floor(d2 / 8)}.${d2 % 8}` })
              } else {
                rows.push({ name: nm, addr: a === 'T' ? `T${d2}` : `${a}${d2 >> 3}.${d2 & 7}` })
              }
              i = j + 12
              continue
            }
          }
        }
      }
    }
    i += 1
  }
  return rows
}

/** V 区（用户变量）符号行：`02 00 <len:2> <名> 00 01 02 00 <type> <area:4> <addr:4>`
 *  二进制验证：type=1 bit(→Vx.y)/2 B/4 W/8 D；area=0x10 为 V 区。
 *  速比类变量（中文命名的 速比 / 实际速度 / 最高速度 等）只有这种行格式，findSymbols 的 M/I/Q 行不覆盖。 */
function findVSymbols(data, start, end) {
  const rows = []
  for (let i = start; i < end - 24;) {
    if (data[i] === 0x02 && data[i + 1] === 0x00) {
      const ln = data.readUInt16LE(i + 2)
      if (ln > 0 && ln < 40 && data[i + 4 + ln] === 0 && data[i + 5 + ln] === 0x01 && data[i + 6 + ln] === 0x02 && data[i + 7 + ln] === 0x00) {
        const t = data[i + 8 + ln]
        if ([1, 2, 4, 8].includes(t)) {
          const area = data.readUInt32LE(i + 9 + ln)
          const val = data.readUInt32LE(i + 13 + ln)
          if (area === 0x010) {
            const nm = gbk(data.subarray(i + 4, i + 4 + ln)).trim()
            rows.push({ name: nm, addr: t === 1 ? `V${val >> 3}.${val & 7}` : `V${({ 2: 'B', 4: 'W', 8: 'D' })[t]}${val}` })
            i = i + 17 + ln
            continue
          }
        }
      }
    }
    i += 1
  }
  return rows
}

/** 未接线变量扫描：有符号名、但程序区 0 次引用的变量。
 *  回答"XX 功能为什么没生效/屏上显示不变"类问题的第一嫌疑就是它——变量表里有名字，程序里根本没有操作数引用
 *  （典型形态：调好的系数/补偿值在符号表里有名，程序里 0 引用）。
 *  判定：字节级精确匹配操作数编码 `02 00 <type> <area:4LE> <addr:4LE>`，只在程序区（符号表区之前）计数。
 *  ⚠️ 符号表条目尾部本身就是同一段字节串（名字行 `... 00 01 02 00 08 10 00 00 00 <addr> ...`），
 *  必须排除符号表区，否则每个变量都会误报"已引用"。 */
function scanVarRefs(data, symStart, symEnd, userSyms) {
  const AREA = { I: 0x001, Q: 0x002, M: 0x020, T: 0x040, SM: 0x200, V: 0x010 }
  const out = []
  for (const s of userSyms) {
    const m = /^(SM|V|M|I|Q|T)(B|W|D)?(\d+)(?:\.(\d))?$/.exec(String(s.addr ?? '').trim())
    if (!m) continue
    const ab = m[1], sz = m[2], num = Number(m[3]), bit = m[4]
    const area = AREA[ab]
    if (area === undefined || !Number.isFinite(num)) continue
    let type, val
    if (ab === 'T') { type = 1; val = num } else if (bit !== undefined) { type = 1; val = num * 8 + Number(bit) } else if (sz === 'B') { type = 2; val = num } else if (sz === 'W') { type = 4; val = num } else if (sz === 'D') { type = 8; val = num } else continue
    let prog = 0
    // pat[1]：0x00 = 直接操作数、0x01 = 指针实参（&地址）。漏掉指针会把
    // 只被 DataPtr 这类参数用到的变量误报成「未接线」。
    for (const flag of [0x00, 0x01]) {
      const pat = Buffer.alloc(11)
      pat[0] = 0x02; pat[1] = flag; pat[2] = type
      pat.writeUInt32LE(area, 3); pat.writeUInt32LE(val, 7)
      let lo = 0
      while (true) {
        const i = data.indexOf(pat, lo)
        if (i < 0) break
        if (i < symStart) prog += 1
        lo = i + 1
      }
    }
    if (prog === 0) out.push({ addr: s.addr, name: s.name })
  }
  return out
}

/** 字节级操作数/常数定位：解"某变量到底接在哪个引脚""算出来的值有没有下游读者"这类解码报告答不了的问题。
 *  操作数编码 `02 00 <type> <area:4LE> <addr:4LE>` 在文档里按盒顺序排列；相邻操作数间隔 > 0x2D 即视为换了一条记录。
 *  判据：同一盒（同一条记录）内某地址出现 ≥2 次 = 它是该盒的 OUT（写）——3 引脚盒的 OUT 在两个「对」里各出现一次；
 *  只出现 1 次判"读?"（两引脚盒 MOV_W/INC_W 的 OUT 也只出现一次，需人工确认同记录最后一位）。
 *  常数形态 `01 02 <len 02|04> 01 <u32 值>`（比较阈值/赋值立即数）。 */
const PIN_AREA = { 0x001: 'I', 0x002: 'Q', 0x010: 'V', 0x020: 'M', 0x040: 'T', 0x080: 'C', 0x200: 'SM', 0x2000: 'L' }
const PIN_TYPE = { 0x01: 'bit', 0x02: 'byte', 0x04: 'word', 0x08: 'dword' }

function pinDecodeAt(doc, p) {
  if (doc[p] !== 0x02 || doc[p + 1] !== 0x00) return null
  const t = doc[p + 2]
  const area = doc.readUInt32LE(p + 3)
  const val = doc.readUInt32LE(p + 7)
  if (!PIN_TYPE[t] || PIN_AREA[area] === undefined) return null
  const a = PIN_AREA[area]
  let name
  if (t === 0x01) name = area === 0x040 ? `T${val}` : `${a}${val >> 3}.${val & 7}`
  else if (t === 0x02) name = `${a}B${val}`
  else if (t === 0x04) name = `${a}W${val}`
  else name = `${a}D${val}`
  return { off: p, type: t, area, addr: val, name }
}

/** 指针型实参解码：`02 01 <type> <area:4LE> <addr:4LE>` = 盒的指针参数（如 MBUS_MSG 的 DataPtr）。
 *  旧扫描只认 `02 00`（直接操作数），指针这一类被整批漏掉 —— 被 `&VB160` 点着的字节
 *  在体检报告里报成「0 引用／地址干净」，据此答"没人用"是错的。 */
function pinPtrDecodeAt(doc, p) {
  if (doc[p] !== 0x02 || doc[p + 1] !== 0x01) return null
  const t = doc[p + 2]
  const area = doc.readUInt32LE(p + 3)
  const val = doc.readUInt32LE(p + 7)
  if (!PIN_TYPE[t] || PIN_AREA[area] === undefined) return null
  const a = PIN_AREA[area]
  const name = t === 0x01 ? (area === 0x040 ? `&T${val}` : `&${a}${val >> 3}.${val & 7}`)
    : t === 0x02 ? `&${a}B${val}` : t === 0x04 ? `&${a}W${val}` : `&${a}D${val}`
  const bytes = t === 0x08 ? 4 : t === 0x04 ? 2 : 1
  return { off: p, type: t, area, aName: a, addr: val, bytes, name }
}

/** 全文指针实参（含所属库调用盒；MBUS_MSG 的 DataPtr 按 Count 扩成缓冲区字节数）。
 *  返回 [{off, name, addr, bytes, aName, box}] —— 供体检／空闲段／字节级定位共用。 */
function scanPtrRefs(doc) {
  const out = []
  for (let p = 0; p < doc.length - 11; p++) {
    const r = pinPtrDecodeAt(doc, p)
    if (!r) continue
    out.push(r)
    p += 10
  }
  for (const r of out) {
    for (let i = r.off; i > Math.max(0, r.off - 0x400); i--) {
      if (doc[i] !== 0xE9 || doc[i + 1] !== 0x03) continue
      const nm = boxCallNameAt(doc, i)
      if (!nm) continue
      r.box = { off: i, name: nm }
      break
    }
    if (r.box && r.box.name === 'MBUS_MSG') {
      const lo = Math.max(0, r.off - 0x200)
      for (const a of scanBoxArgs(doc, lo, Math.min(doc.length, r.off + 0x200))) {
        if (a.pin === 6 && /^\d+$/.test(a.text)) { r.bytes = Math.max(r.bytes, Number(a.text) * 2); r.count = Number(a.text); break }
      }
    }
  }
  return out
}

/** 常数记录（8 字节，两种编码）：`01 02 <len> 01 <u32>` 与库参数里的 `01 01 04 01 <u32>`。
 *  补充第二种——旧判据只认第一种，MBUS_CTRL 的 Baud、MBUS_MSG 的 Addr 这类 4xxxx／波特率常数
 *  在解码结果里整段看不到，只能回读字节。 */
function pinConstAt(doc, p) {
  if (doc[p] !== 0x01) return null
  const ok1 = doc[p + 1] === 0x02 && [0x01, 0x02, 0x04].includes(doc[p + 2]) && doc[p + 3] === 0x01
  const ok2 = doc[p + 1] === 0x01 && [0x01, 0x02, 0x04].includes(doc[p + 2]) && doc[p + 3] === 0x01
  if (!ok1 && !ok2) return null
  const v = doc.readUInt32LE(p + 4)
  return v >= 0 && v < 100000000 ? { v, size: 8 } : null
}

function pinRecords(doc, lo, hi) {
  const found = []
  for (let p = Math.max(0, lo | 0); p < Math.min(hi | 0, doc.length); p++) {
    const op = pinDecodeAt(doc, p)
    if (op) { found.push(op); p += 10; continue }
    const c = pinConstAt(doc, p)
    if (c !== null) { found.push({ off: p, name: `常数 ${c.v}` }); p += c.size - 1 }
  }
  const recs = []
  let cur = []
  for (const f of found) {
    cur.push(f)
    // 盒切分判据（字节验证）：操作数后缀是 `01 00 01 03 01` = 本盒还有下一个操作数；
    // 否则该操作数就是本盒末位（OUT 位）。常数的续接标记在其 8 字节体之后偏 9 位。
    const q = f.off + (String(f.name).startsWith('常数') ? 9 : 11)
    const cont = doc[q] === 0x01 && doc[q + 1] === 0x00 && doc[q + 2] === 0x01 && doc[q + 3] === 0x03 && doc[q + 4] === 0x01
    if (!cont) { recs.push(cur); cur = [] }
  }
  if (cur.length) recs.push(cur)
  return recs
}

function pinDumpAddr(doc, recs, target) {
  const m = /^(SM|V|M|I|Q|T)(B|W|D)?(\d+)(?:\.(\d))?$/.exec(String(target).toUpperCase())
  if (!m) throw new Error('地址形如 VW220 / VD390 / M30.0 / T33')
  const AREA = { I: 0x001, Q: 0x002, M: 0x020, T: 0x040, SM: 0x200, V: 0x010 }
  const area = AREA[m[1]]
  let type, val
  if (m[1] === 'T') { type = 0x01; val = Number(m[3]) }
  else if (m[4] !== undefined) { type = 0x01; val = Number(m[3]) * 8 + Number(m[4]) }
  else if (m[2] === 'B') { type = 0x02; val = Number(m[3]) }
  else if (m[2] === 'W') { type = 0x04; val = Number(m[3]) }
  else if (m[2] === 'D') { type = 0x08; val = Number(m[3]) }
  else throw new Error('地址要带类型，如 VW220 / VD390 / M30.0')
  const pat = Buffer.alloc(11)
  pat[0] = 0x02; pat[1] = 0x00; pat[2] = type
  pat.writeUInt32LE(area, 3); pat.writeUInt32LE(val, 7)
  const hits = []
  let i = 0
  while ((i = doc.indexOf(pat, i)) >= 0) { hits.push(i); i += 1 }
  // 注意：指针实参 `02 01` 是另一套编码，上面只数了直接操作数 ——
  // 漏掉它会把"被 &地址 点着的变量"报成"全文 0 处／没人用"（验证：MBUS_MSG 的 DataPtr=&VB160）。
  const ptrs = scanPtrRefs(doc).filter(r => r.type === type && r.area === area && r.addr === val)
  const L = []
  L.push(`## 字节级定位：${String(target).toUpperCase()} —— 直接操作数 ${hits.length} 处${ptrs.length ? `　+　指针引用 ${ptrs.length} 处` : ''}`)
  L.push('')
  if (!hits.length && !ptrs.length) { L.push('（全文没有该地址的操作数编码：不是程序里的操作数，可能只在符号表/屏侧使用）'); return L.join('\n') }
  if (hits.length) {
  const hitSet = new Set(hits)
  const owner = new Map()
  for (const r of recs) for (const f of r) if (hitSet.has(f.off)) owner.set(f.off, r)
  L.push('| 偏移 | 所在盒 | 盒内操作数序列 | 判定 |')
  L.push('|---|---|---|---|')
  for (const h of hits) {
    const r = owner.get(h)
    if (!r) { L.push(`| 0x${h.toString(16)} | 记录外（符号表/索引区） | — | 不作数 |`); continue }
    const idx = r.findIndex(f => f.off === h)
    const verdict = r.length === 1
      ? '单操作数盒（触点／引脚定义段）'
      : (idx === r.length - 1 ? '**写**（末位＝OUT）' : '读（前位＝IN）')
    L.push(`| 0x${h.toString(16)} | 0x${r[0].off.toString(16)}–0x${r[r.length - 1].off.toString(16)} | ${r.map(f => f.name).join(' \\| ')} | ${verdict} |`)
  }
  }
  if (ptrs.length) {
    L.push('### 指针引用（盒的指针型实参，不是直接操作数）')
    L.push('')
    L.push('| 偏移 | 所属盒 | 指针实参 | 覆盖字节 |')
    L.push('|---|---|---|---|')
    for (const r of ptrs) L.push(`| 0x${r.off.toString(16)} | ${r.box ? `${r.box.name}@0x${r.box.off.toString(16)}` : '（盒名未对上）'} | ${r.name} | ${r.addr}~${r.addr + r.bytes - 1}${r.count ? `（Count=${r.count}）` : '（下限）'} |`)
    L.push('')
    L.push('> 指针实参＝把这个地址交给盒用（如 MBUS_MSG 的 DataPtr＝&VB160）：盒读写从它起的缓冲区。**「直接操作数 0 处」不等于「没人用」** —— 判某地址有没有被用，要把指针一起算。')
    L.push('')
  }
  L.push('> 判据（字节验证）：盒内末位＝OUT（写）、前位＝IN（读）。')
  L.push('> 3 引脚盒（MUL/SUB/DIV）在字节里被拆成两个「对」，每对都是「IN … OUT」，所以同一个 OUT 会出现两次、都判写——这是对的。')
  L.push('> 只出现在「记录外」的引用不算程序引用（符号表/索引区里每个变量都会出现一次）。')
  L.push('> ⚠ **判读/写别信上表的「单操作数盒＝触点」**：线圈与 S/R 线圈同样是单操作数、且用符号名写的元素这里根本看不到。要判"某位到底有没有被写"请用 `smart-ladder-elements`（或 `/smart-ladder <工程.smart> <地址>`），本工具只用于引脚级归属与区间原文。')
  return L.join('\n')
}

function pinDumpRange(doc, from, to) {
  const recs = pinRecords(doc, from, to)
  const L = []
  L.push(`## 区间 0x${from.toString(16)}–0x${to.toString(16)}：${recs.length} 条记录`)
  L.push('')
  for (const r of recs) L.push(`- [0x${r[0].off.toString(16)}–0x${r[r.length - 1].off.toString(16)}] ${r.map(f => f.name).join(' | ')}`)
  if (!recs.length) L.push('- （该区间没有操作数/常数记录）')
  return L.join('\n')
}

// ── 库块引脚表────────────────────────────────────────────
// 注意：解码链的最后一层：此前产物给的是「盒内操作数序列」与「盒内引脚名」两段互不相干的文本，
// 实参挂到哪个引脚要靠人回读字节；这里把「实参 → 引脚名」直接落到结果里。
// 引脚名按 S7-200 SMART 标准库引脚顺序；空串 = 该序号验证未对上名字，输出回落成「引脚#N」。
const LIB_PINS = {
  MBUS_CTRL: ['EN', 'Mode', 'Baud', 'Parity', 'Port', 'Timeout', 'Done', 'Error'],
  MBUS_MSG: ['EN', 'First', 'Slave', 'RW', 'Addr', 'Count', 'DataPtr', 'Done', '', 'Error'],
  TON: ['EN', 'IN', 'PT', 'Q'], TOF: ['EN', 'IN', 'PT', 'Q'], TONR: ['EN', 'IN', 'PT', 'Q'],
  CTU: ['EN', 'CU', 'R', 'PV', 'Q'], CTD: ['EN', 'CD', 'LD', 'PV', 'Q'],
  MOV_B: ['EN', 'IN', 'OUT'], MOV_W: ['EN', 'IN', 'OUT'], MOV_DW: ['EN', 'IN', 'OUT'], MOV_R: ['EN', 'IN', 'OUT'],
  MUL_I: ['EN', 'IN1', 'IN2', 'OUT'], MUL_DI: ['EN', 'IN1', 'IN2', 'OUT'], MUL_R: ['EN', 'IN1', 'IN2', 'OUT'],
  ADD_I: ['EN', 'IN1', 'IN2', 'OUT'], SUB_I: ['EN', 'IN1', 'IN2', 'OUT'], DIV_I: ['EN', 'IN1', 'IN2', 'OUT'],
  INC_W: ['EN', 'IN', 'OUT'], DEC_W: ['EN', 'IN', 'OUT'], INC_DW: ['EN', 'IN', 'OUT'], DEC_DW: ['EN', 'IN', 'OUT'],
  SHL_DW: ['EN', 'IN', 'N', 'OUT'], SHR_DW: ['EN', 'IN', 'N', 'OUT'],
  WAND_DW: ['EN', 'IN1', 'IN2', 'OUT'], WOR_DW: ['EN', 'IN1', 'IN2', 'OUT'],
}

/** 库调用盒的块名：盒头后的 `E9 03 <xx> 01 00 02 00|09 03 00 <名>` */
function boxCallNameAt(data, i) {
  if (data[i] !== 0xE9 || data[i + 1] !== 0x03) return ''
  if (!(data[i + 3] === 1 && data[i + 4] === 0 && data[i + 5] === 2 && (data[i + 6] === 0 || data[i + 6] === 9) && data[i + 7] === 3 && data[i + 8] === 0)) return ''
  let e = i + 9
  while (e < data.length && data[e] !== 0 && e - i < 60) e++
  return gbk(data.subarray(i + 9, e)).trim()
}

/** 记录尾部的引脚序号：`<pin> 00 0x 03 01`（位/字/指针/常数）或 `01 <pin> 00 00 00 00 03 01`（字节操作数）。
 *  判据＝MBUS_CTRL／MBUS_MSG 七个实参记录验证；判不出返回 null（不猜）。 */
function pinSeqAfter(doc, from, lim) {
  const end = Math.min(lim, from + 40, doc.length - 2)
  for (let e = Math.max(1, from); e < end; e++) {
    if (doc[e] !== 0x03 || doc[e + 1] !== 0x01) continue
    if (doc[e - 1] === 0 && doc[e - 2] === 0 && doc[e - 3] === 0 && doc[e - 4] === 0) return doc[e - 5]
    return doc[e - 3]
  }
  return null
}

/** 区间内的实参（操作数 / 指针 `02 01` / 常数）＋各自引脚序号 */
function scanBoxArgs(data, a, b) {
  const out = []
  for (let p = a; p < b - 12; p++) {
    let text = null, size = 0
    if (data[p] === 0x02 && (data[p + 1] === 0x00 || data[p + 1] === 0x01)) {
      const t = data[p + 2], area = data.readUInt32LE(p + 3), v = data.readUInt32LE(p + 7)
      if ([0x01, 0x02, 0x04, 0x08].includes(t) && AREA[area] !== undefined) {
        text = (data[p + 1] === 0x01 ? '&' : '') + fmtOperand(t, area, v); size = 11
      }
    }
    if (text === null) {
      const c = pinConstAt(data, p)
      if (c) { text = String(c.v); size = c.size }
    }
    if (text === null) continue
    out.push({ off: p, text, pin: pinSeqAfter(data, p + size, Math.min(b, p + size + 40)) })
    p += size - 1
  }
  return out
}

/** 盒级引脚表：把一段里的库调用盒逐个列出「引脚名 = 实参」。同一引脚的定义段/实例段自动去重。 */
function boxPinout(data, from, to) {
  const calls = []
  for (let i = Math.max(0, from); i < Math.min(to, data.length) - 12; i++) {
    if (data[i] !== 0xE9 || data[i + 1] !== 0x03) continue
    const nm = boxCallNameAt(data, i)
    if (nm) calls.push({ off: i, name: nm })
  }
  const L = []
  L.push(`## 盒级引脚表 0x${from.toString(16)}–0x${to.toString(16)}：${calls.length} 个库调用盒`)
  L.push('')
  for (const c of calls) {
    const table = LIB_PINS[c.name]
    const seen = new Set()
    const rows = []
    for (const a of scanBoxArgs(data, Math.max(from, c.off - 0x300), Math.min(to, c.off + 0x300))) {
      if (a.pin === null || a.pin < 1 || seen.has(a.pin)) continue
      if (table && a.pin > table.length) continue
      if (/^L6[0-3]\./.test(a.text)) continue // 库调用的 EN/ENO 暂存位，不是用户实参
      seen.add(a.pin)
      rows.push(`    - ${table && table[a.pin - 1] ? table[a.pin - 1] : '引脚#' + a.pin} = ${a.text}`)
    }
    L.push(`- \`0x${c.off.toString(16).toUpperCase()}\` **${c.name}**${table ? '' : '（无内置引脚表 → 只给引脚序号）'}`)
    L.push(...(rows.length ? rows : ['    - （盒前后各 0x300 内没有带引脚序号的实参）']))
  }
  L.push('')
  L.push('> 引脚名按 S7-200 SMART 标准库引脚顺序；表里没有的序号给「引脚#N」。')
  return L.join('\n')
}

// 强行解码：块级操作数流 + 库块接口
const OPS_TYPES = { 0x01: 'X', 0x02: 'B', 0x04: 'W', 0x08: 'D' }

function extractOpsStream(data, a, b) {
  const out = []
  for (let s = a; s < b - 11;) {
    if (data[s] === 0x02 && data[s + 1] === 0x00 && OPS_TYPES[data[s + 2]]) {
      const area = data.readUInt32LE(s + 3)
      const val = data.readUInt32LE(s + 7)
      const f = fmtOperand(data[s + 2], area, val)
      if (f && f !== '未连接') { out.push(f); s += 3; continue }
    }
    s += 1
  }
  return out
}

/** 库块/用户库块接口变量名：模式 02 00 <len u8> <名> */
function findInterface(data, a, b) {
  const rows = []
  for (let s = a; s < b - 20;) {
    if (data[s] === 0x02 && data[s + 1] === 0x00) {
      const ln = data[s + 2]
      if (ln > 0 && ln <= 24 && s + 3 + ln <= b) {
        const nm = gbk(data.subarray(s + 3, s + 3 + ln))
        if (/^[\u4e00-\u9fa5A-Za-z_][\u4e00-\u9fa5A-Za-z0-9_]{0,23}$/.test(nm)) {
          rows.push({ off: s, name: nm })
          s += 3 + ln
          continue
        }
      }
    }
    s += 1
  }
  return rows
}

/** 符号表区起始（旧版工程 hardcode 约定），新版工程用动态探测兜底 */
const SYMS_START = 0x64600
const SYS_SYMS_START = 0x65E1E
const SYMS_END = 0x6AA50

/** 符号表行允许的 area（I/Q/V/M/T/SM），其余（库接口 0x7D0 等）不是符号表 */
const SYM_AREAS = new Set([0x01, 0x02, 0x10, 0x20, 0x40, 0x200])

/** 符号表区动态探测：V2.4+ 保存的 .smart 符号表偏移不再固定 0x64600，
 *  hardcode 越界/落空会让用户表与系统表全解空（验证偏移可达 0x49A85）。
 *  返回 {start, sysStart, end}；解不出（<2 行）返回 null 由调用方回退 hardcode。 */
function findSymRange(data) {
  const rows = []
  for (let i = 0; i < data.length - 8; i++) {
    if (data[i] === 0x02 && data[i + 1] === 0x00) {
      const ln = data[i + 2] | (data[i + 3] << 8)
      if (ln > 0 && ln < 60 && i + 4 + ln + 12 <= data.length) {
        let j = i + 4 + ln
        if (data[j] === 0) j += 1
        // type 段不限于位（0x01）：V 区字/双字符号（VW/VD）该字节为 0x04/0x08，结构同为
        // `01 02 00 <type> <area:4> <addr:4>`。原判据只认 0x01，会把符号表开头几条 V 区符号
        // 排除在探测之外 —— 起点被定到第一条「位」符号，前面的 VW/VD 符号（验证：画面跳转=VW2000）整条丢失。
        if (data[j] === 0x01 && data[j + 1] === 0x02 && data[j + 2] === 0x00 && [0x01, 0x02, 0x04, 0x08].includes(data[j + 3])) {
          const d1 = data.readUInt32LE(j + 4)
          if (SYM_AREAS.has(d1)) {
            rows.push({ off: i, d1 })
            i = j + 11
          }
        }
      }
    }
  }
  if (rows.length < 2) return null
  const sysRow = rows.find(r => r.d1 === 0x200)
  return { start: rows[0].off, sysStart: (sysRow ?? rows[rows.length - 1]).off, end: rows[rows.length - 1].off + 0x400 }
}

function decodeSmartFile(file, outDir, base) {
  const raw = readFileSync(file)
  const { kind, version, want, data } = decodeContainer(raw)
  const projName = gbk(data.subarray(0x30, 0x36)).replace(/\0/g, '')
  const innerVer = gbk(data.subarray(0x15, 0x2D)).split('\0')[0]
  const pou = findPous(data)
  const heads = findHeads(data)
  const records = []
  let lastNm = '?'
  for (let k = 0; k < heads.length; k++) {
    const off = heads[k]
    let nxt = heads[k + 1] ?? off + 0x1000
    for (const { off: poff } of pou) { if (poff > off) { nxt = Math.min(nxt, poff); break } }
    let nm = findName(data, off, nxt)
    // 接不到名字时沿用上一个名字（就近取名）——承来的名字加 ? 后缀标出"未必是这条指令"。
    // 曾出现测速段整段被标成 MUL_I（实为触点）的误读，标记后一眼可辨。
    if (nm !== '?') lastNm = nm
    else nm = lastNm === '?' ? '?' : `${lastNm}?`
    const ops = extractOperands(data, off, nxt)
    let pouName = '(文件头)'
    for (const { off: poff, name: pnm } of pou) {
      if (poff <= off) pouName = pnm
      else break
    }
    records.push({ off: `0x${off.toString(16).toUpperCase().padStart(6, '0')}`, pou: pouName, instr: nm, operands: ops })
  }
  // 符号表区定位：hardcode 范围能解出（旧版工程）则保持原行为；全空（新版工程）则动态探测
  let sym = { start: SYMS_START, sysStart: SYS_SYMS_START, end: SYMS_END }
  if (Math.min(SYMS_START, data.length) >= data.length || findSymbols(data, Math.min(SYMS_START, data.length), Math.min(SYMS_END, data.length), { 0x01: 'I', 0x02: 'Q', 0x20: 'M', 0x40: 'T', 0x200: 'SM' }, false).length === 0) {
    const dyn = findSymRange(data)
    if (dyn) sym = dyn
  }
  const blockStreams = []
  const blockIfaces = []
  for (let k = 0; k < pou.length; k++) {
    const a = pou[k].off
    const b = Math.min(k + 1 < pou.length ? pou[k + 1].off : data.length, sym.start)
    blockStreams.push({ name: pou[k].name, ops: extractOpsStream(data, a, b) })
    // 接口参数：parseIfaceParams 能解出 L 地址与类型（旧版用 findInterface，只取名字，导致
    // 子程序接口.tsv 的地址列写成 undefined、类型列全空）。解不出类型时才回退成纯名字表。
    const ifsTyped = parseIfaceParams(data, a, b).map(p => ({
      name: p.name,
      addr: fmtOperand(p.type, 0x2000, p.val),
      type: L_TYPE_NAME[p.type] ?? '',
    }))
    blockIfaces.push({
      name: pou[k].name,
      ifs: ifsTyped.length ? ifsTyped : findInterface(data, a, b).map(f => ({ name: f.name, addr: '', type: '' })),
    })
  }
  const userSyms = findSymbols(data, sym.start, sym.end, { 0x01: 'I', 0x02: 'Q', 0x20: 'M', 0x40: 'T', 0x200: 'SM' }, false)
  // 合并 V 区用户变量符号（如速比、实际速度这类中文命名变量），避免漏表
  for (const s of findVSymbols(data, sym.start, sym.end)) {
    if (!userSyms.some(u => u.addr === s.addr && u.name === s.name)) userSyms.push(s)
  }
  const sysSyms = findSymbols(data, sym.sysStart, sym.end, { 0x200: 'SM' }, true)
  // 未接线变量（供报告 2.7b 节）：有符号名但程序区 0 引用 —— "功能没接进程序"的第一判据
  const dangling = scanVarRefs(data, sym.start, sym.end, userSyms)

  const out = outDir ?? defaultArchiveDir(file, base)
  // 源文件指纹：报告是版本快照，工程一改偏移/操作数全变——写进报告与记录.json，用前可比对
  const st = statSync(file)
  const fingerprint = { file: basename(file), size: st.size, mtime: st.mtime.toISOString() }
  let staleWarn = ''
  {
    const prevJson = join(out, '记录.json')
    if (existsSync(prevJson)) {
      try {
        const prev = JSON.parse(readFileSync(prevJson, 'utf8')).fingerprint
        if (prev && (prev.size !== fingerprint.size || prev.mtime !== fingerprint.mtime)) {
          staleWarn = `⚠️ 源文件已变更：旧 ${prev.size} B / ${prev.mtime} → 新 ${fingerprint.size} B / ${fingerprint.mtime}；本目录原报告对应旧版本，已覆盖。`
        }
      } catch { /* 旧记录损坏，忽略 */ }
    }
  }
  mkdirSync(out, { recursive: true })
  // 网络行元数据（供解码报告 2.8 节）：行首 01 00 00 03 01，行内盒序列 01 01 00 00 00
  const netRows = []
  {
    let ni = 0
    while (ni < data.length - 5) {
      const p = data.indexOf(0x01, ni)
      if (p < 0 || p > data.length - 5) break
      if (data[p] === 0x01 && data[p + 1] === 0x00 && data[p + 2] === 0x00 && data[p + 3] === 0x03 && data[p + 4] === 0x01) {
        let q = p + 5
        let boxCnt = 0
        while (q < data.length - 4) {
          if (data[q] === 0x01 && data[q + 1] === 0x01 && data[q + 2] === 0x00 && data[q + 3] === 0x00 && data[q + 4] === 0x00) { boxCnt += 1; q += 5; continue }
          if (data[q] === 0x01 && data[q + 1] === 0x00 && data[q + 2] === 0x00 && data[q + 3] === 0x03 && data[q + 4] === 0x01) break
          q += 1
        }
        netRows.push({ off: p, boxes: boxCnt })
        ni = p + 5
      } else {
        ni += 1
      }
    }
  }
  // 符号属性/默认值表（供 2.9 节）：默认值 01 01 00 00 00 01 00 00 00 00 00 00 00 <val4>；属性（符号ID引用）01 01 02 00 00 00 01 03 01
  const symDefaults = []
  const symAttrs = []
  {
    const HEAD_DEFAULT = Buffer.from([0x01, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    const HEAD_ATTR = Buffer.from([0x01, 0x01, 0x02, 0x00, 0x00, 0x00, 0x01, 0x03, 0x01])
    let p = 0
    while (true) {
      const j = data.indexOf(HEAD_DEFAULT, p)
      if (j < 0) break
      symDefaults.push({ off: j, value: data.readUInt32LE(j + 13), idx: data[j + 22] })
      p = j + 1
    }
    p = 0
    while (true) {
      const j = data.indexOf(HEAD_ATTR, p)
      if (j < 0) break
      symAttrs.push({ off: j })
      p = j + 1
    }
  }
  const pouStructures = pou.map((p, k) => {
    const bEnd = k + 1 < pou.length ? pou[k + 1].off : data.length
    return { name: p.name, iface: parseIfaceParams(data, p.off, bEnd), calls: findCallSites(data, p.name, pou).length }
  })
  // 落盘形态：AI 件＋人看件分两路，同一批记录只落一处。
  // 仍写 解码报告.md 与 记录.json：前者现在是人看入口＋AI 索引，后者是兄弟工具（地址占用/变量使用）的输入与已解码目录的识别凭据。
  const reportText = buildSmReport(kind, version, want, projName, innerVer, pou, records, userSyms, sysSyms, blockStreams, blockIfaces, netRows, symDefaults, symAttrs, pouStructures, fingerprint, dangling)
  writeFileSync(join(out, '记录.json'), JSON.stringify({ project: projName, fingerprint, records, userSyms, sysSyms, blockStreams, blockIfaces }, null, 2), 'utf8')
  // 全文文本全录（GBK 中文 + ASCII，含注释/变量名/HMI 标签/系统说明）：支撑"程序里有没有 XX 内容/关键词"类查询
  const texts = extractTexts(data)
  writeFileSync(join(out, '字符串全录.txt'), texts.map(t => `0x${t.off.toString(16).padStart(6, '0')}\t${t.text}`).join('\n'), 'utf8')
  let pack = null
  try {
    pack = writeSmartPack({
      out, projName, fingerprint, reportText, smartPath: file,
      container: (reportText.match(/容器: (.+)/) || [])[1],
      version: innerVer,
      records, userSyms, sysSyms, blockStreams, blockIfaces,
      blockStats: pouStructures,
    })
  } catch (e) {
    // 打包失败不能让解码整个失败：退回旧报告，保证 解码报告.md/记录.json 这对识别凭据仍在
    writeFileSync(join(out, '解码报告.md'), reportText, 'utf8')
    pack = { fail: String(e.message) }
  }
  const byPou = {}
  for (const r of records) (byPou[r.pou] ??= []).push(r)
  const stats = Object.entries(byPou).map(([p, rs]) => `${p}(${rs.length})`).join(' ')
  return {
    proceed: `${staleWarn ? staleWarn + '\n' : ''}源文件指纹: ${fingerprint.size.toLocaleString()} B / ${fingerprint.mtime}\n`
      + `目录（AI 先读这一份；够用就别再读别的文件）: ${join(out, '00-目录.md')}\n`
      + `块统计: ${stats}\n`
      + `取数方法写在目录的「怎么查」一节（按地址/按块/按网络/按子程序取命中段，不要整份读文件）\n`
      + `梯形图不落盘，在对话里出（用 smart-lad 取某块某网络的指令序列）`
      + (pack?.fail ? `\n⚠️ 分件打包失败（已退回旧版单份报告）：${pack.fail}` : ''),
  }
}

/** 单次解析 .smart（复用 decodeSmartFile 的块/指令/符号表逻辑，不写报告文件，供 smartDiff 使用） */
function parseSmartOnce(file) {
  const raw = readFileSync(file)
  const { data } = decodeContainer(raw)
  const projName = gbk(data.subarray(0x30, 0x36)).replace(/\0/g, '')
  const innerVer = gbk(data.subarray(0x15, 0x2D)).split('\0')[0]
  const pou = findPous(data)
  const heads = findHeads(data)
  const records = []
  for (let k = 0; k < heads.length; k++) {
    const off = heads[k]
    let nxt = heads[k + 1] ?? off + 0x1000
    for (const { off: poff } of pou) { if (poff > off) { nxt = Math.min(nxt, poff); break } }
    const nm = findName(data, off, nxt) // 真实名（调用盒内嵌块名优先），不做 lastNm 继承
    const ops = extractOperands(data, off, nxt)
    let pouName = '(文件头)'
    for (const { off: poff, name: pnm } of pou) { if (poff <= off) pouName = pnm; else break }
    records.push({ off: `0x${off.toString(16).toUpperCase().padStart(6, '0')}`, pou: pouName, instr: nm, operands: ops })
  }
  let sym = { start: SYMS_START, sysStart: SYS_SYMS_START, end: SYMS_END }
  if (Math.min(SYMS_START, data.length) >= data.length || findSymbols(data, Math.min(SYMS_START, data.length), Math.min(SYMS_END, data.length), { 0x01: 'I', 0x02: 'Q', 0x20: 'M', 0x40: 'T', 0x200: 'SM' }, false).length === 0) {
    const dyn = findSymRange(data)
    if (dyn) sym = dyn
  }
  const blockStreams = []
  for (let k = 0; k < pou.length; k++) {
    const a = pou[k].off
    const b = Math.min(k + 1 < pou.length ? pou[k + 1].off : data.length, sym.start)
    blockStreams.push({ name: pou[k].name, ops: extractOpsStream(data, a, b) })
  }
  const userSyms = findSymbols(data, sym.start, sym.end, { 0x01: 'I', 0x02: 'Q', 0x20: 'M', 0x40: 'T', 0x200: 'SM' }, false)
  // 合并 V 区用户变量符号（如速比、实际速度这类中文命名变量），避免漏表
  for (const s of findVSymbols(data, sym.start, sym.end)) {
    if (!userSyms.some(u => u.addr === s.addr && u.name === s.name)) userSyms.push(s)
  }
  const sysSyms = findSymbols(data, sym.sysStart, sym.end, { 0x200: 'SM' }, true)
  return { projName, innerVer, records, blockStreams, userSyms, sysSyms }
}

/** 新旧 SMART 工程对比（块清单/主程序调用链/I-O 引用/符号表差异），输出 markdown 报告
 *  判据：调用盒内嵌块名 + I/O 锚点判定。 */
function smartDiff(oldFile, newFile, outDir, base) {
  const o = parseSmartOnce(oldFile)
  const n = parseSmartOnce(newFile)
  const stat = (p) => { const m = new Map(); for (const r of p.records) m.set(r.pou, (m.get(r.pou) ?? 0) + 1); return m }
  const oM = stat(o), nM = stat(n)
  const chain = (p) => {
    const names = []
    for (const r of p.records) {
      if (r.pou !== '主程序') continue
      if (!r.instr || r.instr === '?' || r.instr === '') continue
      const last = names[names.length - 1]
      if (last !== r.instr) names.push(r.instr)
    }
    return names.join(' → ')
  }
  const ioOf = (p) => {
    const byBlock = new Map()
    for (const b of p.blockStreams) {
      const io = [...new Set(b.ops.filter(x => /^(I|Q)\d+\.\d+$/.test(x)))].sort()
      if (io.length) byBlock.set(b.name, io)
    }
    const all = [...new Set([...byBlock.values()].flat())].sort()
    return { byBlock, all }
  }
  const nIO = ioOf(n), oIO = ioOf(o)
  const L = []
  L.push(`# SMART 工程对比：${n.projName}（新） vs ${o.projName}（旧）`)
  L.push(`- 版本：新 ${n.innerVer}；旧 ${o.innerVer}`)
  L.push('\n## 1. 块清单差异（指令记录数）')
  L.push('| 块 | 新 | 旧 | 状态 |')
  L.push('|---|---|---|---|')
  for (const b of [...new Set([...oM.keys(), ...nM.keys()])]) {
    const x = nM.get(b) ?? 0, y = oM.get(b) ?? 0
    let st = '相同'
    if (x === 0) st = '**新工程缺失**'
    else if (y === 0) st = '新工程独有'
    else if (x < y * 0.7) st = `缩水 ${x}/${y}`
    else if (x > y * 1.3) st = `扩充 ${x}/${y}`
    L.push(`| ${b} | ${x} | ${y} | ${st} |`)
  }
  L.push('\n## 2. 主程序调用链（调用盒内嵌块名）')
  L.push(`- 新: ${chain(n) || '(未解码到)'}`)
  L.push(`- 旧: ${chain(o) || '(未解码到)'}`)
  L.push('\n## 3. I/O 引用对比（块级汇总）')
  L.push(`- 新输入: ${nIO.all.filter(x => x.startsWith('I')).join(' ') || '无'}`)
  L.push(`- 旧输入: ${oIO.all.filter(x => x.startsWith('I')).join(' ') || '无'}`)
  L.push(`- 新输出: ${nIO.all.filter(x => x.startsWith('Q')).join(' ') || '无'}`)
  L.push(`- 旧输出: ${oIO.all.filter(x => x.startsWith('Q')).join(' ') || '无'}`)
  L.push(`- 新有旧无: ${nIO.all.filter(x => !oIO.all.includes(x)).join(' ') || '无'}`)
  L.push(`- 旧有新无: ${oIO.all.filter(x => !nIO.all.includes(x)).join(' ') || '无'}`)
  L.push('\n### 新工程输出驱动分布（按块）')
  for (const [b, ios] of nIO.byBlock) L.push(`- ${b}: ${ios.join(' ')}`)
  L.push('\n### 旧工程输出驱动分布（按块）')
  for (const [b, ios] of oIO.byBlock) L.push(`- ${b}: ${ios.join(' ')}`)
  L.push('\n## 4. 符号表差异（用户表）')
  const symKeys = (p) => new Set(p.userSyms.map(s => `${s.addr}=${s.name}`))
  const nS = symKeys(n), oS = symKeys(o)
  L.push(`- 新: ${nS.size} 条；旧: ${oS.size} 条`)
  for (const s of nS) if (!oS.has(s)) L.push(`- 新增: ${s}`)
  for (const s of oS) if (!nS.has(s)) L.push(`- 移除: ${s}`)
  if (nS.size === 0 && oS.size === 0) L.push('（两工程均无用户符号表，或版本格式未支持）')
  L.push('\n## 5. 变量引用变化（引用计数对比法）')
  L.push('> 判据：**加标签/改注释/重新导出 = 引用计数不变**；某个变量引用数骤降/消失 = 代码被改动或两版不同源。')
  L.push('> 注意 "加标签" 会同步新增符号表条目（见第 4 节），但不会减少代码引用——第 4 节新增 + 本节无变化 才可判定为"仅加标签"。')
  const refCount = (p) => {
    const m = new Map()
    for (const r of p.records) for (const o of r.operands) if (/^[VM]/.test(o)) m.set(o, (m.get(o) ?? 0) + 1)
    return m
  }
  const nR = refCount(n), oR = refCount(o)
  const vars5 = [...new Set([...nR.keys(), ...oR.keys()])].sort()
  let any5 = false
  for (const v of vars5) {
    const a = nR.get(v) ?? 0, b = oR.get(v) ?? 0
    if (a === b) continue
    if (a === 0) { any5 = true; L.push(`- \`${v}\` 旧 ${b} → 新 0：**引用消失**（代码改动，非标签）`) }
    else if (b === 0) { any5 = true; L.push(`- \`${v}\` 旧 0 → 新 ${a}：**新增引用**`) }
    else if (a < b * 0.5) { any5 = true; L.push(`- \`${v}\` 旧 ${b} → 新 ${a}：骤降 **存疑**`) }
    else if (a > b * 1.5) { any5 = true; L.push(`- \`${v}\` 旧 ${b} → 新 ${a}：骤增 **存疑**`) }
  }
  if (!any5) L.push('- 无显著引用变化（仅标签/注释/导出差异的可能性大）')
  const report = L.join('\n')
  const out = outDir ?? defaultArchiveDir(newFile, base)
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, '对比报告.md'), report, 'utf8')
  return { proceed: `对比报告: ${join(out, '对比报告.md')}`, report }
}

// ─────────────── SMART 子程序内部结构解析（讲解"XX 子程序怎么写"用） ───────────────

const BOX_PIN_NAMES = new Set(['EN', 'ENO', 'IN', 'IN1', 'IN2', 'IN3', 'IN4', 'OUT', 'OUT1', 'OUT2', 'N'])

/** 指令盒头：01 01 00 00 00 <1~2 字节序号> 03 01 */
function isBoxHead(data, i) {
  if (!(data[i] === 1 && data[i + 1] === 1 && data[i + 2] === 0 && data[i + 3] === 0 && data[i + 4] === 0)) return false
  const b5 = data[i + 5], b6 = data[i + 6], b7 = data[i + 7]
  if (b5 <= 0x0f && b6 === 0x03 && b7 === 0x01) return true
  return b5 <= 0x0f && b6 <= 0x0f && b7 === 0x03 && data[i + 8] === 0x01
}

/** 盒内元素按偏移顺序提取：指令名/引脚(ASCII)、名称(GBK)、操作数对。每轮必前进 + 迭代上限。 */
function scanBoxElements(data, a, b) {
  const instr = [], pins = [], names = [], ops = []
  let i = a, guard = 0
  const cap = (b - a) * 2 + 64
  while (i < b) {
    if (++guard > cap) break
    if (data[i] === 0x02 && data[i + 1] === 0x00) {
      const t = data[i + 2]
      if ([0x01, 0x02, 0x04, 0x08].includes(t) && i + 11 <= b) {
        const area = data.readUInt32LE(i + 3)
        const val = data.readUInt32LE(i + 7)
        if (AREA[area] !== undefined) { ops.push(fmtOperand(t, area, val)); i += 11; continue }
      }
      const len = data[i + 2] | (data[i + 3] << 8)
      if (len > 0 && len < 40 && i + 4 + len < b && data[i + 4 + len] === 0) {
        const nb = data.subarray(i + 4, i + 4 + len)
        let ok = true
        for (const x of nb) if (x !== 0 && x < 0x20 && x < 0x81) { ok = false; break }
        if (ok) {
          const nm = gbk(nb).trim()
          if (nm) { names.push(nm); i += 4 + len; continue }
        }
      }
    }
    const c = data[i]
    if (c >= 0x20 && c < 0x7f) {
      let j = i
      while (j < b && data[j] >= 0x20 && data[j] < 0x7f) j++
      const s = data.subarray(i, j).toString('ascii')
      if (/^[A-Z][A-Z0-9_]{1,20}$/.test(s) || /^[<>=]{1,2}[A-Z]{1,2}$/.test(s)) {
        if (BOX_PIN_NAMES.has(s)) pins.push(s)
        else instr.push(s)
      }
      i = j > i ? j : i + 1
      continue
    }
    if (c >= 0x81 && i + 1 < b) {
      let j = i
      while (j + 1 < b && data[j] >= 0x81 && data[j + 1] >= 0x40) j += 2
      if (j > i) { const s = gbk(data.subarray(i, j)); if (s) names.push(s); i = j; continue }
    }
    i += 1
  }
  return { instr, pins, names: names.filter(n => n && !n.includes('\uFFFD')), ops }
}

/** 接口参数表：`02 00 <len u16> <GBK 名>` 后 48B 内紧跟 L 区操作数 → {name, type, val}
 *  只在块末尾 0x1000 字节内解析（接口表在块尾部），并过滤空名/乱码/重复，避免把指令名当参数名。 */
function parseIfaceParams(data, a, b) {
  const res = []
  const seen = new Set()
  let i = Math.max(a, b - 0x1000), guard = 0
  const cap = (b - i) * 2 + 64
  while (i < b - 15) {
    if (++guard > cap) break
    if (data[i] === 0x02 && data[i + 1] === 0x00) {
      const len = data[i + 2] | (data[i + 3] << 8)
      if (len > 0 && len < 40 && i + 4 + len + 11 <= b && data[i + 4 + len] === 0) {
        const nb = data.subarray(i + 4, i + 4 + len)
        let ok = true
        for (const x of nb) if (x !== 0 && x < 0x20 && x < 0x81) { ok = false; break }
        if (ok) {
          const nm = gbk(nb).trim()
          if (nm && /[\p{L}\p{N}]/u.test(nm) && !nm.includes('\uFFFD') && !seen.has(nm)) {
            let hit = null
            const lim = Math.min(b, i + 4 + len + 48)
            for (let j = i + 4 + len; j + 11 <= lim; j++) {
              if (data[j] === 0x02 && data[j + 1] === 0x00 && [0x01, 0x02, 0x04, 0x08].includes(data[j + 2])) {
                const area = data.readUInt32LE(j + 3)
                const val = data.readUInt32LE(j + 7)
                if (area === 0x2000) { hit = { type: data[j + 2], val }; break }
              }
            }
            if (hit) { res.push({ name: nm, ...hit }); seen.add(nm); i += 4 + len; continue }
          }
        }
      }
    }
    i += 1
  }
  return res
}

/** 调用点：`E9 03 .. 01 00 02 00 03 00 <被调块名 GBK>` → 所属块 + 实参操作数 */
function findCallSites(data, name, pou) {
  const res = []
  for (let i = 0; i < data.length - 20; i++) {
    if (data[i] !== 0xE9 || data[i + 1] !== 0x03) continue
    if (!(data[i + 3] === 0x01 && data[i + 4] === 0x00 && data[i + 5] === 0x02 && (data[i + 6] === 0x00 || data[i + 6] === 0x09) && data[i + 7] === 0x03 && data[i + 8] === 0x00)) continue
    let e = i + 9
    while (e < data.length && data[e] !== 0 && e - i < 60) e++
    const nm = gbk(data.subarray(i + 9, e)).trim()
    if (nm !== name) continue
    let h = i
    while (h > i - 0x500 && h > 0 && !isBoxHead(data, h)) h--
    let t = i + 9
    while (t < data.length - 12 && t < i + 0x300 && !isBoxHead(data, t)) t++
    const ops = extractOperands(data, h, Math.min(t, i + 0x300))
    let owner = '(文件头)'
    for (const p of pou) { if (p.off <= h) owner = p.name; else break }
    res.push({ off: h, owner, ops })
  }
  return res
}

const L_TYPE_NAME = { 0x01: 'BOOL', 0x02: 'BYTE', 0x04: 'INT/WORD', 0x08: 'DWORD' }

/** 生成子程序内部结构报告（markdown） */
function buildPouStructureReport(file, data, pou, pouFilter) {
  const projName = gbk(data.subarray(0x30, 0x36)).replace(/\0/g, '')
  const L = []
  L.push('# S7-200 SMART 子程序内部结构')
  L.push('')
  L.push('> ✓ 网络拓扑（并联/串联）与沿触点（P/N）**本工程文件里就能解出来**：用工具 `smart-lad`（`node assets/smart-lad.mjs <工程.smart> [块名]`）直接打印每块每网络的 LAD 指令序列（已用导出的 STL 回归：主程序 17/17 逐条一致）。**不必再让用户从软件导出 STL**；导出 STL 只在需要交叉核对时用。')
  L.push('')
  L.push(`- 源文件: \`${file}\``)
  L.push(`- 项目名: ${projName || '—'}；块数: ${pou.length}`)
  L.push('')
  const targets = pouFilter ? pou.filter(p => p.name === pouFilter) : pou
  if (!targets.length) {
    L.push(`> 未找到块「${pouFilter}」；可用块名：${pou.map(p => p.name).join('、')}`)
    return L.join('\n')
  }
  for (const t of targets) {
    const idx = pou.indexOf(t)
    const a = t.off
    const b = idx + 1 < pou.length ? pou[idx + 1].off : data.length
    const heads = []
    for (let i = a; i < b - 12; i++) if (isBoxHead(data, i)) heads.push(i)
    const boxes = heads.map((h, k) => ({ off: h, ...scanBoxElements(data, h, k + 1 < heads.length ? heads[k + 1] : b) }))
    const iface = parseIfaceParams(data, a, b)
    const calls = findCallSites(data, t.name, pou)
    L.push(`## 块：${t.name}`)
    L.push('')
    L.push(`- 区间: 0x${a.toString(16).toUpperCase()} ~ 0x${b.toString(16).toUpperCase()}；盒数: ${boxes.length}`)
    L.push('')
    if (iface.length) {
      L.push('### 接口参数（L 区）')
      L.push('')
      L.push('| 参数名 | L 地址 | 类型 |')
      L.push('|---|---|---|')
      for (const p of iface) L.push(`| ${p.name} | ${fmtOperand(p.type, 0x2000, p.val)} | ${L_TYPE_NAME[p.type] ?? '?'} |`)
      L.push('')
    }
    L.push('### 内部结构（盒级，按偏移顺序）')
    L.push('')
    boxes.forEach((bx, k) => {
      const parts = []
      if (bx.instr.length) parts.push(`指令 **${bx.instr.join(' / ')}**`)
      if (bx.pins.length) parts.push(`引脚 ${bx.pins.join('/')}`)
      if (bx.ops.length) parts.push(`操作数 \`${bx.ops.join('; ')}\``)
      if (bx.names.length) parts.push(`名称 ${bx.names.join('; ')}`)
      L.push(`${k + 1}. \`0x${bx.off.toString(16).toUpperCase()}\` — ${parts.join('　·　') || '（元数据/空）'}`)
    })
    L.push('')
    if (calls.length) {
      L.push('### 调用点')
      L.push('')
      L.push('| 所属块 | 调用盒偏移 | 实参操作数 |')
      L.push('|---|---|---|')
      for (const c of calls) L.push(`| ${c.owner} | \`0x${c.off.toString(16).toUpperCase()}\` | ${c.ops.join('; ') || '—'} |`)
      L.push('')
    }
  }
  return L.join('\n')
}

function decodeSmartPouStructure(file, pouFilter) {
  const raw = readFileSync(file)
  const { data } = decodeContainer(raw)
  const pou = findPous(data)
  const report = buildPouStructureReport(file, data, pou, pouFilter)
  return { proceed: report, report }
}

function decodeSmartLib(file, outDir, base) {  const raw = readFileSync(file)
  const { version, data } = decodeContainer(raw)
  const texts = extractTexts(data)
  const vars = []
  const seen = new Set()
  for (const { text } of texts) {
    if (/^[A-Za-z_][A-Za-z0-9_]{1,24}$/.test(text) && !seen.has(text)) {
      seen.add(text)
      vars.push(text)
    }
  }
  const comments = texts.filter(t => t.text.length > 30 && /[A-Za-z]/.test(t.text)).slice(0, 200).map(t => t.text)
  const out = outDir ?? defaultArchiveDir(file, base)
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, '库解码.md'), buildLibReport(version, vars, comments), 'utf8')
  writeFileSync(join(out, '字符串全录.txt'), texts.map(t => `0x${t.off.toString(6, 16)}\t${t.text}`).join('\n'), 'utf8')
  return {
    proceed: `库报告: ${join(out, '库解码.md')}\n字符串全录: ${join(out, '字符串全录.txt')}\n变量 ${vars.length} 个、注释串 ${comments.length} 条`,
  }
}

function buildSmReport(kind, version, want, projName, innerVer, pou, records, userSyms, sysSyms, blockStreams, blockIfaces, netRows = [], symDefaults = [], symAttrs = [], pouStructures = [], fingerprint = null, dangling = []) {
  const L = []
  L.push(`# S7-200 SMART「${projName || '(未命名)'}」解码报告`)
  L.push('')
  L.push(`- 容器: ${kind === 'project' ? 'SH3' : 'DEM'} + zlib → ${want.toLocaleString()} B 内部文档`)
  L.push(`- 文档版本: ${innerVer}；项目名: ${projName || '—'}；块顺序与项目树一致`)
  if (fingerprint) L.push(`- **源文件指纹**: ${fingerprint.size.toLocaleString()} B，${fingerprint.mtime}（用本报告前先核对当前源文件；不一致说明报告已过期，须重新解码）`)
  L.push('')
  L.push('## 1. 程序块清单')
  L.push('')
  L.push('| 顺序 | 块名 |')
  L.push('|---|---|')
  pou.forEach((p, k) => L.push(`| ${k + 1} | ${p.name} |`))
  L.push('')
  L.push('## 2. 指令序列（按块）')
  L.push('')
  let cur = null
  for (const r of records) {
    if (r.pou !== cur) {
      L.push('')
      L.push(`### ${r.pou}`)
      L.push('')
      L.push('| 偏移 | 指令 | 操作数 |')
      L.push('|---|---|---|')
      cur = r.pou
    }
    L.push(`| ${r.off} | ${r.instr} | ${r.operands.join('; ') || '—'} |`)
  }
  L.push('')
  L.push('## 2.5 强行解码：库块接口 + 块级操作数流')
  L.push('')
  L.push('> 库块与用户库子程序（无标准指令盒头，内部结构不可见），')
  L.push('> 接口变量与操作数以 02 00 type area addr 对形式直接存储。下表按块列出接口名与全部操作数流（指令名不可复原，逻辑靠数据流解读）。')
  L.push('')
  for (let k = 0; k < blockIfaces.length; k++) {
    const n = blockIfaces[k].name
    const ifs = blockIfaces[k].ifs
    const ops = blockStreams[k].ops
    L.push(`### ${n}`)
    L.push('')
    if (ifs.length) L.push(`- 接口变量: ${ifs.map(f => `\`${f.name}\``).join(', ')}`)
    if (ops.length) {
      const shown = ops.slice(0, 400).join(' ')
      L.push(`- 操作数流(${ops.length}): ${shown}${ops.length > 400 ? ' …（已截断，完整见记录.json）' : ''}`)
    } else {
      L.push('- 操作数流: （无）')
    }
    L.push('')
  }
  L.push('## 2.6 功能级扫描：算术/换算指令链（找"比例/速比/换算/档位"功能看这里）')
  L.push('')
  L.push('> ① 不要按中文符号名搜索——速比/换算系数常以无名 VW 变量实现（有算术链=有换算功能，无名字≠无功能）；')
  L.push('> ② 除号常被实现为"乘倒数/移位/比较分档"，档位判别 = 同一变量与多个阈值比较（典型为 MUL_x 后跟一组比较）；')
  L.push('> ③ 比例/速度类功能三条典型实现路径：算术链（乘除）、比较分档（阈值组）、定时/计数换算（INC+T 定时器 测周期）。')
  L.push('')
  const ARITH = /^(MUL_I|MUL_DI|MUL_R|DIV_I|DIV_DI|DIV_R|ADD_I|ADD_DI|ADD_R|SUB_I|SUB_DI|SUB_R|SHL_DW|SHR_DW|WAND_DW|WOR_DW|WXOR_DW|BCD_I|I_BCD|I_B|B_I|S_ITR)$/
  let arithRows = records.filter(r => ARITH.test(r.instr))
  if (arithRows.length === 0) {
    L.push('- （本工程无解码出的算术/换算指令——可能被含在库块操作数流中，见 2.5 节）')
  } else {
    L.push('| 块 | 偏移 | 指令 | 操作数 |')
    L.push('|---|---|---|---|')
    for (const r of arithRows) L.push(`| ${r.pou} | ${r.off} | ${r.instr} | ${r.operands.join('; ') || '—'} |`)
  }
  L.push('')
  // 档位判别：同一变量≥2 次参与的比较类大盒子（MOV_W 混合盒无法逐条切分时，提示按操作数流比对）
  L.push('## 2.7 信号流：变量引用分布（谁在读写谁——按引用条数排序，前 60）')
  L.push('')
  L.push('> 简单指令盒（INC/MUL/MOV 等）的操作数存于编译参数区，盒内只有模板 ID，直接读不出；')
  L.push('> 用"变量引用分布"从数据流补全——查某个变量（如速比）被哪些块的哪些指令引用，两端对照即得逻辑。')
  L.push('')
  const refs = new Map()   // 地址 -> Map("块@偏移(指令)" -> 该记录内出现次数)
  for (const r of records) {
    for (const o of r.operands) {
      // 排除 Modbus 通信区（VB4000/VB425x 等），否则前 60 全被通信变量占满
      if (/^[VM]/.test(o) && !/^VB(4?256|4?255|4?253|4?252|4000|4001|4002|4256|4255|4253|4252)\b/.test(o)) {
        if (!refs.has(o)) refs.set(o, new Map())
        const mm = refs.get(o)
        const k = `${r.pou}@${r.off}(${r.instr})`
        mm.set(k, (mm.get(k) ?? 0) + 1)
      }
    }
  }
  const named = new Set(userSyms.map(s => s.addr))
  const total = (mm) => [...mm.values()].reduce((a, b) => a + b, 0)
  // 读/写判据：同一盒内出现 ≥2 次必是 OUT（写）——3 引脚盒的 OUT 在两个「对」里各出现一次
  const isWrite = (mm) => [...mm.values()].some(c => c >= 2)
  const sorted = [...refs.entries()].sort((a, b) => {
    const na = named.has(a[0]) ? 1 : 0
    const nb = named.has(b[0]) ? 1 : 0
    if (na !== nb) return nb - na
    return total(b[1]) - total(a[1])
  }).slice(0, 60)
  L.push('| 变量 | 引用数 | 读/写 | 位置（前 6 条，×n = 同一盒内出现 n 次） |')
  L.push('|---|---|---|---|')
  if (sorted.length === 0) L.push('- （无）')
  for (const [v, mm] of sorted) {
    const pos = [...mm.entries()].slice(0, 6).map(([k, c]) => (c > 1 ? `${k}×${c}` : k)).join(' ')
    L.push(`| \`${v}\` | ${total(mm)} | ${isWrite(mm) ? '写' : '读?'} | ${pos}${mm.size > 6 ? ' …' : ''} |`)
  }
  L.push('')
  L.push('> 读/写判据（推定）：**同一盒内出现 ≥2 次 = 写**（3 引脚盒的 OUT 在两个引脚对里各出现一次）；只出现 1 次记"读?"——')
  L.push('> 两引脚盒（MOV_W／INC_W）的 OUT 也只出现一次，要按同记录最后一位人工确认（引脚级定位用 smart-pin-dump）。')
  L.push('')
  L.push('## 2.7b 未接线变量（有符号名、程序区 0 次引用）')
  L.push('')
  L.push('> 读法：这些变量在符号表里活着，但程序里没有任何操作数引用 —— 遇到「XX 功能为什么没生效 / 屏上值为什么不变」时，先查这张表。')
  L.push('> 典型成因：加功能只建了变量没画链、改版时删掉了一段逻辑、HMI 还在写一个 PLC 不读的地址。')
  L.push('> 判定法：字节级精确匹配操作数编码 `02 00 <type> <area:4> <addr:4>`，只在程序区计数（符号表区已排除，否则全表误报）。')
  L.push('')
  {
    const junk = (n) => /^Symbol_\d+$/.test(n ?? '')
    const func = dangling.filter(d => /^V/.test(d.addr) && !junk(d.name))
    const mbit = dangling.filter(d => /^M/.test(d.addr) && !junk(d.name))
    const sysCnt = dangling.length - func.length - mbit.length
    if (func.length === 0 && mbit.length === 0) {
      L.push('- （无：所有有名字的功能变量都在程序里被引用过）')
    } else {
      if (func.length) {
        L.push(`- **V 区（功能参数/窗口/结果，共 ${func.length} 个）** —— 屏上能改、程序不读，或算出来没人用，都落在这一组：`)
        L.push('')
        L.push('| 地址 | 符号名 |')
        L.push('|---|---|')
        for (const d of func) L.push(`| \`${d.addr}\` | ${d.name} |`)
        L.push('')
      }
      if (mbit.length) {
        L.push(`- **M 区（位，共 ${mbit.length} 个）**：`)
        L.push('')
        L.push('| 地址 | 符号名 |')
        L.push('|---|---|')
        for (const d of mbit) L.push(`| \`${d.addr}\` | ${d.name} |`)
        L.push('')
      }
    }
    if (sysCnt > 0) L.push(`- （另有 ${sysCnt} 个 PLC 系统位/自动生成的 \`Symbol_N\` 占位未引用，属正常，未列出）`)
  }
  L.push('')
  L.push('## 2.8 网络行结构（网络拓扑元数据：行首 01 00 00 03 01 + 盒序列 + 操作数计数）')
  L.push('')
  L.push('> 每行 = 梯形图一行：`01 00 00 03 01` 行首，盒序列 `01 01 00 00 00 <行号> <盒号> 03 01`，盒后为操作数计数 `<n> 00 00 03/04`（网络元数据盒无 02 00 操作数对）。')
  L.push('')
  L.push(`- 网络行总数: ${netRows.length}；首行 @${netRows[0] ? '0x' + netRows[0].off.toString(16) : '—'}；总盒数: ${netRows.reduce((s, r) => s + r.boxes, 0)}`)
  L.push('')
  L.push('## 2.9 符号属性/默认值表（条目头 01 01 02 00 00 00 01 03 01 = 符号ID引用；01 01 00 00 00 01 00 00 00 00 00 00 00 <值> = 默认值）')
  L.push('')
  L.push(`- 符号 ID 引用条目: ${symAttrs.length} 条（首末偏移: ${symAttrs.slice(0, 3).map(a => '0x' + a.off.toString(16).toUpperCase()).join(', ')}${symAttrs.length > 3 ? ' …' : ''}${symAttrs.length ? ' 末0x' + symAttrs[symAttrs.length - 1].off.toString(16).toUpperCase() : ''}）`)
  if (symDefaults.length === 0) {
    L.push('- 默认值条目: 0')
  } else {
    const cnt = {}
    for (const d of symDefaults) cnt[d.value] = (cnt[d.value] ?? 0) + 1
    L.push(`- 默认值条目: ${symDefaults.length} 条, 值分布: ${Object.entries(cnt).map(([v, n]) => `${v}×${n}`).join(' ; ')}`)
    L.push('')
    L.push('| 偏移 | 默认值 | 序号 |')
    L.push('|---|---|---|')
    for (const d of symDefaults.slice(0, 20)) L.push(`| 0x${d.off.toString(16).toUpperCase()} | ${d.value} (0x${d.value.toString(16).toUpperCase()}) | ${d.idx} |`)
  }
  L.push('')
  L.push('## 3. 用户符号表')
  L.push('')
  L.push('| 地址 | 符号名 |')
  L.push('|---|---|')
  for (const s of userSyms) L.push(`| \`${s.addr}\` | ${s.name} |`)
  L.push(freeSpaceReport(userSyms, records))
  if (pouStructures.length) {
    L.push('## 3.5 子程序接口速查（参数 L 地址 + 调用点数）')
    L.push('')
    L.push('> 参数 L 地址由块尾接口记录解析；调用点数 = 全工程 `E9 03 .. <块名>` 调用盒计数。逐盒内部结构用工具 `smart-pou-structure`。')
    L.push('')
    for (const ps of pouStructures) {
      const ifc = ps.iface.length
        ? ps.iface.map(p => `\`${p.name}\`=${fmtOperand(p.type, 0x2000, p.val)}(${L_TYPE_NAME[p.type] ?? '?'})`).join('、')
        : '（无参数记录）'
      L.push(`- **${ps.name}**：调用 ${ps.calls} 处　参数：${ifc}`)
    }
    L.push('')
  }
  // 3.6 静态体检：Q 点多块引用（潜在双线圈）/ 符号表 I-Q 点未引用 / 有名字但程序未用
  {
    const qMap = new Map(), iMap = new Map()
    for (const b of blockStreams ?? []) {
      for (const op of b.ops ?? []) {
        if (!/^[QI]\d+\.\d+$/.test(op)) continue
        const tgt = op[0] === 'Q' ? qMap : iMap
        if (!tgt.has(op)) tgt.set(op, new Map())
        const mm = tgt.get(op)
        mm.set(b.name, (mm.get(b.name) ?? 0) + 1)
      }
    }
    L.push('## 3.6 静态体检')
    L.push('')
    const multiQ = [...qMap.entries()].filter(([, m]) => m.size > 1)
    L.push(`- **Q 输出点多块引用（潜在双线圈）**: ${multiQ.length ? '' : '无'}`)
    for (const [q, m] of multiQ) L.push(`  - \`${q}\`: ${[...m.entries()].map(([b, n]) => `${b}×${n}`).join('、')}`)
    const named = new Map()
    for (const s of userSyms ?? []) named.set(s.addr, s.name)
    const unused = [...named.entries()].filter(([addr]) => /^[IQ]\d+\.\d+$/.test(addr) && !iMap.has(addr) && !qMap.has(addr))
    L.push(`- **符号表 I/Q 点但程序未引用**: ${unused.length ? unused.map(([a, n]) => `\`${a}\`(${n})`).join('、') : '无'}`)
    const unnamedQ = [...qMap.keys()].filter(a => !named.has(a))
    L.push(`- **Q 点无符号名**: ${unnamedQ.length ? unnamedQ.map(a => `\`${a}\``).join('、') : '无'}`)
    L.push('')
  }
  L.push(vOverlapReport(records))
  L.push('## 4. 系统符号表')
  L.push('')
  L.push('| 地址 | 符号名 |')
  L.push('|---|---|')
  for (const s of sysSyms) L.push(`| \`${s.addr}\` | ${s.name} |`)
  L.push('')
  L.push('## 5. 说明')
  L.push('')
  L.push('- 操作数格式 `02 00 <type> <area> <addr>`: type=0x01位/0x02字节/0x04字/0x08双字; area=I/Q/V/M/T/SM/L/库内部')
  L.push('- V 区位布尔显示为 `V{byte}.{bit}`（如 V101.3）；无名 V 位通常由 HMI 或库写入')
  L.push('- 计数器引用(区域码 0x80)显示为 C{n}：CTU/CTD 盒的计数器号、以及它被当位操作用的地方都落在这里；库存储区引用在 V 区，别混')
  L.push('- 库块代码受保护：工程内只有接口变量与操作数流（见 2.5 节），指令级 STL 仅在官方软件中可见')
  L.push('')
  return L.join('\n')
}

/** 地址占用与空闲段分析（加功能前的地址规划三查询）
 *  - 有符号名 → 一律不动（哪怕符号是"备用开/备用关"这类预留坑）
 *  - 无名字但程序已引用 → 也不动（如无名 VW202 在点动链在用）
 *  - 只从「无符号名 + 无程序引用 + 成组连续」的段里取
 *  type 前缀: W=VW D=VD B=VB X=位(按字节算)
 */
function freeSpaceReport(userSyms, records, ptrRefs) {
  const named = new Map()   // addr → name
  for (const s of userSyms) named.set(s.addr, s.name)
  const used = new Set()    // 程序引用过的地址（记录 operands 全扫）
  for (const r of records) for (const o of (r.operands ?? [])) used.add(o)
  // 指针实参（&地址）也是在用 —— 漏它会把 Modbus 缓冲区这类字节列进空闲段
  // （如 &VB160 作 MBUS_MSG 的 DataPtr 时覆盖 2 个字）。
  const ptrKnown = Array.isArray(ptrRefs)
  for (const r of (ptrRefs ?? [])) {
    used.add(String(r.name).replace(/^&/, ''))
    if (r.aName === 'V') for (let b = r.addr; b < r.addr + r.bytes; b++) used.add(`VB${b}`)
  }

  const parseV = (addr, pref) => {
    const m = new RegExp(`^${pref}(\\d+)$`).exec(addr)
    return m ? Number(m[1]) : null
  }
  const addrName = new Map() // 'W220' → 名字或 null
  for (const [addr, name] of named) {
    let key = null
    if (/^VW\d+$/.test(addr)) key = 'W' + addr.slice(2)
    else if (/^VD\d+$/.test(addr)) key = 'D' + addr.slice(2)
    else if (/^VB\d+$/.test(addr)) key = 'B' + addr.slice(2)
    else if (/^V\d+\.\d+$/.test(addr)) key = 'B' + Math.floor(Number(addr.slice(1).split('.')[0]) / 8)
    if (key != null && !addrName.has(key)) addrName.set(key, name)
  }

  const L = []
  L.push('')
  L.push('## 3.5 地址占用与空闲段（加功能时按此选地址）')
  L.push('')
  L.push('> 规则：**有符号名的地址一律不动**（含"备用开/备用关"这类预留坑——那是有名字的坑位，动它=毁掉预留功能）；**无名字但程序已引用**的也不动；只从「无符号名 + 无引用 + 成组连续」的段里取。')
  L.push('')
  L.push('### A. 有符号名（保留，勿动）')
  L.push('')
  const namedVW = [], namedVD = [], namedOther = []
  for (const [addr, name] of named) {
    if (/^VW/.test(addr)) namedVW.push(`${addr}(${name})`)
    else if (/^VD/.test(addr)) namedVD.push(`${addr}(${name})`)
    else namedOther.push(addr)
  }
  L.push(`- VW: ${namedVW.join(' ') || '—'}`)
  L.push(`- VD: ${namedVD.join(' ') || '—'}`)
  L.push(`- 其他(I/Q/M/SM/V位): ${namedOther.join(' ') || '—'}`)
  L.push('')
  L.push('### B. 程序已引用（含无名地址，勿动）')
  L.push('')
  const usedVW = [], usedVD = [], usedVB = []
  for (const o of used) {
    if (/^VW\d+$/.test(o)) usedVW.push(o)
    else if (/^VD\d+$/.test(o)) usedVD.push(o)
    else if (/^VB\d+$/.test(o)) usedVB.push(o)
  }
  L.push(`- VW: ${usedVW.slice(0, 120).join(' ') || '—'}${usedVW.length > 120 ? ` …(${usedVW.length})` : ''}`)
  L.push(`- VD: ${usedVD.slice(0, 120).join(' ') || '—'}${usedVD.length > 120 ? ` …(${usedVD.length})` : ''}`)
  L.push(`- VB: ${usedVB.slice(0, 120).join(' ') || '—'}${usedVB.length > 120 ? ` …(${usedVB.length})` : ''}`)
  L.push('')

  // 空闲段：字节级占用判断（VW/VD/VB 共享 V 区字节，独立序列扫会漏重叠——
  // 案例：VW220/VW222 占字节 220~223，VD220 与之重叠，序列独立扫却判 VD220 空闲）
  const B = (prefix) => (addr) => {
    const n = parseV(addr, prefix)
    return n == null ? null : { n, bytes: [n, n + (prefix === 'VW' ? 1 : prefix === 'VD' ? 3 : 0)] }
  }
  const byteTaken = new Set()
  const markBytes = (addr) => {
    let spec = null
    if (/^VW\d+$/.test(addr)) spec = ['VW', Number(addr.slice(2))]
    else if (/^VD\d+$/.test(addr)) spec = ['VD', Number(addr.slice(2))]
    else if (/^VB\d+$/.test(addr)) spec = ['VB', Number(addr.slice(2))]
    if (!spec) return
    const span = spec[1] + (spec[0] === 'VW' ? 1 : spec[0] === 'VD' ? 3 : 0)
    for (let b = spec[1]; b <= span; b++) byteTaken.add(b)
  }
  for (const o of used) markBytes(o)
  for (const [addr] of named) markBytes(addr)
  const freeBy = (prefix, hi) => {
    const tag = prefix.slice(1)
    const unit = prefix === 'VW' ? 2 : prefix === 'VD' ? 4 : 1
    const addrFree = (a, b) => {
      for (let x = a; x <= b; x++) if (byteTaken.has(x)) return false
      return true
    }
    const spans = []
    let s = null
    for (let i = 0; i <= hi; i += unit) {
      const b = i + unit - 1
      if (addrFree(i, b)) { if (s == null) s = i }
      else { if (s != null) { spans.push([s, i - unit]); s = null } }
    }
    if (s != null) spans.push([s, hi - ((hi - s) % unit)])
    return spans.map(([a, b]) => a === b ? `${tag}${a}` : `${tag}${a}~${tag}${b}`)
  }
  L.push('### C. 空闲段（候选坑位：无名字 + 无引用 + 字节级无重叠 + 连续≥1个单位）')
  L.push('')
  L.push('> 字节级判定：VB/VW/VD 共享 V 区字节，VB20 = VW20 低字节 = VD20 低字节；判空闲按"该地址全部字节均未被任何符号/引用占用"。注意 **同一变量 ID 的 VW/VD 天然冲突**（VW220 占 220~221、VD220 占 220~223），候选坑位务必避开已有 VW 邻居。')
  L.push('')
  const freeW = freeBy('VW', 4095), freeD = freeBy('VD', 4095), freeB = freeBy('VB', 4095)
  L.push(`- VW: ${freeW.join(' ') || '—'}`)
  L.push(`- VD: ${freeD.join(' ') || '—'}`)
  L.push(`- VB: ${freeB.join(' ') || '—'}`)
  L.push('')
  if (!ptrKnown) {
    L.push('> ⚠ 本次没扫指针实参（&地址，如 MBUS_MSG 的 DataPtr）—— 空闲段可能落在缓冲区上；选地址前拿 .smart 原文件再跑一次本工具。')
    L.push('')
  }
  return L.join('\n')
}

/** 操作数 → 地址结构（体检用）：{area, kind, base, len, bit?}。解析不了返回 null。 */
function parseOperandAddr(o) {
  let m
  if ((m = /^([IQM])([DWB])(\d+)$/.exec(o))) {
    const len = m[2] === 'D' ? 4 : m[2] === 'W' ? 2 : 1
    return { area: m[1], kind: len === 4 ? '双字' : len === 2 ? '字' : '字节', base: +m[3], len }
  }
  if ((m = /^V([DWB])(\d+)$/.exec(o))) {
    const len = m[1] === 'D' ? 4 : m[1] === 'W' ? 2 : 1
    return { area: 'V', kind: len === 4 ? '双字' : len === 2 ? '字' : '字节', base: +m[2], len }
  }
  if ((m = /^(SM|[IQM])(\d+)\.([0-7])$/.exec(o))) return { area: m[1] === 'SM' ? 'SM' : m[1], kind: '位', base: +m[2], len: 1, bit: +m[3] }
  if ((m = /^V(\d+)\.([0-7])$/.exec(o))) return { area: 'V', kind: '位', base: +m[1], len: 1, bit: +m[2] }
  if ((m = /^\?t(\d+)\((SM|[IQM]),(\d+)\)$/.exec(o))) {
    const len = Number(m[1]) === 8 ? 4 : Number(m[1]) === 4 ? 2 : 1
    return { area: m[2] === 'SM' ? 'SM' : m[2], kind: len === 4 ? '双字' : len === 2 ? '字' : '字节', base: +m[3], len }
  }
  return null
}

/** V 区地址冲突体检。
 *  两个口径：①重叠冲突——两个不同身份的变量压在同一批字节（A级=都有名字，真冲突；B级=都已引用、至少一方无名）
 *           ②连续空间不足（P级）——单看每字节都空，但连不成要放的长度；尾部余数＝永久浪费的碎片
 *  判据两个口径：旧判据只查重叠一维，会漏掉"连续区被切碎"（10 字节空段能放 2 个双字，
 *  尾部 2 字节被前后占用者夹死，成为永久浪费）。 */
function vBytesOf(p) {
  if (p.bits != null) return [p.base]                     // 位：占它所在的那一字节
  const out = []
  for (let k = 0; k < p.len; k++) out.push(p.base + k)
  return out
}
function conflictIdentity(raw, p, named) {
  if (named.has(raw)) return 'sym:' + named.get(raw)
  if (/^V[WBD]?\d+/.test(raw) || /^\?t\d+\(V,/.test(raw)) return 'base:' + p.base
  return 'raw:' + raw
}
function conflictReport(userSyms, records, ptrRefs, needDoubles, vBytesTotal) {
  const named = new Map()
  for (const s of userSyms) named.set(s.addr, s.name)
  const refs = new Map()
  const touch = (raw, at) => {
    const p = parseOperandAddr(raw)
    if (!p) return
    if (!refs.has(raw)) refs.set(raw, { p, at: [] })
    refs.get(raw).at.push(at)
  }
  for (const r of records) {
    const at = `${r.pou}@${r.off}${r.instr && r.instr !== '?' ? '[' + r.instr + ']' : ''}`
    for (const o of (r.operands ?? [])) if (o) touch(String(o), at)
  }
  for (const [addr] of named) if (!refs.has(addr) && parseOperandAddr(addr)) refs.set(addr, { p: parseOperandAddr(addr), at: ['(仅符号表)'] })
  for (const r of (ptrRefs ?? [])) {
    const nm = 'VB' + r.addr
    if (!refs.has(nm)) refs.set(nm, { p: { area: 'V', kind: '字节', base: r.addr, len: Math.max(1, r.bytes || 1) }, at: ['(指针 ' + (r.name ?? '&VB') + ')'] })
  }

  const list = []
  for (const [raw, v] of refs) list.push({ raw, p: v.p, at: v.at, id: conflictIdentity(raw, v.p, named), named: named.has(raw) })

  const L = []
  /* ① 字节占用图（V 区） */
  const occ = new Array(vBytesTotal).fill(null)
  for (const x of list) {
    if (x.p.area !== 'V') continue
    for (const b of vBytesOf(x.p)) if (b >= 0 && b < vBytesTotal && !occ[b]) occ[b] = x.raw
  }
  const usedCnt = occ.filter(Boolean).length
  const free = []
  let s = -1
  for (let i = 1; i < vBytesTotal; i++) {
    if (!occ[i]) { if (s < 0) s = i }
    else { if (s >= 0) { free.push([s, i - 1]); s = -1 } }
  }
  if (s >= 0) free.push([s, vBytesTotal - 1])

  L.push(`## P 级·碎片告警（连续空闲区被切碎，字节用不上）`)
  L.push('')
  L.push('> 判据：一段连续空闲的字节数不是 4 的整数倍 → 多出来的字节放不下任何双字，永久浪费。')
  L.push('')
  L.push(`V 区已占 ${usedCnt} / ${vBytesTotal} 字节（${(usedCnt / vBytesTotal * 100).toFixed(1)}%）`)
  L.push('')
  const tails = free.filter(([lo, hi]) => (hi - lo + 1) >= 4 && (hi - lo + 1) % 4 !== 0)
  const smalls = free.filter(([lo, hi]) => (hi - lo + 1) < 4)
  if (!tails.length) L.push('- （无：所有可放双字的连续段都正好是 4 的整数倍）')
  for (const [lo, hi] of tails) {
    const len = hi - lo + 1, tail = len % 4
    L.push(`- ⚠ ${lo}~${hi}（${len} 字节）→ 可放 ${Math.floor(len / 4)} 个双字，尾部 ${hi - tail + 1}~${hi} 这 ${tail} 字节放不下双字`)
    L.push(`  被夹在：前 ${occ[lo - 1] || '—'} ／ 后 ${occ[hi + 1] || '—'}`)
  }
  if (smalls.length) {
    const tot = smalls.reduce((a, f) => a + f[1] - f[0] + 1, 0)
    L.push('')
    L.push(`- 另有 ${smalls.length} 段不足 4 字节的零碎空闲，合计 ${tot} 字节，全部放不下双字：${smalls.map(f => `${f[0]}~${f[1]}`).join(' ')}`)
  }

  /* ② 候选推荐 */
  if (needDoubles > 0) {
    L.push('')
    L.push(`## 候选推荐：要放 ${needDoubles} 个双字（${needDoubles * 4} 字节连续）`)
    L.push('')
    const cands = []
    for (const [lo, hi] of free) { let p = lo; while (p + 3 <= hi) { cands.push({ addr: 'VD' + p, from: p, seg: [lo, hi] }); p += 4 } }
    cands.sort((a, b) => (a.seg[1] - a.seg[0]) - (b.seg[1] - b.seg[0]) || a.from - b.from)
    let best = null
    for (let i = 0; i + needDoubles - 1 < cands.length; i++) {
      let ok = true
      for (let k = 1; k < needDoubles; k++) if (cands[i + k].from !== cands[i].from + 4 * k) { ok = false; break }
      if (!ok) continue
      const len = cands[i].seg[1] - cands[i].seg[0] + 1
      if (!best || len < best.len) best = { idx: i, len, seg: cands[i].seg }
    }
    if (best) {
      const addrs = Array.from({ length: needDoubles }, (_, k) => cands[best.idx + k].addr)
      L.push(`- **首选**：${addrs.join(' ')}　（落在空闲段 ${best.seg[0]}~${best.seg[1]}，${best.len} 字节）`)
    } else L.push(`- 找不到连续的 ${needDoubles} 个双字位置`)
    L.push('')
    L.push(`- 其他可选（按所在空闲段从小到大）：${cands.slice(0, 40).map(c => c.addr).join(' ') || '—'}`)
    L.push('')
    L.push('> ⚠ 候选只保证地址空着，**不保证语义合适**（离相关变量远近、是否落在通讯打包区、屏上是否已用）；低地址（如 VD2）在 S7-200 有特殊用途，选中后要人工确认。')
  }

  /* ③ 重叠冲突 A/B/C —— 统一到「位号」空间比较，并对同处去重
   *  踩坑：第一版对「位 vs 字节」按字节区间比，把同一字节里的不同位判成重叠（假冲突数百条）。
   *  正解：位 = [base*8+bit, base*8+bit]，字节区 = [min*8, (max+1)*8-1]，只有位号区间真交叠才算。 */
  const spanOf = p => {
    if (p.bits != null) { const b = p.base * 8 + p.bit; return [b, b] }
    const bs = []
    for (let k = 0; k < p.len; k++) bs.push(p.base + k)
    const lo = Math.min(...bs), hi = Math.max(...bs)
    return [lo * 8, (hi + 1) * 8 - 1]
  }
  const spanText = p => (p.bits != null ? `${p.base}.${p.bit}` : `${p.base}~${p.base + p.len - 1}`)
  const bySpan = new Map()
  for (const x of list) {
    const [lo, hi] = spanOf(x.p)
    const k = `${x.p.area}|${lo}|${hi}`
    if (!bySpan.has(k)) bySpan.set(k, [])
    bySpan.get(k).push(x)
  }
  const seen = new Set()
  const hits = []
  const arr = [...bySpan.entries()]
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const [ka, ga] = arr[i], [kb, gb] = arr[j]
      if (ka.split('|')[0] !== kb.split('|')[0]) continue
      const a0 = Number(ka.split('|')[1]), a1 = Number(ka.split('|')[2])
      const b0 = Number(kb.split('|')[1]), b1 = Number(kb.split('|')[2])
      if (a0 > b1 || b0 > a1) continue                     // 位号区间无交叠
      const S = spanText(ga[0].p), T = spanText(gb[0].p)
      if (S === T) continue                                // 同一处（同址不同写法）不算
      const key = S < T ? S + '|' + T : T + '|' + S
      if (seen.has(key)) continue
      seen.add(key)
      hits.push({ A: ga[0], B: gb[0], S, T })
    }
  }
  const isUsed = x => x.at.some(s => s !== '(仅符号表)')
  const lvl = h => (h.A.named && h.B.named) ? 0 : (isUsed(h.A) && isUsed(h.B) ? 1 : 2)
  hits.sort((x, y) => lvl(x) - lvl(y) || x.A.p.base - y.A.p.base)
  const NAMES = ['A 级·真冲突（两个有名字的变量重叠）', 'B 级·疑似（都已引用、至少一方无名）', 'C 级·仅符号表登记（多半是符号表没清理）']
  L.push('')
  L.push('## 重叠冲突（同一批字节被两个不同身份的东西占用）')
  for (const lv of [0, 1, 2]) {
    const grp = hits.filter(h => lvl(h) === lv)
    L.push('')
    L.push(`### ${NAMES[lv]}（${grp.length} 条）`)
    L.push('')
    if (!grp.length) { L.push('- （无）'); continue }
    const show = grp.slice(0, 30)
    for (const h of show) {
      const nm = x => x.named ? `${x.raw}(${named.get(x.raw)})` : x.raw
      L.push(`- ${nm(h.A)} × ${nm(h.B)}　〔字节 ${h.S} 对 ${h.T}〕`)
      L.push(`  - ${h.A.raw}: ${h.A.at.slice(0, 3).join(' ')}${h.A.at.length > 3 ? ` …(${h.A.at.length} 处)` : ''}`)
      L.push(`  - ${h.B.raw}: ${h.B.at.slice(0, 3).join(' ')}${h.B.at.length > 3 ? ` …(${h.B.at.length} 处)` : ''}`)
    }
    if (grp.length > show.length) L.push(`- …另有 ${grp.length - show.length} 条同级的，未列`)
  }
  return L.join('\n')
}

/** 变量使用体检：某变量的全部引用点 + 与它共用同一批字节的其它地址形式。
 *  用途：回答"某变量这样用有没有问题"——位/字节/字/双字共用同一批 V 区字节时互相改写。 */
function varUsageReport(records, userSyms, target, elemRows, ptrRefs) {
  const t = parseOperandAddr(target)
  const L = []
  L.push('')
  L.push(`## 变量使用体检：${target}`)
  L.push('')
  if (!t) {
    L.push(`> 无法解析地址「${target}」。支持形式：VD20 / VW220 / VB5 / V20.0 / M10.0 / MB10 / I1.3 / Q0.1。`)
    return L.join('\n')
  }
  L.push(`- 类型：${t.kind}${t.kind === '位' ? `（第 ${t.bit} 位）` : `（${t.len} 字节）`}；占用 ${t.area} 区字节 ${t.base}${t.len > 1 ? `~${t.base + t.len - 1}` : ''}`)
  const nm = (userSyms ?? []).find(s => s.addr === target)
  L.push(`- 符号名：${nm ? nm.name : '无（不在用户符号表——属内部/临时地址）'}`)
  L.push('')
  // 指针实参（&地址）。不扫它，"VB160 和 VW160 冲突没"这类问题会答成"没人用"。
  const pAll = Array.isArray(ptrRefs) ? ptrRefs : null
  const pOver = pAll ? pAll.filter(r => r.aName === t.area && !(r.addr > t.base + t.len - 1 || r.addr + r.bytes - 1 < t.base)) : []
  const hits = records.filter(r => (r.operands ?? []).includes(target))
  const wr = writeReport(records, userSyms, target)
  const boxes = sortedBoxes(records)
  const eRows = Array.isArray(elemRows) ? elemRows.filter(r => r.addr === target) : null
  const eW = eRows ? eRows.filter(r => r.kind === 2) : null
  const eR = eRows ? eRows.filter(r => r.kind === 1) : null
  L.push(`### ① 引用点（${hits.length} 条）${eRows ? '　·　读/写按元素级判定' : wr.length ? '　·　含写入点，见 ①b' : ''}`)
  L.push('')
  if (eRows) {
    const pts = eRows.slice().sort((a, b) => (b.kind - a.kind) || (a.off - b.off)).map(r => `0x${r.off.toString(16).padStart(6, '0')}${r.kind === 1 ? '(读)' : '(写)'}${r.sym ? '*' : ''}`)
    L.push(`- 元素级判定（权威）：**写 ${eW.length} 处 / 读 ${eR.length} 处**　→　${pts.join(' ') || '—'}`)
    if (!eW.length) {
      // 注意：元素级只覆盖触点/线圈/S-R，盒的 OUT（如 MUL_I 的 OUT）不在其中 ——
      // 直接写"程序没有任何一条指令写它"是假否定（验证：VW160 被 MUL_I 写，却报"没有人写它"）。
      const bw = hits.filter(h => writeVerdict(h, target, boxes).write).map(h => `${h.off}${h.instr ? `（${h.instr}）` : ''}`)
      if (bw.length) L.push(`- 触点/线圈层面 0 处写 —— 但**盒操作数层面有写点**：${bw.join('、')}（见 ① 表的盒指令）；别按"没人写它"处理。`)
      else L.push(`- **程序没有任何一条指令写它**（只被读）——"会不会被自动复位"这类问题到此收口，不必再看触点条件。`)
    }
    L.push('')
  }
  if (!hits.length) {
    if (pOver.length) L.push('> 程序区 0 处**直接操作数**引用 —— 但这批字节被盒的指针实参点着（见 ①c），**不能当没用过**。')
    else L.push('> 程序区 0 次引用 —— 这个地址建了但程序没读没写（典型：变量表里留的坑位，或功能被改版删掉）。')
  } else {
    L.push('| 块 | 偏移 | 指令（盒内实名，可能为空） | 同盒其它操作数 |')
    L.push('|---|---|---|---|')
    for (const h of hits) {
      const others = (h.operands ?? []).filter(o => o !== target)
      let tag = ''
      if (eRows) {
        const hh = parseInt(String(h.off ?? '').replace(/^0x/i, ''), 16)
        const er = eRows.find(r => Math.abs(r.off - hh) <= 0x40)
        tag = er ? (er.kind === 2 ? '（**写**·元素级）' : '（读·元素级）') : ''
      } else {
        const v = writeVerdict(h, target, boxes)
        tag = v.mark === '读' ? '' : v.mark.startsWith('疑') ? '（疑似写?）' : '（**写**·盒启发式）'
      }
      L.push(`| ${h.pou}${tag} | \`${h.off}\` | ${h.instr || '—'} | ${others.join('; ') || '—'} |`)
    }
    L.push('')
    L.push('> 读表提醒：`SHL_DW`／库块等的"引脚续记录"（同一盒的 IN/OUT 段）有时会单列成一行、同盒其它操作数为空 —— 那是同一盒的第二段，不是新的引用点；偏移紧挨上一条即可判定。')
    if (!eRows) L.push('> 本表读/写用的是**盒启发式**（同盒重复／网点二次出现／指令名），只作参考；要定死读还是写，用 `smart-ladder-elements` 的元素级判定（给的是 .smart 文件时自带）。')
  }
  L.push('')
  if (eRows) {
    if (eW.length) {
      L.push(`### ①b 写入点（${eW.length} 处，元素级判定）`)
      L.push('')
      L.push('| 偏移 | 写法 | 含它的盒（块/盒内名称） |')
      L.push('|---|---|---|')
      for (const r of eW.slice().sort((a, b) => a.off - b.off)) {
        const h = hits.map(x => ({ x, hh: parseInt(String(x.off ?? '').replace(/^0x/i, ''), 16) }))
          .filter(o => Number.isFinite(o.hh) && Math.abs(o.hh - r.off) <= 0x40).sort((a, b) => Math.abs(a.hh - r.off) - Math.abs(b.hh - r.off))[0]
        const own = h ? `${h.x.pou} / ${(h.x.operands ?? []).filter(o => o !== target).join('; ').slice(0, 50) || (h.x.instr || '—')}` : '（同地址的盒没对上——按元素偏移回看该段）'
        L.push(`| \`0x${r.off.toString(16).padStart(6, '0')}\` | ${r.sym ? `S-R 线圈「${r.sym}」` : '线圈 / 指令盒 OUT'} | ${own} |`)
      }
      L.push('')
      L.push('> 复位链看条件：同一网络行里该地址第一次出现之前的操作数就是"成立条件"（触点/比较），元素偏移最大的那处通常是最终写入点。')
    } else {
      L.push('### ①b 写入点（0 处）')
      L.push('')
      L.push('> 元素级扫描：全程序没有任何一条指令写它（含用符号名写的 S/R 线圈）。**"会不会被复位"这类问题到此收口。**')
      L.push('')
    }
  } else if (wr.length) for (const l of wr) L.push(l.replace('### 写入点', '### ①b 写入点'))
  if (pOver.length) {
    L.push(`### ①c 指针引用（${pOver.length} 处）—— 盒的指针型实参点着这批字节`)
    L.push('')
    L.push('| 指针实参 | 所属盒 | 覆盖字节 |')
    L.push('|---|---|---|')
    for (const r of pOver) L.push(`| \`${r.name}\` | ${r.box ? `${r.box.name}@0x${r.box.off.toString(16)}` : '（盒名未对上）'} | ${r.addr}~${r.addr + r.bytes - 1}${r.count ? `（Count=${r.count}）` : '（下限）'} |`)
    L.push('')
    L.push('> 指针＝把这个地址交给盒用（如 MBUS_MSG 的 DataPtr＝&VB160）：盒会读写从它起的缓冲区，覆盖字节按盒参数推算，推不出时只算到指针类型的下限。**「直接操作数 0 处」不等于「没人用」**。')
    L.push('')
  } else if (pAll === null) {
    L.push('> ⚠ 本次没做指针扫描（已解码目录模式拿不到原始字节）—— `&地址` 这类引用要拿 .smart 原文件跑。')
    L.push('')
  }
  const overlap = new Map()
  for (const r of records) {
    for (const o of (r.operands ?? [])) {
      if (o === target) continue
      const p = parseOperandAddr(o)
      if (!p || p.area !== t.area) continue
      if (p.base > t.base + t.len - 1 || p.base + p.len - 1 < t.base) continue
      // 修正：目标本身是位时，同字节的"其它位"互不影响（Q1.0 与 Q1.7 不冲突），只列真正包含它的字节/字/双字
      if (t.kind === '位' && p.kind === '位') continue
      if (!overlap.has(o)) overlap.set(o, new Set())
      overlap.get(o).add(`${r.pou}@${r.off}`)
    }
  }
  L.push(`### ② 与 ${target} 共用同一批字节的其它地址形式（重叠体检）`)
  L.push('')
  if (!overlap.size) {
    if (pOver.length) L.push(`> 直接操作数无重叠，但这批字节被指针实参点着（见 ①c）—— 缓冲区覆盖范围更大，别当干净地址用。`)
    else L.push(`> 无。${target} 占的字节没有被别的形式（位/字节/字/双字）访问过 —— 单看地址是干净的。`)
  } else {
    L.push('| 地址形式 | 类型 | 占用字节 | 引用点 |')
    L.push('|---|---|---|---|')
    for (const [o, set] of overlap) {
      const p = parseOperandAddr(o)
      const pts = [...set]
      L.push(`| \`${o}\` | ${p.kind} | ${p.base}${p.len > 1 ? `~${p.base + p.len - 1}` : ''} | ${pts.slice(0, 6).join(' ')}${pts.length > 6 ? ` …共${pts.length}处` : ''} |`)
    }
    L.push('')
    L.push('> 判读：**写其中一个会改掉另一个的内容**（如 VD20 整体左移会把 V23.0 一起移走；反过来写 V23.0 会改掉 VD20 的第 24 位）。两者本来就是同一条移位链/同一个位组 → 正常；分属两处互不相干的功能 → 冲突。')
  }
  L.push('')
  return L.join('\n')
}

/** 写点判据：
 *  .smart 的盒记录里，"写一个位"有两种写法——① 同一盒内该地址出现两次（线圈/SET/RST 的旧值＋新值）；
 *  ② 单操作数盒（触点段）之后紧邻的盒里该地址再出现（LD … / = 同一网络行）。
 *  两者都命中才敢下结论；指令名是承前继承（带 ? 后缀）时不可信，一律降级为"疑"。
 *  用途：回答"谁把这个地址写 0／什么时候复位"——光有引用点分布答不了这个问题。 */
const WRITE_INST = new Set(['MOV_W', 'MOV_B', 'MOV_DW', 'MOV', 'SET', 'RST', 'FILL', 'SWAP',
  'MUL_I', 'MUL_DI', 'DIV_I', 'DIV_DI', 'ADD_I', 'ADD_DI', 'SUB_I', 'SUB_DI', 'INC_W', 'INC_DW', 'DEC_W', 'DEC_DW',
  'WAND_DW', 'WOR_DW', 'WXOR_DW', 'SHL_DW', 'SHR_DW', 'ROTL', 'ROTR', 'BCD_I', 'I_BCD', 'B_I', 'I_B',
  'TON', 'TOF', 'TONR', 'CTU', 'CTD', 'CTUD', 'S_ITR', 'ENI', 'DISI'])

/** 盒记录按偏移升序（写点判据要按程序顺序找"下一盒"）。 */
function sortedBoxes(records) {
  return (records ?? []).slice().sort((a, b) =>
    parseInt(String(a.off ?? '').replace(/^0x/i, ''), 16) - parseInt(String(b.off ?? '').replace(/^0x/i, ''), 16))
}

function writeVerdict(rec, target, boxes) {
  const ops = rec.operands ?? []
  const idxs = ops.map((o, i) => (o === target ? i : -1)).filter((i) => i >= 0)
  if (!idxs.length) return { mark: '—', why: '' }
  const instr = String(rec.instr ?? '')
  const inherited = instr.endsWith('?')
  const base = instr.replace(/\?$/, '')
  if (idxs.length >= 2) {
    const w = Math.max(...idxs)
    return { mark: `**写**（同盒第 ${w + 1} 位＝新值）`, why: '同一盒内出现两次：线圈／SET／RST 的旧值＋新值', write: true }
  }
  if (!inherited && WRITE_INST.has(base)) {
    return { mark: `写?（${base}）`, why: '指令名可信且属写出类指令，但这个地址是否吃掉写入结果未辨引脚，按"疑"计', write: true }
  }
  const cur = parseInt(String(rec.off ?? '').replace(/^0x/i, ''), 16)
  if (Number.isFinite(cur) && Array.isArray(boxes)) {
    // 本盒是单操作数（纯触点段）时往下找：下一个含该地址的盒 —— 线圈会这样，但条件链也会，故只标疑似
    const nb = boxes.find((b) => parseInt(String(b.off ?? '').replace(/^0x/i, ''), 16) > cur && (b.operands ?? []).includes(target))
    if (nb) {
      return { mark: '疑似写?（网点二次出现）', why: `下一盒 ${nb.off} 又出现该地址 —— 但条件链/跳转也会这样，判不了是不是写入`, write: false }
    }
  }
  return { mark: '读', why: inherited ? '承前继承的指令名不可信，且无写出证据' : '盒内无写出证据', write: false }
}

/** 写入点报告：某地址"谁在写、写它的那行为什么成立"。返回附加行数组（空＝无写点）。
 *  只把"同盒两处出现"或"指令名可信的写出类指令"写成结论；邻接二次出现只标疑似——它同时符合"使能链成对跳转"，证不死。 */
function writeReport(records, userSyms, target) {
  const hits = (records ?? []).filter((r) => (r.operands ?? []).includes(target))
  if (!hits.length) return []
  const boxes = sortedBoxes(records)
  const C = []
  for (const h of hits) {
    const v = writeVerdict(h, target, boxes)
    if (!v.write) continue
    C.push(h)
  }
  if (!C.length) return []
  const out = []
  out.push(`### 写入点（${C.length} 处）`)
  out.push('')
  out.push('| 块 | 偏移 | 盒内名称 | 判定 | 依据 |')
  out.push('|---|---|---|---|---|')
  for (const h of C) {
    const v = writeVerdict(h, target, boxes)
    const others = (h.operands ?? []).filter((o) => o !== target)
    const nm = String(h.instr ?? '')
    const nmShow = others.length ? `${nm || '—'}｜同盒: ${others.join('; ').slice(0, 60)}` : (nm || '—')
    out.push(`| ${h.pou} | \`${h.off}\` | ${nmShow} | ${v.mark.replace(/</g, '&lt;')} | ${v.why} |`)
  }
  out.push('')
  const order = []
  for (const h of C) if (!order.includes(h.pou)) order.push(h.pou)
  const susp = hits.filter((h) => !C.includes(h) && writeVerdict(h, target, boxes).mark.startsWith('疑'))
  out.push(`> 判读顺序：写在 **${order.join(' → ')}**。`)
  out.push('> 复位链看条件：同一网络行里该地址第一次出现之前的操作数是"成立条件"（触点/比较），最后一次出现是写入那一刻。')
  out.push('> 标「写?」的别当结论用——指令名可信但没辨出哪个引脚吃写入；要钉死用 `smart-pin-dump` 看该偏移的字节记录。')
  if (susp.length) out.push(`> 另有 ${susp.length} 处**疑似写**（${susp.map((h) => `${h.pou}@${h.off}`).slice(0, 8).join('、')}${susp.length > 8 ? ' …' : ''}）：该地址在网点里出现两次，但成对跳转/使能链也长这样，证不死。`)
  out.push('')
  return out
}

/** ── 梯形图元素级读/写判定（判据经字节级验证）
 *  元素描述串 `01 01 XX 00 00 00 YY 03 01`：XX=01 触点（读）、XX=02 写（线圈/带 OUT 的指令盒/S-R 线圈）；
 *  YY=01 后接地址操作数、YY=02 后接符号名记录 —— 带符号名写的元素（S/R 复位置位线圈最常见）存的是名字不是地址，
 *  只按地址扫会漏判成"程序从没写过"。本判定两者都解并回查符号表映射成地址。
 *  这是"某位到底有没有被写"的唯一权威判据；var-usage 的盒启发式只作参考。 */
const ELEM_AREA = { 1: 'I', 2: 'Q', 0x10: 'V', 0x20: 'M', 0x40: 'T', 0x80: 'C', 0x200: 'SM', 0x2000: 'L' }
const ELEM_TYPE = { 1: true, 2: true, 4: true, 8: true }

function elemAddrName(t, area, v) {
  const a = ELEM_AREA[area]
  if (t === 1) return area === 0x40 ? 'T' + v : `${a}${v >> 3}.${v & 7}`
  return `${a}${{ 2: 'B', 4: 'W', 8: 'D' }[t]}${v}`
}

function elemSymMap(data) {
  const m = new Map()
  for (let i = 0; i < data.length - 24; i++) {
    if (data[i] !== 2 || data[i + 1] !== 0) continue
    const ln = data.readUInt16LE(i + 2)
    if (!(ln > 0 && ln < 40)) continue
    if (!(data[i + 4 + ln] === 0 && data[i + 5 + ln] === 1 && data[i + 6 + ln] === 2 && data[i + 7 + ln] === 0)) continue
    const t = data[i + 8 + ln]
    if (!ELEM_TYPE[t]) continue
    const area = data.readUInt32LE(i + 9 + ln), v = data.readUInt32LE(i + 13 + ln)
    if (ELEM_AREA[area] === undefined) continue
    const nm = gbk(data.subarray(i + 4, i + 4 + ln)).replace(/\0+$/, '')
    if (nm && !m.has(nm)) m.set(nm, elemAddrName(t, area, v))
    i += 17 + ln
  }
  return m
}

function ladderElems(data, A, B, symMap) {
  const out = []
  for (let p = A; p < B - 30;) {
    if (data[p] === 1 && data[p + 1] === 1 && data[p + 3] === 0 && data[p + 4] === 0 && data[p + 5] === 0 &&
        data[p + 7] === 3 && data[p + 8] === 1) {
      const kind = data[p + 2]
      if (data[p + 6] === 1 && data[p + 18] === 2 && data[p + 19] === 0) {
        const t = data[p + 20], area = data.readUInt32LE(p + 21)
        if (ELEM_TYPE[t] && ELEM_AREA[area] !== undefined) {
          const nm = elemAddrName(t, area, data.readUInt32LE(p + 25))
          out.push({ off: p, kind, name: nm, addr: nm })
          p += 29
          continue
        }
      } else if (data[p + 6] === 2 && data[p + 18] === 1 && data[p + 19] === 0 && data[p + 20] === 1 && data[p + 21] === 0) {
        const l = data[p + 22]
        if (l > 0 && l < 60) {
          const nm = gbk(data.subarray(p + 23, p + 23 + l)).replace(/\0+$/, '')
          if (/^[\u4e00-\u9fffA-Za-z_0-9]+$/.test(nm)) {
            const addr = symMap.get(nm)
            out.push({ off: p, kind, name: addr ? `${nm} (${addr})` : nm, addr, sym: nm })
            p += 23 + l
            continue
          }
        }
      }
    }
    p++
  }
  return out
}

function elemTag(r) {
  if (r.kind === 1) return '触点（读）'
  if (r.kind !== 2) return `kind=${r.kind}`
  return r.sym ? '写（S-R 复位/置位线圈，用符号名写的）' : '写（线圈/指令盒 OUT/S-R）'
}

/** 元素级读/写判定报告。want 可以是逗号分隔的一批地址——批量就是本函数存在的理由：
 *  "这 12 个按钮位到底有没有被写"以前要 12 次调用 + 手工汇总。 */
function ladderElementsReport(data, want) {
  const wants = String(want).split(/[,，\s]+/).filter(Boolean).map(s => s.toUpperCase())
  const all = ladderElems(data, 0x900, data.length, elemSymMap(data))
  const L = []
  if (wants.length > 1) {
    L.push(`## 批量读/写判定（${wants.length} 个地址）`)
    L.push('')
    L.push('| 地址 | 写 | 读 | 落点（写在前） |')
    L.push('|---|---|---|---|')
    for (const w of wants) {
      const rows = all.filter(r => r.addr === w)
      const wc = rows.filter(r => r.kind === 2).length
      const rc = rows.filter(r => r.kind === 1).length
      const pts = rows.slice().sort((a, b) => (b.kind - a.kind) || (a.off - b.off)).map(r => `0x${r.off.toString(16).padStart(6, '0')}${r.sym ? '*' : ''}`)
      L.push(`| \`${w}\` | ${wc ? `**${wc}**` : '0'} | ${rc} | ${pts.slice(0, 8).join(' ') || '—'}${pts.length > 8 ? ` …共${pts.length}处` : ''} |`)
    }
    L.push('')
    const zero = wants.filter(w => !all.some(r => r.addr === w && r.kind === 2))
    if (zero.length) L.push(`> **程序从没写过**（只被读）：${zero.join('、')}`)
    const hasW = wants.filter(w => all.some(r => r.addr === w && r.kind === 2))
    if (hasW.length) L.push(`> 有写入的：${hasW.join('、')}——逐处明细见下。`)
    L.push('')
  }
  for (const w of wants) {
    const rows = all.filter(r => r.addr === w)
    L.push(`## ${w} —— 程序区落点 ${rows.length} 处（不含符号表/记录外）`)
    for (const r of rows) L.push(`  0x${r.off.toString(16).padStart(6, '0')}  ${elemTag(r)}${r.sym ? '  ' + r.name : ''}`)
    if (rows.length && !rows.some(r => r.kind === 2)) L.push('  → 全程序没有任何一条指令写它（只被读）')
    else if (rows.some(r => r.kind === 2 && r.sym)) L.push('  ⚠ 含"用符号名写"的元素（S/R 线圈等）——这类只按地址扫会漏判成"从没写过"')
    L.push('')
  }
  L.push('> 判据：元素 = 描述串 9B `01 01 XX 00 00 00 YY 03 01` + 实例 9B + 操作数（YY=01 地址／YY=02 符号名记录）；XX=01 触点、XX=02 写。带 `*` 的落点是符号名写的元素回查出的地址。')
  L.push('> S/R 的个数（如 R M28.0, 2）与 P/N 边沿触点在网络元数据里，本工具不解；串并联拓扑同样不解，别按元素顺序推 AND/OR。')
  return L.join('\n')
}

function ladderElementsRange(data, A, B) {
  const rows = ladderElems(data, A, B, elemSymMap(data))
  const L = rows.map(r => `0x${r.off.toString(16).padStart(6, '0')}  ${r.kind === 1 ? '触点' : r.kind === 2 ? '写  ' : 'kind=' + r.kind}  ${r.name}`)
  L.push(``, `元素 ${rows.length} 个（区间 0x${A.toString(16)}-0x${B.toString(16)}）`)
  return L.join('\n')
}

/** V 区字节重叠体检：扫全工程操作数，找出"同一批字节被两种以上地址形式访问"的组。
 *  典型隐患：一个 VD 被整体移位，其内部某个位（如 V23.0 = VD20 的 bit24）又被单独当标志读写。
 *  过滤：只扫 V 区、跳过 ≥4000 的 Modbus/库缓冲；只保留含"位"的组（纯 VB/VW/VD 之间的打包重叠属正常，不列）。 */
function vOverlapReport(records) {
  const forms = new Map()
  for (const r of records ?? []) {
    for (const o of (r.operands ?? [])) {
      const p = parseOperandAddr(o)
      if (!p || p.area !== 'V' || p.base >= 4000) continue
      if (!forms.has(o)) forms.set(o, new Set())
      forms.get(o).add(`${r.pou}@${r.off}`)
    }
  }
  const seen = new Set()
  const groups = []
  for (const o of forms.keys()) {
    if (seen.has(o)) continue
    const grp = new Set([o])
    for (let grew = true; grew;) {
      grew = false
      for (const o2 of forms.keys()) {
        if (grp.has(o2)) continue
        const q = parseOperandAddr(o2)
        for (const m of grp) {
          const p2 = parseOperandAddr(m)
          if (!(q.base > p2.base + p2.len - 1 || q.base + q.len - 1 < p2.base)) { grp.add(o2); grew = true; break }
        }
      }
    }
    for (const g of grp) seen.add(g)
    if (grp.size < 2) continue
    const arr = [...grp].sort((a, b) => parseOperandAddr(b).len - parseOperandAddr(a).len)
    // 修正：只保留"位 + 更大单位"的真重叠；纯位组（同字节不同位，如 V50.0/V50.2）互不影响，不列
    if (!(arr.some(a => parseOperandAddr(a).kind === '位') && arr.some(a => parseOperandAddr(a).len > 1))) continue
    groups.push(arr)
  }
  const L = []
  L.push('## 3.7 字节重叠体检（V 区，自动扫描）')
  L.push('')
  if (!groups.length) {
    L.push('> 未发现"位与字/双字共用同一批字节"的情况。')
    L.push('')
    return L.join('\n')
  }
  L.push('> 判定：同一批 V 区字节被两种以上地址形式访问（典型：一个 VD 被整体移位，其内部某位又被单独当标志用）。**写其中一个会改掉另一个的内容**——属同一条移位链/位组即正常，分属两处独立功能就是冲突。逐变量细查用工具 `smart-var-usage`。纯 VB/VW/VD 之间的打包重叠（含 ≥4000 的 Modbus 缓冲）不列。')
  L.push('')
  L.push('| 重叠组 | 各形式的类型与引用点 |')
  L.push('|---|---|')
  const ordered = groups.sort((a, b) => parseOperandAddr(a[a.length - 1]).base - parseOperandAddr(b[b.length - 1]).base)
  for (const g of ordered) {
    const cells = g.map(o => {
      const p = parseOperandAddr(o)
      const pts = [...(forms.get(o) ?? [])]
      return `\`${o}\`（${p.kind}）：${pts.slice(0, 3).join(' ')}${pts.length > 3 ? ` …共${pts.length}处` : ''}`
    })
    L.push(`| ${g.map(o => `\`${o}\``).join(' / ')} | ${cells.join('<br>')} |`)
  }
  L.push('')
  return L.join('\n')
}

function buildLibReport(version, vars, comments) {  const L = []
  L.push('# SMART 库文件解码报告')
  L.push('')
  L.push(`- 库版本串: ${version}`)
  L.push('')
  L.push('## 1. 库块变量/引脚名')
  L.push('')
  vars.forEach((v, k) => L.push(`${k + 1}. ${v}`))
  L.push('')
  L.push('## 2. 源码注释流（英文，片段）')
  L.push('')
  comments.forEach(c => L.push(`> ${c.replace(/\n/g, ' ')}`))
  L.push('')
  return L.join('\n')
}

// ───────────────────────── 工程版本对比 ─────────────────────────

const md5 = (p) => createHash('md5').update(readFileSync(p)).digest('hex')

function listFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort()
}

function readLines(p) {
  return readFileSync(p, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
}

function modeOf(filePath) {
  const head = readFileSync(filePath, 'utf8').slice(0, 300)
  const m = head.match(/# 模式:\s*([\w-]+)/)
  return m ? m[1] : 'unknown'
}

function isProjectFile(p) {
  return /\.project$/i.test(p) && existsSync(p)
}
function isDecodedDir(p) {
  return existsSync(p) && existsSync(join(p, 'pous'))
}

/** 归一化输入：.project → 解码目录；已解码目录 → 原样。 */
function resolveInput(p) {
  const abs = resolve(p)
  if (isProjectFile(abs)) return { kind: 'project', path: abs }
  if (isDecodedDir(abs)) return { kind: 'decoded', path: abs }
  if (existsSync(abs)) return { kind: 'invalid', reason: `既不是 .project 文件，也没有 pous\\ 子目录（不是已解码目录）: ${p}` }
  return { kind: 'invalid', reason: `路径不存在: ${p}` }
}

/** 解码 .project 到 `<工作区>\解码归档\<工程名>\导出_对比_<ts>`（diff 专用；原写工程旁）。 */
async function decodeForDiff(ctx, proj, signal, base) {
  const dir = dirname(proj)
  const outd = join(defaultArchiveDir(proj, base), `导出_对比_${timestamp()}`)
  precreateOutDir(outd)
  const result = await runPy(ctx, 'read_project.py', [proj, outd], dir, signal)
  if (!result.ok) throw new Error(result.text)
  return outd
}

/** 找两个文本的差异区段（逐行对齐，连续差异合并，±ctx 上下文）。 */
function diffRegions(oldLines, newLines, ctx = 3) {
  const max = Math.max(oldLines.length, newLines.length)
  const bad = []
  for (let i = 0; i < max; i++) {
    const a = i < oldLines.length ? oldLines[i] : null
    const b = i < newLines.length ? newLines[i] : null
    if (a !== b) bad.push(i)
  }
  const regions = []
  let i = 0
  while (i < bad.length) {
    let j = i
    while (j + 1 < bad.length && bad[j + 1] === bad[j] + 1) j++
    regions.push({ first: bad[i], last: bad[j] })
    i = j + 1
  }
  const merged = []
  for (const r of regions) {
    const last = merged.at(-1)
    if (last && r.first - last.last <= 2 * ctx + 1) last.last = r.last
    else merged.push({ ...r })
  }
  return merged.map((r) => ({
    first: r.first,
    last: r.last,
    oldLines: oldLines.slice(Math.max(0, r.first - ctx), Math.min(oldLines.length, r.last + 1 + ctx)),
    newLines: newLines.slice(Math.max(0, r.first - ctx), Math.min(newLines.length, r.last + 1 + ctx)),
  }))
}

/** 仅空白差异判定 */
function whitespaceOnly(oldLines, newLines) {
  const stripAll = (arr) => arr.map((l) => l.replace(/\s+/g, '')).join('\n')
  if (stripAll(oldLines) === stripAll(newLines)) return true
  const nonEmpty = (arr) => arr.map((l) => l.trim()).filter((l) => l.length > 0).join('\n')
  return nonEmpty(oldLines) === nonEmpty(newLines)
}

const CODE_LIKE = /(:=|IF\b|AND\b|OR\b|THEN\b|END_IF|FOR\b|CASE\b|\(CLK|PROGRAM|FUNCTION_BLOCK|VAR_|END_VAR|MC_|gb_|HSet_|DI_|DO_|HAlm_)/

const strContent = (d) => d.replace(/^\[\d+\]\s*/, '')

/** 对比两个已解码目录，返回 markdown 报告（纯函数）。 */
export function compareDecodedDirs(oldDir, newDir, opts = {}) {
  const L = []
  const push = (s = '') => L.push(s)
  const { labelOld = oldDir, labelNew = newDir, maxStrSamples = 15 } = opts

  const oldPous = join(oldDir, 'pous')
  const newPous = join(newDir, 'pous')
  const oldFiles = listFiles(oldPous)
  const newFiles = listFiles(newPous)
  const oldH = Object.fromEntries(oldFiles.map((f) => [f, md5(join(oldPous, f))]))
  const newH = Object.fromEntries(newFiles.map((f) => [f, md5(join(newPous, f))]))

  const changed = [], added = [], removed = []
  for (const f of newFiles) {
    if (oldH[f] !== undefined) {
      if (oldH[f] !== newH[f]) changed.push(f)
    } else added.push(f)
  }
  for (const f of oldFiles) if (newH[f] === undefined) removed.push(f)

  const realChanges = []
  const whitespaceOnlyFiles = []
  const noiseFiles = []

  for (const f of changed) {
    const op = join(oldPous, f)
    const np = join(newPous, f)
    const mode = modeOf(np) || modeOf(op)
    const oldLines = readLines(op)
    const newLines = readLines(np)
    if (mode === 'record-container') {
      if (whitespaceOnly(oldLines, newLines)) {
        whitespaceOnlyFiles.push(f)
      } else {
        realChanges.push({ file: f, regions: diffRegions(oldLines, newLines) })
      }
    } else {
      const regions = diffRegions(oldLines, newLines)
      noiseFiles.push({ file: f, mode, nRegions: regions.length, first: regions[0]?.first ?? -1, last: regions.at(-1)?.last ?? -1 })
    }
  }

  const strDiff = (() => {
    const op = join(oldDir, '全部字符串.txt')
    const np = join(newDir, '全部字符串.txt')
    if (!existsSync(op) || !existsSync(np)) return null
    const o = readLines(op)
    const n = readLines(np)
    const diffs = []
    const max = Math.max(o.length, n.length)
    for (let i = 0; i < max; i++) {
      const a = i < o.length ? o[i] : '<EOF>'
      const b = i < n.length ? n[i] : '<EOF>'
      if (a !== b) diffs.push({ i, old: a, new: b })
    }
    const oldResidue = diffs.filter((d) => CODE_LIKE.test(strContent(d.old)) && !CODE_LIKE.test(strContent(d.new)))
    const newText = diffs.filter((d) => CODE_LIKE.test(strContent(d.new)) && !CODE_LIKE.test(strContent(d.old)))
    const bothCode = diffs.filter((d) => CODE_LIKE.test(strContent(d.old)) && CODE_LIKE.test(strContent(d.new)))
    return {
      total: diffs.length,
      oldResidue,
      newText,
      bothCode,
      samples: diffs.slice(0, maxStrSamples),
    }
  })()

  const auxDiff = (name) => {
    const op = join(oldDir, name)
    const np = join(newDir, name)
    if (!existsSync(op) || !existsSync(np)) return null
    const o = readLines(op)
    const n = readLines(np)
    const max = Math.max(o.length, n.length)
    let cnt = 0
    const samples = []
    for (let i = 0; i < max; i++) {
      const a = i < o.length ? o[i] : ''
      const b = i < n.length ? n[i] : ''
      if (a !== b) {
        cnt++
        if (samples.length < 8) samples.push({ i, old: a, new: b })
      }
    }
    return { cnt, samples }
  }

  push('# 工程版本对比报告')
  push()
  push(`- 旧：${labelOld}`)
  push(`- 新：${labelNew}`)
  push(`- 生成：${new Date().toLocaleString('zh-CN')}`)
  push()

  push('## 1. POU 清单')
  push()
  push('| 项 | 数量 |')
  push('|---|---|')
  push(`| 旧工程对象文件 | ${oldFiles.length} |`)
  push(`| 新工程对象文件 | ${newFiles.length} |`)
  push(`| 内容变化 | ${changed.length} |`)
  push(`| 新增 | ${added.length} |`)
  push(`| 删除 | ${removed.length} |`)
  push()
  if (added.length) push(`- 新增文件：${added.join('、')}`)
  if (removed.length) push(`- 删除文件：${removed.join('、')}`)
  push()

  push('## 2. 真实逻辑变化（record-container 源码非空白差异）')
  push()
  if (realChanges.length === 0) {
    push('**未发现真实逻辑变化** —— record-container 源码（GVL/A0x/P0x/FB 等）新旧一致，或仅有空白差异。')
  } else {
    for (const rc of realChanges) {
      push(`### ${rc.file}（${rc.regions.length} 个差异区段）`)
      push()
      for (const [k, rg] of rc.regions.entries()) {
        push(`<details><summary>区段 ${k + 1}（旧行 ${rg.first + 1}–${rg.last + 1}）</summary>`)
        push()
        push('```diff')
        const ctx = Math.max(rg.oldLines.length, rg.newLines.length)
        for (let i = 0; i < ctx; i++) {
          const a = rg.oldLines[i] ?? ''
          const b = rg.newLines[i] ?? ''
          if (a === b) push(` ${a}`)
          else {
            if (a !== '') push(`-${a}`)
            if (b !== '') push(`+${b}`)
          }
        }
        push('```')
        push()
        push('</details>')
      }
    }
  }
  push()

  push('## 3. 仅空白差异（无语义变化）')
  push()
  push(whitespaceOnlyFiles.length ? `- ${whitespaceOnlyFiles.join('、')}` : '- 无')
  push()

  push('## 4. 噪音差异（fallback/task 模式，多为字符串表重建或解码索引漂移，建议人工复核）')
  push()
  if (noiseFiles.length === 0) {
    push('- 无')
  } else {
    for (const nf of noiseFiles) {
      push(`- ${nf.file}（${nf.mode}，${nf.nRegions} 区段，行 ${nf.first + 1}–${nf.last + 1}）`)
    }
  }
  push()

  push('## 5. 字符串表（全部字符串.txt，同索引对比）')
  push()
  if (strDiff === null) {
    push('- 两侧缺少 全部字符串.txt，跳过')
  } else {
    push(`- 差异条目：${strDiff.total} 条`)
    push(`- 分类：旧工程残留串（旧侧代码样）${strDiff.oldResidue.length} 条；新增文本串（新侧代码样）${strDiff.newText.length} 条；双向代码串修改 ${strDiff.bothCode.length} 条`)
    push(`- 结论指引：新增文本串与双向修改 → 说明有源码文本改动，需与第 2 节对照确认；仅旧残留串 → 多为历史编辑残留被清理，纯保存噪音。`)
    if (strDiff.newText.length) {
      push()
      push(`新增文本串（前 ${Math.min(8, strDiff.newText.length)} 条）：`)
      push()
      push('```')
      for (const d of strDiff.newText.slice(0, 8)) push(`[${d.i}] ${strContent(d.new)}`)
      push('```')
    }
    if (strDiff.samples.length) {
      push()
      push('差异样例（前若干条）：')
      push()
      push('```diff')
      for (const d of strDiff.samples) {
        push(`[${d.i}]`)
        if (d.old !== '<EOF>') push(`- ${strContent(d.old)}`)
        if (d.new !== '<EOF>') push(`+ ${strContent(d.new)}`)
      }
      push('```')
    }
  }
  push()

  push('## 6. 对象表 / 项目树')
  push()
  for (const fn of ['对象表.md', '项目树.md']) {
    const d = auxDiff(fn)
    push(`- ${fn}：${d === null ? '（缺失，跳过）' : d.cnt === 0 ? '无差异' : `${d.cnt} 行差异`}`)
    if (d && d.cnt > 0) {
      for (const s of d.samples) {
        push(`  - 行 ${s.i + 1} OLD: ${s.old || '(空)'}`)
        push(`    NEW: ${s.new || '(空)'}`)
      }
    }
  }
  push()

  const conclusion = []
  if (realChanges.length === 0 && added.length === 0 && removed.length === 0) {
    conclusion.push('**结论：程序逻辑无变化。** 差异仅来自字符串表重建 / 空白 / 解码噪音，时序图与工艺文档可保持有效。')
  } else {
    conclusion.push(`**结论：发现 ${realChanges.length} 个源码对象有真实逻辑变化${added.length ? `、${added.length} 个新增对象` : ''}${removed.length ? `、${removed.length} 个删除对象` : ''}，请按第 2 节逐项核对。`)
  }
  if (noiseFiles.length) conclusion.push(`提示：${noiseFiles.length} 个 fallback/task 文件有差异，多为解码噪音，如涉及 Modbus/设备配置建议人工复核。`)
  push(conclusion.join('\n'))
  push()

  return L.join('\n')
}

/** diff 工具核心动作：归一化两个输入并产报告。 */
async function runDiff(ctx, oldP, newP, signal, base) {
  const ro = resolveInput(oldP)
  const rn = resolveInput(newP)
  if (ro.kind === 'invalid') throw new Error(`old 无效：${ro.reason}`)
  if (rn.kind === 'invalid') throw new Error(`new 无效：${rn.reason}`)
  const decodedOld = ro.kind === 'project' ? await decodeForDiff(ctx, ro.path, signal, base) : ro.path
  const decodedNew = rn.kind === 'project' ? await decodeForDiff(ctx, rn.path, signal, base) : rn.path
  const notes = []
  if (ro.kind === 'project') notes.push(`旧工程已解码到：${decodedOld}`)
  if (rn.kind === 'project') notes.push(`新工程已解码到：${decodedNew}`)
  const report = compareDecodedDirs(decodedOld, decodedNew, {
    labelOld: ro.kind === 'project' ? `${ro.path}（本次解码）` : ro.path,
    labelNew: rn.kind === 'project' ? `${rn.path}（本次解码）` : rn.path,
  })
  return { notes, report }
}

// ───────────────────────── 应用注册 ─────────────────────────

export function apply(ctx, config = {}) {
  // 2026-11-05：读插件配置的归档根目录（config.archiveDir）。不配置时保持旧行为不变。
  const cfg = config && typeof config === 'object' ? config : {}
  if (typeof cfg.archiveDir === 'string' && cfg.archiveDir.trim()) ARCHIVE_ROOT = cfg.archiveDir.trim()

  // 触摸屏（HMI）工程解码：画面/控件/变量/地址，与 PLC 侧共用同一插件行（hmi.js）。
  registerHmi(ctx)

  // ── 工具一：统一入口（四格式自动识别分发）──
  ctx.tools.register({
    name: 'plc-decode',
    description: 'PLC 工程文件统一解码入口：自动识别四格式并分发解码——.project(CoDeSys/LeadSysStudio，含雷赛 ZIP)、.dvp(台达 WPLSoft/ISPSoft)、.smart(西门子 S7-200 SMART 工程)、.smartlib(西门子 SMART 库)。提供任一 PLC 工程文件、要求读取/理解/核对其中程序时调用。触摸屏工程（.hmismart/.fsprj）不在本插件范围，用 HMI 解码工具。只读，不改动工程文件。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'PLC 工程文件路径（.project/.dvp/.smart/.smartlib，绝对路径或相对当前工作目录）。' },
        outDir: { type: 'string', description: '可选：输出目录；缺省写到「<归档根>\\<工程所在文件夹名>\\」（归档根默认「解码归档」，可用插件配置 archiveDir 改，见 /plc-archive；四格式一致，不写工程目录）。' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['ok', 'text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const file = typeof args.file === 'string' ? args.file.trim() : ''
      if (!file) throw new Error('参数 file 不能为空')
      const abs = resolve(file)
      if (!existsSync(abs)) throw new Error(`文件不存在: ${file}`)
      const outDir = typeof args.outDir === 'string' && args.outDir.trim() ? resolve(args.outDir.trim()) : undefined
      const { kind } = identify(abs)
      if (kind === 'project' || kind === 'dvp') {
        const result = await decodeCodesysProject(ctx, abs, exec.signal, exec, outDir, sessionBase(exec?.agent))
        const tail = String(result.kind).includes('加密') ? '00-目录.md' : '00-索引.md'
        return { ok: true, text: `已解码完成（类型: ${result.kind}）\n输出目录: ${result.outd}\n${result.text}\n下一步: 先读 ${join(result.outd, tail)}` }
      }
      if (kind === 'hmismart') {
        throw new Error(
          '这是触摸屏（HMI）工程，不在本插件的范围：\n'
          + '· .hmismart（西门子 WinCC flexible SMART）请用 HMI 解码工具\n'
          + '· .fsprj 或含 HMI\\Frame 的 FStudio 工程目录请用触摸屏工程工具\n'
          + '本插件（plc-decode）只处理 PLC 工程：.project / .dvp / .smart / .smartlib。'
        )
      }
      const result = kind === 'smart' ? decodeSmartFile(abs, outDir, sessionBase(exec?.agent)) : decodeSmartLib(abs, outDir, sessionBase(exec?.agent))
      return { ok: true, text: `已解码完成（类型: ${kind}）:\n${result.proceed}` }
    },
  })

  // ── 工具二：SMART 子程序内部结构解析（讲解「XX 子程序怎么写」用）──
  // ── 工具四·B：SMART 子程序内部结构解析（讲解"XX 子程序怎么写"用）──
  ctx.tools.register({
    name: 'smart-pou-structure',
    description: '解析西门子 S7-200 SMART 工程(.smart)中某个子程序的内部结构：接口参数（L 区地址+类型）、盒级指令链（指令名/引脚/操作数/符号名，按偏移顺序）、调用点及实参。用户问"XX 子程序是怎么写的/内部怎么实现/帮我讲解子程序"时调用。只读，不改动工程文件。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '.smart 文件路径（绝对路径或相对工作目录）。' },
        pou: { type: 'string', description: '可选：块名；缺省输出全部块的结构（较长，建议指定块名）。' },
        outDir: { type: 'string', description: '可选：报告另存目录；缺省只在返回文本里给报告，不落盘。' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['ok', 'text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const file = typeof args.file === 'string' ? args.file.trim() : ''
      if (!file) throw new Error('参数 file 不能为空')
      const abs = resolve(file)
      if (!existsSync(abs)) throw new Error(`文件不存在: ${file}`)
      const pouFilter = typeof args.pou === 'string' && args.pou.trim() ? args.pou.trim() : undefined
      const { report } = decodeSmartPouStructure(abs, pouFilter)
      const outDir = typeof args.outDir === 'string' && args.outDir.trim() ? resolve(args.outDir.trim()) : undefined
      if (outDir) {
        mkdirSync(outDir, { recursive: true })
        const name = pouFilter ? `${pouFilter}_内部结构.md` : '全部子程序_内部结构.md'
        writeFileSync(join(outDir, name), report, 'utf8')
        return { ok: true, text: `${report}\n\n---\n报告已存: ${join(outDir, name)}` }
      }
      return { ok: true, text: report }
    },
  })

  // ── 工具五：新旧工程对比（.project / 已解码目录）──
  ctx.tools.register({
    name: 'codesys-diff-project',
    description: '对比新旧两个 CoDeSys/LeadSysStudio 工程（各自可为 .project 或已解码目录），输出逻辑变化报告：POU 清单/真实逻辑变化差异区段/空白差异/字符串表/对象表对比，自动区分真实逻辑变化与保存噪音（字符串表重建、空白、解码索引漂移）。',
    parameters: {
      type: 'object',
      properties: {
        old: {
          type: 'string',
          description: '旧工程：.project 文件路径，或已解码目录路径（含 pous\\ 与 全部字符串.txt）。',
        },
        new: {
          type: 'string',
          description: '新工程：.project 文件路径，或已解码目录路径。',
        },
      },
      required: ['old', 'new'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['ok', 'text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const oldP = String(args.old ?? '').trim()
      const newP = String(args.new ?? '').trim()
      if (!oldP || !newP) throw new Error('参数 old / new 不能为空')
      const { notes, report } = await runDiff(ctx, oldP, newP, exec.signal, sessionBase(exec?.agent))
      return { ok: true, text: notes.length ? `${notes.join('\n')}\n\n${report}` : report }
    },
  })

  // ── 工具六：SMART 新旧工程对比 ──
  ctx.tools.register({
    name: 'smart-diff-project',
    description: '对比新旧两个西门子 S7-200 SMART 工程(.smart)，输出逻辑变化报告：块清单差异/主程序调用链对比(调用盒内嵌块名)/I-O 引用对比(按块)/符号表差异。用于"旧机改新机、对比移植、校验改错"类任务。只读，不改动工程文件。',
    parameters: {
      type: 'object',
      properties: {
        old: { type: 'string', description: '旧工程 .smart 文件路径（绝对路径或相对工作目录）。' },
        new: { type: 'string', description: '新工程 .smart 文件路径。' },
        outDir: { type: 'string', description: '可选：输出目录；缺省写到「<归档根>\\<新工程所在文件夹名>\\」（归档根默认「解码归档」，可用插件配置 archiveDir 改）。' },
      },
      required: ['old', 'new'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['ok', 'text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const oldP = String(args.old ?? '').trim()
      const newP = String(args.new ?? '').trim()
      if (!oldP || !newP) throw new Error('参数 old / new 不能为空')
      for (const q of [oldP, newP]) {
        const ab = resolve(q)
        if (!existsSync(ab)) throw new Error(`文件不存在: ${q}`)
      }
      const outDir = typeof args.outDir === 'string' && args.outDir.trim() ? resolve(args.outDir.trim()) : undefined
      const { proceed, report } = smartDiff(resolve(oldP), resolve(newP), outDir, sessionBase(exec?.agent))
      return { ok: true, text: `${proceed}\n\n${report}` }
    },
  })

  // ── 工具七：SMART 地址空闲分析（加功能前的地址规划）──
  ctx.tools.register({
    name: 'smart-free-space',
    description: '西门子 S7-200 SMART 工程地址占用与空闲段分析：输出 ①有符号名清单（含"备用"类预留坑，一律勿动）②程序已引用清单 ③真正空闲段（无名字+无引用+连续）。用于"在已有工程上加功能、按工程习惯规划新地址"类任务。只读，不改动工程文件。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '.smart 工程文件路径（绝对或相对工作目录）；或已解码目录路径（含 解码报告.md 与 记录.json）。' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['ok', 'text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const p = String(args.file ?? '').trim()
      if (!p) throw new Error('参数 file 不能为空')
      const abs = resolve(p)
      if (!existsSync(abs)) throw new Error(`文件不存在: ${p}`)
      const isDir = existsSync(join(abs, '记录.json')) && existsSync(join(abs, '解码报告.md'))
      let records, userSyms, ptrRefs = null
      if (isDir) {
        const j = JSON.parse(readFileSync(join(abs, '记录.json'), 'utf8'))
        records = j.records ?? []
        userSyms = [...(j.userSyms ?? [])]
      } else {
        const o = parseSmartOnce(abs)
        records = o.records
        userSyms = o.userSyms
        try { const { data } = decodeContainer(readFileSync(abs)); ptrRefs = scanPtrRefs(data) } catch { ptrRefs = null }
      }
      return { ok: true, text: `地址占用与空闲段分析（${isDir ? '已解码目录' : basename(abs)}）:\n${freeSpaceReport(userSyms, records, ptrRefs)}` }
    },
  })

  // ── 工具：地址冲突体检（重叠 + 连续空间不足）──
  ctx.tools.register({
    name: 'smart-conflict',
    description: '西门子 S7-200 SMART 地址冲突体检（两个口径）：①**重叠冲突**——两个不同身份的变量压在同一批字节（A级=双方都有符号名，真冲突；B级=双方都已引用、至少一方无名，疑似；C级=仅符号表登记）；②**连续空间不足（碎片）**——某个连续空闲区长度不是 4 的整数倍时，尾部那几字节放不下双字、永久浪费（旧检测只有重叠一维，会漏掉这种）。还可给 needDoubles 参数直接推荐候选地址。用于"某地址能不能用/还有哪些地址有冲突/加变量该放哪"类问题。只读，不改动工程文件。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '.smart 工程文件路径（绝对或相对工作目录）；或已解码目录（含 记录.json 与 解码报告.md）。' },
        needDoubles: { type: 'number', description: '可选：要放几个双字（VD）。给了就额外输出候选地址推荐，优先选所在空闲段最小的（碎渣最少）。' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['ok', 'text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const p = String(args.file ?? '').trim()
      if (!p) throw new Error('参数 file 不能为空')
      const abs = resolve(p)
      if (!existsSync(abs)) throw new Error(`文件不存在: ${p}`)
      const isDir = existsSync(join(abs, '记录.json')) && existsSync(join(abs, '解码报告.md'))
      let records, userSyms, ptrRefs = null
      if (isDir) {
        const j = JSON.parse(readFileSync(join(abs, '记录.json'), 'utf8'))
        records = j.records ?? []
        userSyms = [...(j.userSyms ?? [])]
      } else {
        const o = parseSmartOnce(abs)
        records = o.records
        userSyms = o.userSyms
        try { const { data } = decodeContainer(readFileSync(abs)); ptrRefs = scanPtrRefs(data) } catch { ptrRefs = null }
      }
      const need = Number(args.needDoubles ?? 0) || 0
      const body = conflictReport(userSyms, records, ptrRefs, need, 4096)
      return { ok: true, text: `地址冲突体检（${isDir ? '已解码目录' : basename(abs)}）:\n${body}` }
    },
  })

  // ── 工具八：变量使用体检（查某变量用在哪、和谁共用字节）──
  ctx.tools.register({
    name: 'smart-var-usage',
    description: '西门子 S7-200 SMART 变量使用体检：给一个地址（VD20/VW220/VB5/V20.0/M10.0），输出 ①它的全部引用点（块+偏移+同盒其它操作数+盒内实名指令）②与它共用同一批字节的其它地址形式（位/字节/字/双字重叠体检）③符号名 ④**写入点判定**（谁在写这个地址：线圈/SET/RST 由"同盒出现两次"或"网点二次出现"定死，指令名可信的写出类指令标"写?"，并给出块内判读顺序与复位链看条件的方法）。用于回答"某变量这样用有没有问题/都在哪用到/**谁在写它、什么时候复位**"。只读，不改动工程文件。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '.smart 工程文件路径，或已解码目录（含 记录.json 与 解码报告.md）。' },
        target: { type: 'string', description: '要体检的地址，如 VD20、VW220、V20.0、M10.0。' },
      },
      required: ['file', 'target'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['ok', 'text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const p = String(args.file ?? '').trim()
      const target = String(args.target ?? '').trim().toUpperCase()
      if (!p) throw new Error('参数 file 不能为空')
      if (!target) throw new Error('参数 target 不能为空（如 VD20）')
      const abs = resolve(p)
      if (!existsSync(abs)) throw new Error(`文件不存在: ${p}`)
      const isDir = existsSync(join(abs, '记录.json')) && existsSync(join(abs, '解码报告.md'))
      let records, userSyms, elemRows, ptrRefs = null
      if (isDir) {
        const j = JSON.parse(readFileSync(join(abs, '记录.json'), 'utf8'))
        records = j.records ?? []
        userSyms = [...(j.userSyms ?? [])]
      } else {
        const o = parseSmartOnce(abs)
        records = o.records
        userSyms = o.userSyms
        try {
          const { data } = decodeContainer(readFileSync(abs))
          elemRows = ladderElems(data, 0x900, data.length, elemSymMap(data))
          ptrRefs = scanPtrRefs(data) // 指针实参（&地址）单独一套编码，不扫它会把被指针点着的地址报成"0 引用"
        } catch { elemRows = null }
      }
      return { ok: true, text: `变量使用体检（${isDir ? '已解码目录' : basename(abs)}）:\n${varUsageReport(records, userSyms, target, elemRows, ptrRefs)}` }
    },
  })

  // ── 工具九：字节级引脚/操作数定位──
  ctx.tools.register({
    name: 'smart-pin-dump',
    description: '西门子 S7-200 SMART 字节级定位：① 给地址（VW220／VD390／M30.0）→ 列出它在工程文件里的全部字节出现位置与每处所在记录的操作数序列；② 给偏移区间（十六进制）→ 按记录列出该区间的操作数流与常数原文。用于回答"算出来的值有没有下游读者""两个盒为什么写同一个地址"这类引脚级问题。**判"某位到底有没有被写"别用本工具**——它按操作数间隔切盒，线圈会被报成"单操作数盒（触点）"，且用符号名写的元素（S/R 线圈等）看不到；判读/写请用 smart-ladder-elements。只读，不改动工程文件。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '.smart 工程文件路径。' },
        addr: { type: 'string', description: '要定位的地址，如 VW220、VD390、M30.0（与 from/to 二选一）。' },
        from: { type: 'string', description: '区间起点，十六进制偏移，如 C3F0。' },
        to: { type: 'string', description: '区间终点，十六进制偏移，如 C560。' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['ok', 'text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const p = String(args.file ?? '').trim()
      if (!p) throw new Error('参数 file 不能为空')
      const abs = resolve(p)
      if (!existsSync(abs)) throw new Error(`文件不存在: ${p}`)
      const { data } = decodeContainer(readFileSync(abs))
      const addr = String(args.addr ?? '').trim()
      if (addr) {
        const recs = pinRecords(data, 0, data.length)
        return { ok: true, text: `字节级定位（${basename(abs)}）:\n${pinDumpAddr(data, recs, addr)}` }
      }
      const from = parseInt(String(args.from ?? '').replace(/^0x/i, ''), 16)
      const to = parseInt(String(args.to ?? '').replace(/^0x/i, ''), 16)
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error('需要 addr，或给出有效的 from/to（十六进制）')
      return { ok: true, text: `字节级区间导出（${basename(abs)}）:\n${pinDumpRange(data, from, to)}` }
    },
  })

  // ── 工具十一：盒级引脚表──
  ctx.tools.register({
    name: 'smart-box-pins',
    description: '西门子 S7-200 SMART 盒级引脚表：按偏移区间（或整块）列出每个库调用盒（MBUS_CTRL／MBUS_MSG／TON／CTU／MOV_* 等）的「引脚名 = 实参」，把实参直接对到引脚上，不必再回读字节。由调用盒名 + 引脚序号 + 标准库引脚表解出；引脚序号判不出就跳过、超表就回落成「引脚#N」。只读，不改动工程文件。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '.smart 工程文件路径。' },
        from: { type: 'string', description: '区间起点，十六进制偏移（如 5DC8）。' },
        to: { type: 'string', description: '区间终点，十六进制偏移（如 9000）。' },
      },
      required: ['file', 'from', 'to'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['ok', 'text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const p = String(args.file ?? '').trim()
      if (!p) throw new Error('参数 file 不能为空')
      const abs = resolve(p)
      if (!existsSync(abs)) throw new Error(`文件不存在: ${p}`)
      const { data } = decodeContainer(readFileSync(abs))
      const from = parseInt(String(args.from ?? '').replace(/^0x/i, ''), 16)
      const to = parseInt(String(args.to ?? '').replace(/^0x/i, ''), 16)
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error('需要有效的 from/to（十六进制）')
      return { ok: true, text: `盒级引脚表（${basename(abs)}）:\n${boxPinout(data, from, to)}` }
    },
  })

  // ── 工具十：梯形图元素级读/写判定（判定函数已提到模块级，供 var-usage 共用）──
  ctx.tools.register({
    name: 'smart-ladder-elements',
    description: '西门子 S7-200 SMART 梯形图元素级读/写判定：给一个地址或**一批地址**（逗号分隔，如 M29.0,M29.1,M29.2）→ 批量给"每个地址几处写、几处读、落点在哪"的表，并列出每处是「触点（读）」还是「写（线圈、带 OUT 的指令盒、S-R 置位复位线圈）」；用符号名写的元素一并解出并回查符号表映射成地址。用于回答"这些位到底有没有被写""模式切换时是谁把它复位的"这类引用分布与字节定位都答不准的问题——带符号名的元素（S/R 线圈最常见）存的是名字不是地址，只按地址扫会漏判成"从没写过"。给 from/to 时按偏移顺序列出该段全部元素。只读，不改动工程文件。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '.smart 工程文件路径。' },
        addr: { type: 'string', description: '要判的地址，如 M28.2、VW220、M30.0；**一批地址用逗号分隔**（如 M29.0,M29.1,M29.2），批量会先出一张"每个地址几处写/几处读"的表（与 from/to 二选一）。' },
        from: { type: 'string', description: '区间起点，十六进制偏移（如 1E59）。' },
        to: { type: 'string', description: '区间终点，十六进制偏移（如 5DC8）。' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['ok', 'text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const p = String(args.file ?? '').trim()
      if (!p) throw new Error('参数 file 不能为空')
      const abs = resolve(p)
      if (!existsSync(abs)) throw new Error(`文件不存在: ${p}`)
      const { data } = decodeContainer(readFileSync(abs))
      const addr = String(args.addr ?? '').trim().toUpperCase()
      if (addr) return { ok: true, text: `元素级读/写判定（${basename(abs)}）:\n${ladderElementsReport(data, addr)}` }
      const from = parseInt(String(args.from ?? '').replace(/^0x/i, ''), 16)
      const to = parseInt(String(args.to ?? '').replace(/^0x/i, ''), 16)
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error('需要 addr，或给出有效的 from/to（十六进制）')
      return { ok: true, text: `梯形图元素序列（${basename(abs)}）:\n${ladderElementsRange(data, from, to)}` }
    },
  })

  // ── 工具十一：网络级轨迹（触点／写元件／指令盒合到同一偏移轴；走 assets/smart-net-trace.mjs）──
  ctx.tools.register({
    name: 'smart-net-trace',
    description: '西门子 S7-200 SMART 网络级轨迹：给偏移区间，按偏移顺序把这一段里的「触点（读）／写元件（线圈、带 OUT 的盒、S-R）／指令盒（指令名 + 引脚名 + 操作数 + 常数）／常数」合成一条可读轨迹。**要看串/并联与边沿请用 `smart-lad`（那条已解出、可出 LD/A/O/LPS/LRD/LPP）**；本工具只给元件先后与端点号，别按先后推 AND/OR。只读，不改动工程文件。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '.smart 工程文件路径。' },
        from: { type: 'string', description: '区间起点，十六进制偏移（如 5DC8）。' },
        to: { type: 'string', description: '区间终点，十六进制偏移（如 9000）。' },
        raw: { type: 'boolean', description: 'true 时连每个指令盒窗口的原始 hex 一起打印（核对引脚归属时用）。' },
      },
      required: ['file', 'from', 'to'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['ok', 'text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const p = String(args.file ?? '').trim()
      if (!p) throw new Error('参数 file 不能为空')
      const abs = resolve(p)
      if (!existsSync(abs)) throw new Error(`文件不存在: ${p}`)
      const from = String(args.from ?? '').replace(/^0x/i, '')
      const to = String(args.to ?? '').replace(/^0x/i, '')
      if (!/^[0-9a-fA-F]+$/.test(from) || !/^[0-9a-fA-F]+$/.test(to)) throw new Error('需要有效的 from/to（十六进制偏移）')
      const script = join(ASSETS_DIR, 'smart-net-trace.mjs')
      if (!existsSync(script)) throw new Error(`插件资源缺失: ${script}`)
      const policy = ctx.sandboxPolicy && exec && exec.agent
        ? ctx.sandboxPolicy.resolve({ session: exec.agent.session })
        : undefined
      const spec = ctx.shell.resolve({
        command: `& node ${psq(script)} ${psq(abs)} ${from} ${to}${args.raw ? ' --raw' : ''}`,
        workdir: dirname(abs),
        timeoutMs: TIMEOUT_MS,
        ...policy ? { sandboxPolicy: policy } : {},
        ...exec && exec.signal ? { signal: exec.signal } : {},
      })
      const res = await shellResult(ctx, spec)
      const out = String(res.stdout?.text ?? '').trim()
      const err = String(res.stderr?.text ?? '').trim()
      if (res.exitCode !== 0) throw new Error(`网络轨迹脚本退出码 ${res.exitCode}\n${err || out || '(无输出)'}`)
      return { ok: true, text: `网络级轨迹（${basename(abs)} 0x${from}-0x${to}）:\n${out}` }
    },
  })

  // ── 工具十二：从 .smart 直接还原 LAD 指令序列（= 串/并联连线，不必导出 STL）──
  ctx.tools.register({
    name: 'smart-lad',
    description: '西门子 S7-200 SMART 连线还原（指令序列）：直接读 .smart，按块、按网络打印该段的 LAD 指令序列——LD／A／O／AN／ON（触点串联/并联/常闭）、EU／ED（上升/下降沿）、LPS／LRD／LPP（并联支路）、＝／S／R（线圈）、比较（LDW>／OW< 等，含第二个操作数）与指令盒占位。序号即指令位次。用它回答"这段怎么串并联、哪几条是并联支路、边沿在哪"，**不必让用户从软件导出 STL**（已用导出的 STL 逐网络回归：主程序 17/17 完全一致）。只读，不改动工程文件。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '.smart 工程文件路径。' },
        block: { type: 'string', description: '可选：块名（如 主程序／自动）；不填则输出全部块。' },
        net: { type: 'string', description: '可选：只看该块的第 N 个网络（配合 block 用）。' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['ok', 'text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const p = String(args.file ?? '').trim()
      if (!p) throw new Error('参数 file 不能为空')
      const abs = resolve(p)
      if (!existsSync(abs)) throw new Error(`文件不存在: ${p}`)
      const script = join(ASSETS_DIR, 'smart-lad.mjs')
      if (!existsSync(script)) throw new Error(`插件资源缺失: ${script}`)
      const block = String(args.block ?? '').trim()
      const net = String(args.net ?? '').trim()
      const policy = ctx.sandboxPolicy && exec && exec.agent
        ? ctx.sandboxPolicy.resolve({ session: exec.agent.session })
        : undefined
      const spec = ctx.shell.resolve({
        command: `& node ${psq(script)} ${psq(abs)}${block ? ' ' + psq(block) : ''}${net ? ' --net=' + psq(net) : ''}`,
        workdir: dirname(abs),
        timeoutMs: TIMEOUT_MS,
        ...policy ? { sandboxPolicy: policy } : {},
        ...exec && exec.signal ? { signal: exec.signal } : {},
      })
      const res = await shellResult(ctx, spec)
      const out = String(res.stdout?.text ?? '').trim()
      const err = String(res.stderr?.text ?? '').trim()
      if (res.exitCode !== 0) throw new Error(`连线还原脚本退出码 ${res.exitCode}\n${err || out || '(无输出)'}`)
      return { ok: true, text: `LAD 指令序列（${basename(abs)}${block ? ' · ' + block : ''}）:\n${out}` }
    },
  })

  ctx.commands.register({
    name: 'smart-lad',
    description: 'S7-200 SMART 连线还原：打印某块每网络的 LAD 指令序列（串/并联/边沿/比较/盒）',
    input: { hint: '<工程.smart> [块名] [网络号]' },
    handler: async ({ rawInput }) => {
      try {
        const [file, block, net] = splitArgs(rawInput)
        if (!file) throw new Error('用法: /smart-lad <工程.smart> [块名] [网络号]')
        const abs = resolve(file)
        if (!existsSync(abs)) throw new Error(`文件不存在: ${file}`)
        const script = join(ASSETS_DIR, 'smart-lad.mjs')
        if (!existsSync(script)) throw new Error(`插件资源缺失: ${script}`)
        const spec = ctx.shell.resolve({
          command: `& node ${psq(script)} ${psq(abs)}${block ? ' ' + psq(block) : ''}${net ? ' --net=' + psq(net) : ''}`,
          workdir: dirname(abs),
          timeoutMs: TIMEOUT_MS,
        })
        const res = await shellResult(ctx, spec)
        const out = String(res.stdout?.text ?? '').trim()
        const err = String(res.stderr?.text ?? '').trim()
        if (res.exitCode !== 0) throw new Error(err || out || '脚本失败')
        return out
      } catch (e) {
        return `连线还原失败: ${e.message}`
      }
    },
  })

  ctx.commands.register({
    name: 'smart-ladder',
    description: 'S7-200 SMART 梯形图元素级读/写判定（某地址的全部落点 + 每处是触点还是写）',
    input: { hint: '<工程.smart> <地址，如 M28.2｜起hex 止hex>' },
    handler: async ({ rawInput }) => {
      try {
        const [file, a2, a3] = splitArgs(rawInput)
        if (!file) throw new Error('用法: /smart-ladder <工程.smart> <地址 | 起hex 止hex>')
        const abs = resolve(file)
        if (!existsSync(abs)) throw new Error(`文件不存在: ${file}`)
        const { data } = decodeContainer(readFileSync(abs))
        if (a2 && !/^[0-9a-fA-F]{3,8}$/.test(a2)) {
          return { kind: 'success', text: `元素级读/写判定（${basename(abs)}）:\n${ladderElementsReport(data, a2.toUpperCase())}` }
        }
        const from = parseInt(String(a2 || '').replace(/^0x/i, ''), 16)
        const to = parseInt(String(a3 || '').replace(/^0x/i, ''), 16)
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error('第二个参数应是地址，或给出"起hex 止hex"')
        return { kind: 'success', text: `梯形图元素序列（${basename(abs)}）:\n${ladderElementsRange(data, from, to)}` }
      } catch (error) {
        return { kind: 'error', text: (error instanceof Error ? error.message : String(error)) + '\n\n' + FEEDBACK_HINT }
      }
    },
  })

  // ── 命令 ──
  ctx.commands.register({
    name: 'plc-archive',
    description: '查看解码归档地址：当前生效的根目录、默认落点、怎么改配置',
    input: { hint: '（无参数）' },
    handler: async () => ({
      kind: 'success',
      text: [
        `当前生效的归档根目录: ${ARCHIVE_ROOT}`,
        `解析方式: ${isAbsolute(ARCHIVE_ROOT) ? '绝对路径，原样使用' : `相对路径，按会话工作区解析（本进程 cwd = ${process.cwd()}）`}`,
        '默认落点: <归档根>\\<工程文件所在文件夹名>\\（同一文件夹里有多个工程文件时用 <文件夹名>_<文件名>）',
        '',
        '改配置（改完重启 dsh 生效）：在 DSH profile 的 cordis.patch.yml 里给本插件那行加 config：',
        '  - id: dsh-plc-decode',
        '    name: dsh-plc-decode',
        '    config:',
        '      archiveDir: D:/plc/解码归档',
        '',
        '只改这一次、不写配置：解码时传 outDir 参数（工具参数或 /plc-decode 的第二个参数）。',
      ].join('\n'),
    }),
  })

  ctx.commands.register({
    name: 'plc-decode',
    description: 'PLC 工程统一解码入口（自动识别 .project/.dvp/.smart/.smartlib）',
    input: { hint: '<工程文件路径> [输出目录]' },
    handler: async ({ rawInput, signal, agent }) => {
      try {
        const parts = splitArgs(rawInput)
        const file = parts[0]
        const outDir = parts[1] ? resolve(parts[1]) : undefined
        if (!file) return ({ kind: 'error', text: '用法: /plc-decode <工程文件路径> [输出目录]' })
        const abs = resolve(file)
        if (!existsSync(abs)) return ({ kind: 'error', text: `文件不存在: ${file}` })
        const { kind } = identify(abs)
        if (kind === 'project' || kind === 'dvp') {
          // 注意：原来把 dirname(abs) 当 signal 传（实参错位），且返回值取的是 smart 专用的 proceed → 显示 undefined
          const r = await decodeCodesysProject(ctx, abs, signal, undefined, outDir, sessionBase(agent))
          return ({ kind: 'success', text: `已解码完成（类型: ${kind}）\n输出目录: ${r.outd}\n${r.text}` })
        }
        const result = kind === 'smart' ? decodeSmartFile(abs, outDir, sessionBase(agent)) : decodeSmartLib(abs, outDir, sessionBase(agent))
        return ({ kind: 'success', text: `已解码完成（类型: ${kind}）:\n${result.proceed}` })
      } catch (error) {
        return ({ kind: 'error', text: (error instanceof Error ? error.message : String(error)) + '\n\n' + FEEDBACK_HINT })
      }
    },
  })

  ctx.commands.register({
    name: 'codesys-read',
    description: '解码 .project / .dvp 工程（.project→ST 源码与报告；.dvp→解码报告）',
    input: { hint: '<工程.project/.dvp 路径>' },
    handler: async ({ rawInput, signal }) => {
      const [proj] = splitArgs(rawInput)
      try {
        const { outd, kind, text } = await decodeCodesysProject(ctx, proj, signal)
        const tail = kind === 'dvp'
          ? `解码报告在 ${outd}\\解码报告.md`
          : `源码在 ${outd}\\pous\\ 下（看程序读它），索引在 ${outd}\\00-索引.md`
        return { kind: 'success', text: `已解码完成，输出目录:\n${outd}\n\n${text}\n\n${tail}` }
      } catch (error) {
        return { kind: 'error', text: (error instanceof Error ? error.message : String(error)) + '\n\n' + FEEDBACK_HINT }
      }
    },
  })

  ctx.commands.register({
    name: 'dvp-read',
    description: '解码台达 DVP 工程为结构与指令表报告',
    input: { hint: '<工程.dvp 路径>' },
    handler: async ({ rawInput, signal }) => {
      const [dvp] = splitArgs(rawInput)
      try {
        const { text } = await decodeDvpText(ctx, dvp, signal)
        return { kind: 'success', text }
      } catch (error) {
        return { kind: 'error', text: (error instanceof Error ? error.message : String(error)) + '\n\n' + FEEDBACK_HINT }
      }
    },
  })

  ctx.commands.register({
    name: 'codesys-check',
    description: '解码 .project 工程后做等价编译静态校验（结构体/调用/地址唯一/未声明符号；.dvp 暂不支持校验）',
    input: { hint: '<工程.project 路径>' },
    handler: async ({ rawInput, signal, agent }) => {
      const [proj] = splitArgs(rawInput)
      try {
        const { abs, dir, kind } = requireProject(proj, '用法: /codesys-check <工程.project 路径>')
        if (kind === 'dvp') throw new Error('校验仅支持 .project（CoDeSys V3.5）工程；.dvp 请用 /codesys-read 解码。')
        const outd = join(defaultArchiveDir(abs, sessionBase(agent)), `导出_校验_${timestamp()}`)
        precreateOutDir(outd)
        const read = await runPy(ctx, 'read_project.py', [abs, outd], dir, signal)
        if (!read.ok) throw new Error(read.text)
        const check = await runPy(ctx, 'check_project.py', [join(outd, 'pous')], dir, signal)
        if (!check.ok) throw new Error(check.text)
        return { kind: 'success', text: `校验完成（源码目录 ${outd}）:\n\n${check.text}` }
      } catch (error) {
        return { kind: 'error', text: (error instanceof Error ? error.message : String(error)) + '\n\n' + FEEDBACK_HINT }
      }
    },
  })

  ctx.commands.register({
    name: 'smart-conflict',
    description: '地址冲突体检：重叠冲突（A/B/C 级）+ 连续空间被切碎（P 级碎片），可给「要放几个双字」出候选地址',
    input: { hint: '<.smart 路径> [要放的双字个数]' },
    handler: async ({ rawInput, agent }) => {
      try {
        const parts = splitArgs(rawInput)
        const file = parts[0]
        if (!file) return ({ kind: 'error', text: '用法: /smart-conflict <.smart 路径> [要放的双字个数]' })
        const abs = resolve(file)
        if (!existsSync(abs)) return ({ kind: 'error', text: `文件不存在: ${file}` })
        const o = parseSmartOnce(abs)
        let ptrRefs = null
        try { const { data } = decodeContainer(readFileSync(abs)); ptrRefs = scanPtrRefs(data) } catch { ptrRefs = null }
        const need = Number(parts[1] ?? 0) || 0
        return ({ kind: 'success', text: conflictReport(o.userSyms, o.records, ptrRefs, need, 4096) })
      } catch (error) {
        return ({ kind: 'error', text: (error instanceof Error ? error.message : String(error)) + '\n\n' + FEEDBACK_HINT })
      }
    },
  })

  ctx.commands.register({
    name: 'smart-read',
    description: '解码 .smart 工程 / .smartlib 库文件（默认输出到工作区 解码归档\\<工程名>\\，可用 <路径> <输出目录> 指定）',
    input: { hint: '<.smart/.smartlib 路径> [输出目录]' },
    handler: async ({ rawInput, agent }) => {
      try {
        const parts = splitArgs(rawInput)
        const file = parts[0]
        const outDir = parts[1] ? resolve(parts[1]) : undefined
        if (!file) return ({ kind: 'error', text: '用法: /smart-read <.smart/.smartlib 路径> [输出目录]' })
        const abs = resolve(file)
        if (!existsSync(abs)) return ({ kind: 'error', text: `文件不存在: ${file}` })
        const raw = readFileSync(abs)
        const result = raw[0] === 0x44 ? decodeSmartLib(abs, outDir, sessionBase(agent)) : decodeSmartFile(abs, outDir, sessionBase(agent))
        return ({ kind: 'success', text: result.proceed })
      } catch (error) {
        return ({ kind: 'error', text: (error instanceof Error ? error.message : String(error)) + '\n\n' + FEEDBACK_HINT })
      }
    },
  })

  ctx.commands.register({
    name: 'codesys-diff',
    description: '对比新旧两个 CoDeSys 工程（.project 或已解码目录），输出逻辑变化报告',
    input: { hint: '<旧工程 .project 或解码目录> <新工程 .project 或解码目录>' },
    handler: async ({ rawInput, signal, agent }) => {
      const [oldP, newP] = splitArgs(rawInput)
      try {
        if (!oldP || !newP) throw new Error('用法: /codesys-diff <旧工程或目录> <新工程或目录>（带空格路径请加引号）')
        const { notes, report } = await runDiff(ctx, oldP, newP, signal, sessionBase(agent))
        return { kind: 'success', text: notes.length ? `${notes.join('\n')}\n\n${report}` : report }
      } catch (error) {
        return { kind: 'error', text: (error instanceof Error ? error.message : String(error)) + '\n\n' + FEEDBACK_HINT }
      }
    },
  })

  ctx.commands.register({
    name: 'smart-diff',
    description: '对比新旧两个 SMART 工程（块清单/主程序调用链/I-O 引用/符号表差异）',
    input: { hint: '<旧.smart 路径> <新.smart 路径> [输出目录]' },
    handler: async ({ rawInput, agent }) => {
      try {
        const parts = splitArgs(rawInput)
        if (parts.length < 2) return ({ kind: 'error', text: '用法: /smart-diff <旧.smart 路径> <新.smart 路径> [输出目录]（带空格路径请加引号）' })
        for (const q of parts.slice(0, 2)) {
          if (!existsSync(resolve(q))) return ({ kind: 'error', text: `文件不存在: ${q}` })
        }
        const outDir = parts[2] ? resolve(parts[2]) : undefined
        const { proceed, report } = smartDiff(resolve(parts[0]), resolve(parts[1]), outDir, sessionBase(agent))
        return { kind: 'success', text: `${proceed}\n\n${report}` }
      } catch (error) {
        return ({ kind: 'error', text: (error instanceof Error ? error.message : String(error)) + '\n\n' + FEEDBACK_HINT })
      }
    },
  })

  ctx.commands.register({
    name: 'smart-free-space',
    description: 'SMART 工程地址占用与空闲段分析（加功能前选新地址用：有符号名的勿动、备用坑勿动、只取无名字无引用连续空闲段）',
    input: { hint: '<.smart 路径 或 已解码目录>' },
    handler: async ({ rawInput }) => {
      try {
        const [p] = splitArgs(rawInput)
        if (!p) return ({ kind: 'error', text: '用法: /smart-free-space <.smart 路径 或 已解码目录>' })
        const abs = resolve(p)
        if (!existsSync(abs)) return ({ kind: 'error', text: `文件不存在: ${p}` })
        const isDir = existsSync(join(abs, '记录.json')) && existsSync(join(abs, '解码报告.md'))
        let records, userSyms
        if (isDir) {
          const j = JSON.parse(readFileSync(join(abs, '记录.json'), 'utf8'))
          records = j.records ?? []
          userSyms = [...(j.userSyms ?? [])]
        } else {
          const o = parseSmartOnce(abs)
          records = o.records
          userSyms = o.userSyms
        }
        return ({ kind: 'success', text: `地址占用与空闲段分析（${isDir ? '已解码目录' : basename(abs)}）:\n${freeSpaceReport(userSyms, records)}` })
      } catch (error) {
        return ({ kind: 'error', text: (error instanceof Error ? error.message : String(error)) + '\n\n' + FEEDBACK_HINT })
      }
    },
  })
}

// 内部导出（诊断/CLI 验证用，不参与工具的 ctx 注册）：与工具相同的解码入口
export const _decodeSmartFile = decodeSmartFile
export const _parseSmartOnce = parseSmartOnce
export const _smartDiff = smartDiff
export const _decodeSmartPouStructure = decodeSmartPouStructure
export const _conflictReport = conflictReport
