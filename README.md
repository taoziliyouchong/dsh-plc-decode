# dsh-plc-decode

<img src="assets/icon-180.png" width="96" align="right" alt="dsh-plc-decode">

**中文** | [English](README.en.md)

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）里直接读 PLC 工程文件：按文件头自动识别格式，把工程解成可读报告与结构化数据，再基于解码结果做新旧对比、地址体检、元素级读/写判定与连线还原。同一插件行里也承接触摸屏（HMI）工程：画面、控件、变量与地址。

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
| `.hmismart` | 西门子 WinCC flexible SMART（Smart Line 屏） | 画面 / 元件 / 文本 / 设备表；旁系 `{{GUID}}.data` 里解变量名、控件名、绑定候选、类型表 |
| `.fsprj` 或含 `HMI\Frame` 的目录 | 繁易 FStudio / Flexem | 画面 / 控件 / 控件地址（读 `HMI\System\fs2.s3db` 与 `Bin\fshmi.bin`） |
| `.nbp` | 欧姆龙 NB-Designer | 画面 / 控件 / 地址（XML 直读） |
| `.mcp` / `.mcgs` | 昆仑通态 MCGS / LSTP Studio | 画面 / 变量 / 报警 / 策略（Access 库） |

## 安装

前提：

- DSH 桌面端（插件运行在 DSH 内，Node 版本跟随 DSH）；
- 解码 `.project` / `.dvp` 需要 Python 3.9+ 在 `PATH` 里（只用标准库，无需 pip 安装）；
- 解码 `.smart` / `.smartlib` 不需要 Python。
- 兼容 DSH 0.2.1-alpha.3 ～ 0.2.2-rc.1（本机实际运行验证过的最高版本）；更高版本未验证。

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
| `hmi-decode` | 触摸屏统一入口：按文件识别 `.hmismart` / `.fsprj` / `.nbp` / `.mcp` 并解码 |
| `hmi-diff-project` | 新旧 `.hmismart` 对比：起始画面、画面表、画面名、配套文件 |
| `fstudio-scan-texts` | 繁易工程元件文本扫描（按语种槽） |
| `fstudio-i18n` | 繁易多语言对照表与文本库导入表 |
| `fstudio-retag` | 已导出文本库表换语种列 |
| `wincc-text-i18n` | WinCC 项目文本三件套（Screens / Others / Messages）翻译与回写 |

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
| `/hmi-decode <.hmismart / .fsprj / .nbp / .mcp> [输出目录]` | 触摸屏工程解码 |
| `/hmi-diff <旧 .hmismart> <新 .hmismart>` | 触摸屏新旧对比 |
| `/fstudio-retag <TextLib 表> <词典> [输出]` | 文本库表换语种列 |

## 输出位置

默认写到**工作区**的 `解码归档/<工程所在文件夹名>/`（用文件夹名而不是工程文件名，避免不同文件夹里的同名工程互相覆盖；同一文件夹里有多个工程文件时用 `文件夹名_工程名`）。也可以在工具参数里用 `outDir` 指定。

| 格式 | 主要产物 |
|---|---|
| `.project` | `00-索引.md`（先读这份）、`pous/<POU>.txt`（ST 源码）、`工程内容报告.md`、`全部字符串.txt`、`对象表.md`、`项目树.md` |
| `.dvp` | `00-索引.md`、`解码报告.md`（结构 / 段落注释 / 设备注释 / 指令表）、可选 `程序解读.md` |
| `.smart` / `.smartlib` | `00-目录.md`（先读这份）、`解码报告.md`、`程序.lad`、`元素记录.tsv`、`符号地址.tsv`、`分析.md`、`记录.json`、`字符串全录.txt` |
| `.hmismart` | `10-画面.tsv`、`11-元件.tsv`、`12-文本.tsv`、`13-设备.tsv`、`20-变量.data.tsv`、`21-控件.data.tsv`、`23-控件绑定.data.tsv`、`24-类型表.tsv` |
| `.fsprj` | `画面.tsv`、`控件.tsv`、`控件地址.tsv`、`变量.tsv` |
| `.nbp` / `.mcp` | `解码报告.md` + 画面/控件（或变量/报警/策略）JSON |

