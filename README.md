# dsh-plc-decode

<img src="assets/icon-180.png" width="96" align="right" alt="dsh-plc-decode">

**中文** | [English](README.en.md)

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）里直接读 PLC 工程文件：按文件头自动识别格式，把工程解成可读报告与结构化数据，再基于解码结果做新旧对比、地址体检、元素级读/写判定与连线还原。同一插件行里也承接触摸屏（HMI）工程：画面、控件、变量与地址；威纶通 EasyBuilder Pro 读该工程的编译产物，解出画面、文字对象、报警事件与文字库。

**只读**：解析工程文件，不改动原文件。

## 支持的工程文件

| 文件头 | 格式 | 解码方式 |
|---|---|---|
| `50 4B 03 04`（ZIP） | CoDeSys V3.5 / LeadSysStudio `.project`（含雷赛） | 自带 Python 脚本：解包 → 字符串表 → 逐对象恢复 POU ST 源码 |
| `57 01 01 00` | 台达 WPLSoft / ISPSoft `.dvp` | 自带 Python 脚本：文件结构 / 段落注释 / 设备注释 / 指令表反汇编 |
| `53 48 33 00`（SH3） | 西门子 S7-200 SMART `.smart` 工程 | 内嵌 Node 解码器：块 / 指令记录 / 操作数 / 用户与系统符号表 |
| `44 45 4D 00`（DEM） | 西门子 S7-200 SMART `.smartlib` 库 | 内嵌 Node 解码器：库变量与注释流 |

> 雷赛（Leadshine）用 LeadSysStudio 保存的 `.project` 与 CoDeSys 同格式，走同一条解码链：ST 源码导出到 `pous/<POU>.txt`，可用 `/codesys-check` 做等价编译校验（结构体成员、数组下标、调用存在性、地址唯一、未声明符号）。

### 触摸屏（HMI）工程

| 文件 | 品牌 | 解出 |
|---|---|---|
| `.hmismart` | 西门子 WinCC flexible SMART（Smart Line 屏） | 数据库直读：画面 / 元件 / 文本（带画面归属）/ 变量；本机没有 LocalDB 时退回二进制扫描，只出对象名与无归属文本；旁系 `{{GUID}}.data` 可补变量名、控件名、绑定候选、类型表 |
| `.fsprj` 或含 `HMI\Frame` 的目录 | 繁易 FStudio / Flexem | 画面 / 控件 / 控件地址（读 `HMI\System\fs2.s3db` 与 `Bin\fshmi.bin`） |
| `.nbp` | 欧姆龙 NB-Designer | 画面 / 控件 / 地址（XML 直读） |
| `.mcp` / `.mcgs` | 昆仑通态 MCGS / LSTP Studio | 画面 / 变量 / 报警 / 策略（Access 库） |
| `.emtp` / `.exob` | 威纶通 EasyBuilder Pro | 画面 / 文字对象 / 报警事件 / 文字库（`.emtp` 本体加密，读同工程的编译产物 `.exob`） |

## 安装

前提：

- DSH 桌面端（插件运行在 DSH 内，Node 版本跟随 DSH）；
- 解码 `.project` / `.dvp` 需要 Python 3.9+ 在 `PATH` 里（只用标准库，无需 pip 安装）；
- 解码 `.smart` / `.smartlib` 不需要 Python；
- `.hmismart` 数据库直读需要本机有 SQL Server LocalDB（WinCC flexible SMART 自带 `WINCCFLEX2022` 实例，没有时试 `MSSQLLocalDB`；都没有就退回二进制扫描）；
- 生成「画面｜文本」Excel 需要 Python 的 `openpyxl`；
- 要求 DSH >= 0.2.1-alpha.1（下限按用到的服务与槽在 alpha.1 已存在推定）；实测 0.2.1-alpha.3、0.2.2-rc.1，更高版本未验证。

从 GitHub 安装：

```sh
dsh plugin --profile web add github:taoziliyouchong/dsh-plc-decode
```

装完重启 DSH。本插件没有 npm 运行时依赖。

## 使用

### 工具（模型自动调用）

