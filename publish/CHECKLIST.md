# 发布清单（DSH 社区）

这个目录是可直接发布的插件仓库内容。下面每一步做完再进下一步。

## 0. 发布前在本机验证

```sh
npm run check                  # 五个 JS 文件语法检查
npm run smoke                  # 装载插件 + 核对注册面（工具 12 / 命令 12）
npm run smoke -- "D:\path\to\machine.smart"   # 拿一份真实工程跑端到端解码
```

端到端这步必做，且最好四种格式各挑一份：`.project` / `.dvp` 走 Python，`.smart` / `.smartlib` 走内嵌解码器，两类路径都覆盖到再发。

## 0.5 检查打包内容

```sh
npm pack --dry-run
```

包里应只有：`index.js`、`invariant.js`、`cordis.patch.yml`、`assets/`、`scripts/`、两个 README、`LICENSE`、`package.json`。`publish/`、`.gitignore`、`解码归档/` 都不该进包。

## 1. 建 GitHub 仓库

- 公开仓库与 npm 包同名：仓库 `dsh-plc-decode`，包名 `dsh-plc-decode`。
- 推送本目录内容（`node_modules/`、`*.tgz` 已被 `.gitignore` 排除；仓库里不要带工程文件与解码产物）。
- 给仓库加 topic：`dsh-plugin`（收录检查会看）。

## 2. 填占位符

- `package.json` 的 `repository` / `homepage` / `bugs` 已按 `taoziliyouchong` 写好；换账号时三处一起改。
- `publish/registry-entry.yml` 的 `url` / `name` / `icon` 三处同样带 `taoziliyouchong`。
- 若走 npm，先确认包名可用（当前 `dsh-plc-decode` 在 npm 上未占用）。

## 3. 发布到 npm（可选，但推荐）

```sh
npm publish --access public
```

不发布 npm 也能被收录：安装命令可以走 GitHub（`dsh plugin --profile web add github:taoziliyouchong/dsh-plc-decode`）。发布 npm 的好处是市场能做版本更新检查。

## 4. 提交目录收录

到 GitHub 仓库 `awesome-dsh-plugin/awesome-dsh-plugin` 开 PR，只加一个文件：

- 路径：`data/plugins/taoziliyouchong__dsh-plc-decode.yml`
- 内容：`publish/registry-entry.yml` 全文

分类写的是 `tools`；如果维护者的分类表里没有这一项，按其表改一处即可，不影响插件本身。

## 5. 之后的版本更新

1. 改 `package.json` 的 `version`（语义化版本）。
2. 打 tag：`git tag v0.1.1 && git push --tags`。
3. `npm publish`（如果走 npm）。
4. 目录条目不用改，市场按 npm 版本或 GitHub HEAD 检查更新。

## 收录要求对照

| 要求 | 本仓库状态 |
|---|---|
| `package.json` 声明 `dsh.bundle.patch` | 已声明，指向 `cordis.patch.yml` |
| 仓库有真实可用代码 | 有（四格式解码；12 个工具 = 1 个统一入口 + 11 个分析工具；12 个命令） |
| 仓库满 1 天 | 建库后次日再提 PR |
| 加 `dsh-plugin` topic | 建库时加 |
| 描述只说功能、不夸大 | `registry-entry.yml` 已按实际能力写 |
| 依赖写清楚 | README 已注明 `.project`/`.dvp` 需要 Python 3.9+ |