### 改归档地址（不用改代码）

在 DSH profile 的 `cordis.patch.yml`（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）末尾给本插件那一行加 config（只写 `archiveDir`：归档根目录）：


`archiveDir` 是归档**根目录**：相对路径按当前会话工作区解析，绝对路径原样使用；默认 `解码归档`。改完重启 dsh 生效，`/plc-archive` 可随时查看当前生效值；只想改一次就在解码时传 `outDir`。

`.smart` 的 `记录.json` 同时是各分析工具（地址占用、变量使用等）的输入，也是识别「已解码目录」的凭据；解码报告头部带**源文件指纹**（文件大小 + 修改时间），工程换版本后先核对指纹再用旧报告。

## 已知边界

- 触摸屏工程：`.hmismart` 里只有模板骨架，真实画面与控件在旁系 `{{GUID}}.data`（ES2RT 序列化流），变量名与控件名能解，控件到变量的引用只解出同段共现与 UUID 命中那部分，其余标「未解出」；繁易工程若没建变量，控件地址只在 `Bin\fshmi.bin` 的动作表里；昆仑通态工程需本机有 `.mcp` 样本才能验证。
- 库块调用区（如 MBUS_MSG 的 Slave / RW / Addr / Count / DataPtr）的引脚级实参解不出，工具会明确说明，不猜。
- 加密或特殊压缩的工程可能解不出；解码器会报错而不是给出半真结果。
- `.smart` 的串/并联拓扑由指令记录还原，已用官方导出的 STL 逐网络回归验证；库调用区（无标准盒头）不在覆盖范围内。
- 指令名带 `?`（如 `?DRVI`）是推断名，报告末尾有推断对照表；`??xx` 是未定名，保持原样。

## 开发与自检

```sh
npm run check                 # 语法检查
npm run smoke                 # 装载插件 + 核对注册面（工具 18 个 / 命令 15 个）
npm run smoke -- <工程文件>    # 额外对一个真实工程跑端到端解码，核对产物落盘
npm pack --dry-run            # 看包里内容（node_modules、publish/ 不应进包）
```

## 目录结构

```
index.js                    插件入口：工具与命令注册、四格式分发、SMART 解码器
hmi.js                      触摸屏解码模块（工具/命令/技能注册，由 index.js 调用）
invariant.js                伴随插件：登记包名所有权
assets/decode-pack.mjs      解码产物落盘（索引/目录/表格/记录）
assets/smart-lad.mjs        连线还原脚本（由 smart-lad 工具调用）
assets/smart-net-trace.mjs  网络轨迹脚本（由 smart-net-trace 工具调用）
assets/codesys-tools/       CoDeSys / DVP 解码 Python 脚本（只用标准库）
assets/hmismart-decode.mjs  西门子 .hmismart 解码器（结构表 + .data 名字/绑定/类型表）
assets/hmismart-diff.mjs    .hmismart 新旧对比
assets/fstudio-tables.py    繁易画面 / 控件 / 控件地址表
assets/nb-decode.mjs        欧姆龙 NB-Designer 解码器
assets/mcgs-decode.mjs      昆仑通态 MCGS / LSTP 解码器
scripts/smoke.mjs           冒烟测试
```

## 反馈

插件有问题，按这个顺序：

1. 开 Issue：https://github.com/taoziliyouchong/dsh-plc-decode/issues —— 能留痕、能搜历史，别人也可能已经遇过；
2. 急着问或不想开 Issue，QQ 号：**2171960697**（加好友请注明装的是哪个插件）。

反馈时带上：DSH 版本、插件版本、报错原文、截图。少一样多半要再问一轮。

## 许可

MIT