| 工具 | 用途 |
|---|---|
| `plc-decode` | 统一入口：按文件头识别四格式并分发解码，参数 `file` + 可选 `outDir` |
| `smart-pou-structure` | 某子程序的内部结构：接口参数（L 区地址 + 类型）、盒级指令链、调用点实参 |
| `smart-lad` | 连线还原：按块、按网络打印 LAD 指令序列（LD/A/O/AN/ON、EU/ED、LPS/LRD/LPP、线圈、比较、指令盒占位） |
| `smart-ladder-elements` | 元素级读/写判定：某地址（可一批）的每个落点是触点（读）还是写 |
| `smart-net-trace` | 网络级轨迹：给偏移区间，按顺序列出触点 / 写元件 / 指令盒 / 常数 |
| `smart-box-pins` | 盒级引脚表：库调用盒（MBUS_CTRL、MBUS_MSG、TON、CTU、MOV_* 等）的「引脚名 = 实参」 |
| `smart-pin-dump` | 字节级定位：某地址的全部出现位置，或某偏移区间内的操作数记录 |
| `smart-var-usage` | 变量使用体检：某地址的全部引用点、共用字节的其它地址形式、写入点判定 |
| `smart-free-space` | 地址占用与空闲段：加功能前选新地址（有符号名的、预留坑都不动） |
| `smart-conflict` | 地址冲突体检：重叠冲突（真冲突 / 疑似 / 仅登记）+ 连续空间被切碎 |
| `smart-diff-project` | SMART 新旧工程对比：块清单、主程序调用链、I-O 引用、符号表差异 |
| `codesys-diff-project` | CoDeSys 新旧工程对比：POU 清单、真实逻辑变化区段、空白差异、字符串表、对象表 |
| `hmi-decode` | 触摸屏统一入口：按文件识别 `.hmismart` / `.fsprj` / `.nbp` / `.mcp` / `.emtp` / `.exob` 并解码（`.hmismart` 走数据库直读） |
| `hmi-diff-project` | 新旧 `.hmismart` 对比：起始画面、画面表、画面名、配套文件 |
| `ebpro-decode` | 威纶通 EasyBuilder Pro：从编译产物 `.exob` 解画面 / 文字对象 / 报警事件 / 文字库 |
| `ladder-auto` | 自动出梯形图：直接读 `.smart` 工程，按块（可单网络）生成盒式文字梯形图（`block`、`net`） |
| `ladder-dvp` | 台达 `.dvp` 工程 → 文字梯形图，可只出某几行 |
| `ladder-from-stl` | 语句表（STL）→ 文字梯形图 + 每个网络的机械讲解 |
| `ladder-render` | 把网络描述（spec JSON）渲染成固定版式的文字梯形图 |

### 斜杠命令（人直接执行）

| 命令 | 用途 |
|---|---|
| `/plc-decode <文件> [输出目录]` | 统一解码入口 |
| `/plc-archive` | 查看当前生效的解码归档根目录、默认落点与改配置的方法 |
| `/codesys-read <工程>` | 解码 `.project`（ST 源码 + 报告）或 `.dvp`（解码报告） |
| `/dvp-read <工程>` | 台达 DVP 结构与指令表报告 |
| `/smart-read <.smart/.smartlib> [输出目录]` | SMART 工程 / 库解码 |
| `/codesys-check <工程>` | 解码 `.project` 后做等价编译静态校验（结构体 / 调用 / 地址唯一 / 未声明符号） |
| `/codesys-diff <旧> <新>` | CoDeSys 新旧对比 |
| `/smart-diff <旧> <新>` | SMART 新旧对比 |
| `/smart-free-space <.smart>` | 地址占用与空闲段 |
| `/smart-conflict <.smart>` | 地址冲突体检 |
| `/smart-ladder <.smart> [地址]` | 元素级读/写判定 |
| `/smart-lad <.smart> [块名] [网络号]` | 连线还原（LAD 指令序列） |
| `/hmi-decode <.hmismart / .fsprj / .nbp / .mcp / .emtp / .exob> [输出目录]` | 触摸屏工程解码 |
| `/hmi-diff <旧 .hmismart> <新 .hmismart>` | 触摸屏新旧对比 |
| `/ladder on\|off\|status` | 梯形图开关（默认关闭，立即生效） |
| `/ladder-auto <.smart> [块名] [网络号] [out.txt]` | 出 `.smart` 的梯形图 |
| `/ladder-dvp <.dvp> [起行] [止行] [out.txt]` | 出 `.dvp` 的梯形图 |
| `/ladder-stl <stl.txt> [out.txt]` | 语句表 → 梯形图 + 讲解 |
| `/ladder-spec <spec.json> [out.txt]` | 渲染 spec JSON |
| `/plc-calibrate <格式> <字节或 cmd:XX> <名字> [备注]` | 把解不出的字节 / 功能码记进校准表，之后解码直接用这个名字 |

