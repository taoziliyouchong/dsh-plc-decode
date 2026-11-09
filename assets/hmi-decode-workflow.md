# hmi-decode-workflow —— 触摸屏工程读取工作流

触摸屏（HMI）工程走**本入口**，与 PLC 分开：PLC 工程（`.project` / `.dvp` / `.smart` / `.smartlib`）用 `plc-decode`，屏工程用 `hmi-decode`。

## 一、先认类型（别拿错工具）

| 文件 | 是什么 | 用哪个 |
|---|---|---|
| `.hmismart` | 西门子 WinCC flexible SMART 触摸屏工程（Smart Line 屏） | 工具 `hmi-decode`（解码）／`hmi-diff-project`（新旧对比） |
| `.fsprj` 或含 `HMI\Frame` 的目录 | 繁易 FStudio / Flexem 触摸屏工程 | 工具 `hmi-decode`（画面 / 控件 / 地址表） |
| `<工程名>.srt`（同目录） | 项目文本侧的序列化存储 | 主文件被锁时的旁路，见第三节 |

**第一原则与 PLC 侧相同：先要"软件里能导出的东西"**。触摸屏这边对应的是：画面清单/变量表（软件里能导 CSV 或看变量表）——导出来对账，比在工程里挖快一个数量级。

## 二、西门子 `.hmismart`（数据库直读，主路）

它**不是压缩包、也没加密**，是 WinCC flexible SMART 的工程数据库单文件：

- **容器**：SQL Server 数据库文件（MDF），文件头 `01 0F 00 00 08 02 00 00`，页大小 **8192** 字节（不是 4096），文件长度可被 8192 整除。
- **打开方式**：整份复制 → 附加到 SQL Server LocalDB 实例 `WINCCFLEX2022`（`FOR ATTACH_REBUILD_LOG`；本机没有该实例时退回 `MSSQLLocalDB`）→ 直查表。
- **对象树在表里，不在字节里**：

| 表 | 作用 | 关键字段 |
|---|---|---|
| `HmiBasicTable` | 所有对象的统一登记 | `ObjId` / `ObjName` / `ParentId` / `ObjTypeCode` / `Deleted` |
| `HmiScreenTable` | 画面属性 | `Id` / `Number` / `ScreenDeviceType` / `ByteBlob` |
| `HmiScreenItemTable` | 元件几何 | `Id` / `LocationX/Y` / `SizeX/Y` / `HmiSubType` |
| `HmiTextTable` | 文本（每对象一条，多语言分槽） | `Id` / `Language0..31` / `IsHiddenText` / `IsSystemMessageText` |

**归属链**（回答「这句话在哪个画面」的唯一依据）：

```
HmiTextTable.Id = HmiBasicTable(文本对象).ObjId
HmiBasicTable(文本对象).ParentId = HmiBasicTable(元件).ObjId
HmiBasicTable(元件).ParentId     = HmiBasicTable(画面).ObjId
```

**对象类型码**（`ObjTypeCode`）：画面 `1687591545`｜画面文件夹 `-2139304638`｜画面元件 `-1426153460`｜文本对象 `-1504425023`｜非显示属性（Appearance/PropertyTag）`-805315726`｜HMI 变量 `1179361025`。

### 怎么跑

