# zzuser-hmi-decode-workflow —— 触摸屏工程读取工作流

触摸屏（HMI）工程走**本入口**，与 PLC 分开：PLC 工程（`.project` / `.dvp` / `.smart` / `.smartlib`）用 `zzuser-plc-decode`，屏工程用 `zzuser-hmi-decode`。

## 一、先认类型（别拿错工具）

| 文件 | 是什么 | 用哪个 |
|---|---|---|
| `.hmismart` | 西门子 WinCC flexible SMART 触摸屏工程（Smart Line 屏） | 工具 `zzuser-hmi-decode`（解码）／`zzuser-hmi-diff-project`（新旧对比） |
| `.fsprj` 或含 `HMI\Frame` 的目录 | 繁易 FStudio / Flexem 触摸屏工程 | 工具 `zzuser-hmi-decode`（扫文本）／`zzuser-fstudio-scan-texts`／`zzuser-fstudio-i18n`（多语言出表） |
| `<工程名>.设备_1.srt`（同目录） | 项目文本侧的序列化存储 | 主文件被锁时的旁路，见第三节 |
| `Screens.xls` / `Others.xls` / `Messages.xls` | WinCC flexible「项目文本」导出成的 Excel 三件套 | 工具 `zzuser-wincc-text-i18n`（分型／回写／自检），流程见技能 `zzuser-wincc-text-i18n-workflow` |

**第一原则与 PLC 侧相同：先要"软件里能导出的东西"**。触摸屏这边对应的是：画面清单/变量表（软件里能导 CSV 或看变量表）——导出来对账，比在工程里挖快一个数量级。

## 二、西门子 `.hmismart`（主文件可全解）

它**不是压缩包、也没加密**，是 WinCC flexible SMART 的工程数据库单文件：

- **容器**：魔数 `01 0F 00 00 08 02 00 00`，4096 字节严格页对齐。
- **明文对象记录**：`36` + UUID(16B) + 若干字段 + 名称(UTF-16LE)。UUID 是**对象类别**，同类共用一个；判据是同一 UUID 出现 ≥3 次才算真类型。
- **压缩块**：gzip 头 + **裸 deflate，没有 CRC/ISIZE 尾部**——标准 `gunzip` 只能解出一小部分，必须 `inflateRaw`。解出的内容是「属性名 + 属性值」序列与软件自带的多语言系统消息。
- **内嵌 DDL**：`Hmi*` 表的建表脚本明文可读（HmiScreenTable / HmiTagTable / HmiConnectionTable / HmiScreenItemTable …），即工程数据的逻辑模型——**查某张表有哪些字段，先看它**。
- **一次跑完**：`assets/hmismart-decode.mjs`（原始产物）+ `assets/hmismart-report.mjs`（人读报告），产物落 `<工作区>\解码归档\<工程名>\HMI解码\`，只读源文件。
- **新旧差异**：`assets/hmismart-diff.mjs`（工具 `zzuser-hmi-diff-project`）——比 ①起始画面配置 ②画面表记录 ③画面名清单 ④配套文件差异。**"重启后跳到别的画面"先看第 1 节**：`StartScreenId` 指向 `Deleted=true` 的画面时，面板启动找不到它就退到列表里的其它画面。
- **查某个地址/变量时别做大范围 grep**：含压缩块原文的几份产物里宽 pattern（如 `VW`）会刷出几百行垃圾、把上下文冲掉；要查就用具体串。另：**地址表里出现 ≠ 画面绑定**，要知道挂在哪个控件上，得回对象记录再查一层。

### 两台软件同时唱着的时候：直接读旁系 `.data`（省一次解锁）

`.hmismart` 被 WinCC 打开时是**独占锁**（连 `FileShare.ReadWrite` 都打不开）。这时不必关软件，同目录的 `{{GUID}}.data` 就是工程数据的旁路：

- 结构：`ES2RT` 头（前 10 字节）+ gzip 流（`1F 8B 08` 起），解出来是 .NET 序列化对象图（20MB 量级），**UTF-8，字符串可读**。
- 你能直接从中拿到：**变量表全部标签名**（含 `文件夹_N\MW5212` 这类「以地址命名」的标签与中文命名标签）、**连接与驱动名**（如 `driver.Modicon MODBUS Standard V3`）、画面/控件文本。
- 拿不到：**变量的 Modbus 地址号**（二进制存，工程里没有明文字样）——读不到就直说读不到，别编；判定靠现场按一下看对应位是否变，或让用户从变量表导一份出来。
- 用法：按具体串搜（`MW5212`、`驱动名`、中文标签名），避开宽 pattern。

## 三、`.srt` 项目文本（主文件锁着时的另一条旁路）

- **结构**：头文本 `Sm@RT-Transfer` + 0x0E 起 UTF-16LE 链式记录 `[u16 字符数][字符串]`，按「画面 → 控件引用（按钮_N/文本域_N/IO 域_N）→ 中文文本 → 英文文本」交替存放；另有西门子系统消息区（官方中英对照，无需翻译）。
- **解析要点**：Node `Buffer.toString('utf16le')` 直接可用；链式记录用「从锚点向前回退找链头 → 正向延伸」法；单条扫描会撞二进制假阳性，必须链式 + 可打印字符校验。
- **陷阱**：① 中文不要用 GBK 解（UTF-16 才对齐）；② 抽「中文→英文」对时跳过元素引用/变量地址/空串；③ 截图「项目文本」页可与 `.srt` 内容逐条吻合，能当真值校准。
- **旁系文件**：`*.transfer`（UTF-16 XML，含设备型号/页面清单）、`*.data`（见上）、`*.chk/.cnk/.rdf/.pwx`（校验/密码，跳过）。

## 四、繁易 FStudio（多语言另见专篇）

- 工具：`zzuser-hmi-decode`（读工程→扫元件文本）、`zzuser-fstudio-scan-texts`（只看要翻什么）、`zzuser-fstudio-i18n`（出对照表 + 可导入文本库的表）。
- 方法与踩坑见同插件技能 **`zzuser-fstudio-i18n-workflow`**：列名逐字符一致、元件文字常写死不走文本库、原工程英文槽常是错填。

## 五、交付与边界

- 产物约定：`.hmismart` 写 `<工作区>\解码归档\<工程名>\HMI解码\`；FStudio 写 `<工程目录>\多语言产出\`。**不写系统临时目录、不污染工程目录**。
- 只读源工程；`解码归档` 里的报告是某个版本的快照，拿旧报告对账前先比源文件的**大小 + 修改时间**。
- 屏上地址为什么长成"不是西门子那种格式"（M 区名、Modbus 号、命名习惯）：见 PLC 侧技能 `zzuser-codesys-teach-workflow` §5——那是工程地址面的事，不在这里重复。