## 输出位置

默认写到**工作区**的 `解码归档/<工程所在文件夹名>/`（用文件夹名而不是工程文件名，避免不同文件夹里的同名工程互相覆盖；同一文件夹里有多个工程文件时用 `文件夹名_工程名`）。也可以在工具参数里用 `outDir` 指定。

| 格式 | 主要产物 |
|---|---|
| `.project` | `00-索引.md`（先读这份）、`pous/<POU>.txt`（ST 源码）、`工程内容报告.md`、`全部字符串.txt`、`对象表.md`、`项目树.md` |
| `.dvp` | `00-索引.md`、`解码报告.md`（结构 / 段落注释 / 设备注释 / 指令表）、可选 `程序解读.md` |
| `.smart` / `.smartlib` | `00-目录.md`（先读这份）、`解码报告.md`、`程序.lad`、`元素记录.tsv`、`符号地址.tsv`、`分析.md`、`记录.json`、`字符串全录.txt` |
| `.hmismart` | `HMI解码报告.md`、`00-格式说明.md`、`10-画面.tsv`、`11-元件.tsv`、`12-文本.tsv`、`13-变量.tsv`、`14-对象类型.tsv`、`15-屏上文本.tsv`；无 LocalDB 时退回二进制扫描产物 |
| `.fsprj` | `画面.tsv`、`控件.tsv`、`控件地址.tsv`、`变量.tsv` |
| `.nbp` / `.mcp` | `解码报告.md` + 画面/控件（或变量/报警/策略）JSON |
| `.emtp` / `.exob` | `HMI解码/HMI解码报告.md` + `00-格式说明.md`、`10-画面.tsv`、`11-文字对象.tsv`、`12-报警事件.tsv`、`13-文字库.tsv`、`08-统计.json` |

### 梯形图（默认关闭）

梯形图工具默认关着，免得一次普通解码就多出一组工具：

- 打开：`/ladder on`（立即生效，不用重启）；关闭：`/ladder off`；看状态：`/ladder status`
- 或者在 profile 的 `cordis.patch.yml` 里给本插件那一行写 `config: { ladder: true }` 作初始状态
- 关着时梯形图工具只回一行开启提示；解码照常
- 前三次解码会在结果末尾提示「可以看梯形图」（1/3、2/3、3/3），之后不再提示；开关状态与计数存在 `$DSH_HOME/ladder-state.json`

### 改归档地址（不用改代码）

在 DSH profile 的 `cordis.patch.yml`（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）末尾给本插件那一行加 config（只写 `archiveDir`：归档根目录）：

`archiveDir` 是归档**根目录**：相对路径按当前会话工作区解析，绝对路径原样使用；默认 `解码归档`。改完重启 dsh 生效，`/plc-archive` 可随时查看当前生效值；只想改一次就在解码时传 `outDir`。

`.smart` 的 `记录.json` 同时是各分析工具（地址占用、变量使用等）的输入，也是识别「已解码目录」的凭据；解码报告头部带**源文件指纹**（文件大小 + 修改时间），工程换版本后先核对指纹再用旧报告。

## 已知边界