工具 `hmi-decode`：给 `.hmismart` 走数据库直读（本机没有 LocalDB 时自动退回二进制扫描），产物落 `<工作区>\解码归档\<工程名>\HMI解码\`。

| 文件 | 内容 |
|---|---|
| `HMI解码报告.md` | 规模（画面/元件/文本/变量）+ 文本最多的画面 |
| `00-格式说明.md` | 容器格式、表结构、类型码、坑 |
| `10-画面.tsv` | 画面 / 文件夹 / 屏号 / 屏类型 / 元件数 |
| `11-元件.tsv` | 画面 / 元件 / 子类型 / 位置 / 大小 |
| `12-文本.tsv` | 画面 / 文件夹 / 元件 / 中文 / 英文 / 隐藏 / 系统消息 / 类型 / 位置 |
| `13-变量.tsv` | 变量名 / 设备号 |
| `14-对象类型.tsv` | 类型码分布（核对用） |
| `15-屏上文本.tsv` | 去重后的屏上文本（同一句多屏用「、」合并画面） |

单个工程也可以直接跑脚本（产物目录与工具一致）：

```
node assets/hmismart-db.mjs <工程.hmismart> [输出目录]
```

要给目录或单文件批量跑、并顺带出「画面｜文本」Excel：

```
node assets/hmi-auto-decode.mjs <工程文件或工程目录> [输出目录]
```

### 抽「屏幕上显示的文字」

直接读 `12-文本.tsv` 过滤，不要再去二进制里扫：

- **取哪一列**：`中文` = `HmiTextTable.Language0`（屏上简体）；`英文` = `Language1`。同一条文本对象按语言分槽，各槽互不影响。
- **过滤**：含汉字的才算要翻的；首字符是 ASCII 字母/数字的（`A_进料1关`、`Q0.0` 这类）按需排除；`系统消息=True` 是软件自带消息，按需排除。
- **归属**：`画面` 列已经是三级 join 出来的真值，**不要**再按「文本对象在文件里的物理位置」去猜——那套做法会串屏（相邻画面的词被算到别的画面上）。
- **去重与合并**：`15-屏上文本.tsv` 已按「去掉所有空白后的文本」去重，画面列合并了同一句出现的全部画面。
- **要「画面｜文本」两列 Excel**：`hmi-auto-decode.mjs` 直读成功后会顺带出 `屏幕文本.xlsx`；也可以单独跑 `python assets/hmismart-screen-xlsx.py <HMI解码目录> [输出.xlsx]`。规则写在脚本里：只取 `类型=Screens`、含汉字、首字符非 ASCII 字母/数字、去 `Template` 模板屏、同句空白差异归一、同句多屏合并、`XX开`＋`XX关` 合成 `XX开/关`、画面名去数字前缀并按屏号排序。

### 兜底：二进制扫描（本机无 LocalDB 时）

`assets/hmismart-decode.mjs`（原始产物）+ `assets/hmismart-report.mjs`（人读报告）。只出「对象名清单 + 无归属的多语言文本」，**拿不到画面归属**，仅在没有数据库引擎时用。

### 新旧差异

`assets/hmismart-diff.mjs`（工具 `hmi-diff-project`）——比 ①起始画面配置 ②画面表记录 ③画面名清单 ④配套文件差异。**"重启后跳到别的画面"先看第 1 节**：`StartScreenId` 指向 `Deleted=true` 的画面时，面板启动找不到它就退到列表里的其它画面。

### 坑（都踩过）

- **页大小 8192**。按 4096 切全错位。
- **gzip 段不是对象数据**：解开是 .NET DataSet 的增量块（几十条），不是画面树；靠扫 gzip 只能得到无归属文本。
- **属性 blob 是 Utah 序列化**（magic `DBTM` / `Utah`），不是加密；但属性里不含「元件→文本」的边，别在那条路上耗。
- **源文件被 WinCC 打开时会被独占**：复制要带 `FileShare::ReadWrite|Delete`。
- **残留 LocalDB 库会锁住源文件**（`RECOVERY_PENDING`，`sp_detach_db` 报 `Cannot detach a suspect or recovery pending database`）：先 `sqllocaldb stop WINCCFLEX2022 -k` 再复制；库若是挂在源文件上，`ALTER DATABASE ... SET EMERGENCY` → `SET OFFLINE WITH ROLLBACK IMMEDIATE` → `sp_detach_db` 放掉。
- **项目文本导出（Screens.xls）没有画面列**，且会丢弃「一源多译」的文本（日志：`存在多种不同的翻译，不能再唯一分配该文本，因此将在导出时忽略`）。要画面归属就用数据库，别指望导出表。
- **查某个地址/变量时别做大范围 grep**：含压缩块原文的几份产物里宽 pattern（如 `VW`）会刷出几百行垃圾、把上下文冲掉；要查就用具体串。另：**地址表里出现 ≠ 画面绑定**，要知道挂在哪个控件上，回 `11-元件.tsv` / `12-文本.tsv` 查一层。

### 旁路：`.data` 与 `.srt`

数据库读不动时（主文件被 WinCC 独占、本机没有 LocalDB），同目录的旁系文件还能给出名字与文本，但给不出归属链——见下一节。

## 三、旁路：`.data` 与 `.srt`

数据库读不动时（主文件被 WinCC 独占、本机没有 LocalDB），同目录的旁系文件还能给出名字与文本，但给不出归属链。

### `.data`（工程数据的旁路）

- **结构**：`ES2RT` 头（前 10 字节）+ gzip 流（`1F 8B 08` 起），解出来是 .NET 序列化对象图（20MB 量级），**UTF-8，字符串可读**。
- **能拿到**：变量表全部标签名（含以地址命名的标签与中文命名标签）、连接与驱动名、画面/控件文本。
- **拿不到**：变量的 Modbus 地址号（二进制存，工程里没有明文字样）——读不到就直说读不到，别编；判定靠现场按一下看对应位是否变，或让用户从变量表导一份出来。
- **用法**：按具体串搜（具体地址串、驱动名、中文标签名），避开宽 pattern。

### `.srt` 项目文本

- **结构**：头文本 `Sm@RT-Transfer` + 0x0E 起 UTF-16LE 链式记录 `[u16 字符数][字符串]`，按「画面 → 控件引用（按钮_N/文本域_N/IO 域_N）→ 中文文本 → 英文文本」交替存放；另有系统消息区（官方中英对照）。
- **解析要点**：Node `Buffer.toString('utf16le')` 直接可用；链式记录用「从锚点向前回退找链头 → 正向延伸」法；单条扫描会撞二进制假阳性，必须链式 + 可打印字符校验。
- **陷阱**：① 中文不要用 GBK 解（UTF-16 才对齐）；② 抽「中文→英文」对时跳过元素引用/变量地址/空串；③ 软件「项目文本」页可与 `.srt` 内容逐条吻合，能当真值校准。
- **旁系文件**：`*.transfer`（UTF-16 XML，含设备型号/页面清单）、`*.chk/.cnk/.rdf/.pwx`（校验/密码，跳过）。

## 四、繁易 FStudio

- 工具：`hmi-decode`（读工程 → 画面 / 控件 / 控件地址表）。

## 五、交付与边界

- 产物约定：`.hmismart` 写 `<工作区>\解码归档\<工程名>\HMI解码\`；FStudio 写 `<工程目录>\解码归档\`。**不写系统临时目录、不污染工程目录**。
- 只读源工程：数据库路径是「复制到临时目录再附加」，源文件不动；结束时 drop 库、删临时目录。
- `解码归档` 里的报告是某个版本的快照，拿旧报告对账前先比源文件的**大小 + 修改时间**。
- 屏上地址不是西门子那种格式时（M 区名、Modbus 号、命名习惯）：先解同机 PLC 工程（`plc-decode`），看 M 区 IO 映射与参数表，再回来看屏地址。