- 触摸屏工程：`.hmismart` 是 SQL Server 数据库文件，画面 / 元件 / 文本的归属链从表里 join 出来；本机没有 LocalDB 时退回二进制扫描，只能出对象名与无归属文本，拿不到画面归属。旁系 `{{GUID}}.data`（ES2RT 序列化流）仍可补变量名、控件名与绑定候选。繁易工程若没建变量，控件地址只在 `Bin\fshmi.bin` 的动作表里；昆仑通态工程需本机有 `.mcp` 样本才能验证。
- 威纶通 EasyBuilder Pro：`.emtp` 本体压缩加密，只能读同工程的编译产物 `.exob`，表里反映的是**编译当时**的工程（工程改过要先重新编译）；编译产物只带源语言，没有译文。画面归属由对象流分段推定，表里的 x/y/w/h 是文字框度量，不是画面坐标。
- 库块调用区（如 MBUS_MSG 的 Slave / RW / Addr / Count / DataPtr）的引脚级实参解不出，工具会明确说明，不猜。
- 加密或特殊压缩的工程可能解不出；解码器会报错而不是给出半真结果。
- `.smart` 的串/并联拓扑由指令记录还原，已用官方导出的 STL 逐网络回归验证；库调用区（无标准盒头）不在覆盖范围内。
- 指令名带 `?`（如 `?DRVI`）是推断名，报告末尾有推断对照表；`??xx` 是未定名，保持原样。

## 开发与自检

```sh
npm run check                 # 语法检查
npm run smoke                 # 装载插件 + 核对注册面（工具 19 个 / 命令 20 个）
npm run smoke -- <工程文件>    # 额外对一个真实工程跑端到端解码，核对产物落盘
npm pack --dry-run            # 看包里内容（node_modules、publish/ 不应进包）
```

## 目录结构

```
index.js                    插件入口：工具与命令注册、四格式分发、SMART 解码器
hmi.js                      触摸屏解码模块（工具/命令/技能注册，由 index.js 调用）
ladder.js                   梯形图模块（默认关闭，/ladder on；由 index.js 调用）
assets/decode-pack.mjs      解码产物落盘（索引/目录/表格/记录）
assets/smart-lad.mjs        连线还原脚本（由 smart-lad 工具调用）
assets/smart-net-trace.mjs  网络轨迹脚本（由 smart-net-trace 工具调用）
assets/codesys-tools/       CoDeSys / DVP 解码 Python 脚本（只用标准库）
assets/hmismart-db.mjs      .hmismart 数据库直读（附加 LocalDB 查表，出画面/元件/文本/变量）
assets/hmismart-db.ps1      上一条的 PowerShell 半部（复制 + 附加 + 导出 TSV）
assets/hmismart-decode.mjs  .hmismart 二进制扫描兜底（结构表 + .data 名字/绑定/类型表）
assets/hmismart-report.mjs  .hmismart 可读报告（画面/变量/连接）
assets/hmismart-screen-xlsx.py  「画面｜文本」两列 Excel（读 12-文本.tsv）
assets/hmi-auto-decode.mjs  触摸屏工程批量入口：判类型 → 调对应解码器 → 出屏幕文本.xlsx
assets/hmismart-diff.mjs    .hmismart 新旧对比
assets/fstudio-tables.py    繁易画面 / 控件 / 控件地址表
assets/hmi-decode-workflow.md  触摸屏解读流程（技能正文）
assets/nb-decode.mjs        欧姆龙 NB-Designer 解码器
assets/mcgs-decode.mjs      昆仑通态 MCGS / LSTP 解码器
assets/ebpro-decode.mjs     威纶通 EasyBuilder Pro 解码器（读 .exob）
assets/ladder-render.mjs    文字梯形图渲染器（由 ladder-render 调用）
assets/stl-to-ladder.mjs    STL → 梯形图（由 ladder-from-stl 调用）
assets/smart-ladder-auto.mjs .smart 自动出图（由 ladder-auto 调用）
assets/dvp-ladder.mjs       .dvp 自动出图（由 ladder-dvp 调用）
scripts/smoke.mjs           冒烟测试
```

## 反馈

插件有问题，按这个顺序：

1. 开 Issue：https://github.com/taoziliyouchong/dsh-plc-decode/issues —— 能留痕、能搜历史，别人也可能已经遇过；
2. 急着问或不想开 Issue，QQ 号：**2171960697**（加好友请注明装的是哪个插件）。

反馈时带上：DSH 版本、插件版本、报错原文、截图。少一样多半要再问一轮。

## 许可

MIT
