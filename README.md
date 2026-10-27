# 双轨 · Plan / Act 模型（dsh-plan-act-models）

给 DeepSeek Harness 的对话框加一个 **Plan / Act 模式下拉框**，并按模式自动切换模型：

- 对话框底部、原生模型选择器左侧是一个**真正的下拉框**，两项：`Plan：<模型>` / `Act：<模型>`。
  选它就等于用宿主原生的方式换模型 —— 调的是 `session.selectModel`，所以下拉框和原生选择器
  永远显示同一个结果，重启后也还在（选择存在 `model/selection` 投影里）。
- **plan 模式与模型的强绑定已经解除**：`/plan`、对话框上的 Plan 芯片、审批都不再隐式决定模型。
  进入 plan 只是**软切换**到 Plan 那一项，你可以立刻改回 Act，插件不会跟你抢。
- 唯一保留的硬规则：**批准计划进入「实施」那一刻，强制切到 Act**（忽略之前选的是什么）。
  判定只认 `exit_plan_mode` 返回 `approved: true`。
- 设置页那两组路由就是下拉框里的两项。`enabled` 只是**自动切换的总开关**；
  关掉它，下拉框照样能手动切。
- 插件不存 API Key，全部复用宿主凭据；**不接管 subagent / 后台委派任务**。

## 安装

分发包是 `dsh-plan-act-models-0.4.0.tgz`（`npm pack` 产物，无运行期依赖、可离线安装）。
完整步骤、验证清单与排错见 **[INSTALL.md](./INSTALL.md)**，安装路线摘录：

- **桌面版**：应用内 **设置 → 插件 → 从本地文件安装** 选 tarball，然后重启应用。
  桌面 profile 由应用独占管理，外部 `dsh --profile desktop …` 会报
  `managed exclusively by the Electron application`。
- **CLI / Web 普通 profile**：`dsh plugin --profile <profile> add "<绝对路径>\dsh-plan-act-models-0.4.0.tgz"`，
  Launcher 会自动把 bundle 写进 `dsh.profile.bundles`，然后重启。
- **直接从本仓库装**（不需要本地有 tarball）：装最新 Release 附件，或按 git 引用装源码——

  ```powershell
  dsh plugin --profile <profile> add "https://github.com/CynthiaYX/dsh-plan-act-models/releases/latest/download/dsh-plan-act-models.tgz"
  # 或锁定到某个 tag 的源码
  dsh plugin --profile <profile> add "github:CynthiaYX/dsh-plan-act-models#v0.4.0"
  ```

  两者都指向同一套文件；Release 附件是 `npm pack` 产物，`github:` 走整仓 tarball，
  仓库根就是包根，没有需要裁剪的子目录。

  > 当前最新 Release：**v0.4.0**（附件 `dsh-plan-act-models.tgz` 与
  > `dsh-plan-act-models-0.4.0.tgz`，两者 sha256 相同）。更新到新版只需重跑一次 `add`，
  > 把 `latest` 换成新 tag 可以锁定版本。

配置入口：**设置 → 双轨 · Plan / Act 模型**（首次默认关闭自动切换）。

### 本机开发时的链接安装

源码目录本身就是包（`dsh-plan-act-models`），开发时按 `@local/dsh-restart` 的先例手写 profile 层：

- profile `package.json` 的 `dependencies` 加
  `"dsh-plan-act-models": "link:<克隆目录>/dsh-plan-act-models"`（Windows 上写成
  `link:D:/private/DeepSeek-harness-plugin/dsh-plan-act-models` 这种正斜杠形式），
  `dsh.profile.bundles` 里追加 `"dsh-plan-act-models"`
- `node_modules\dsh-plan-act-models` 目录联接指向本仓库（等价于 pnpm `link:`）
- 本仓库自带的 `cordis.patch.yml` 由 bundle 机制自动插入 Loader 行；profile 的
  `cordis.patch.yml` 只用来**覆盖那一行的 config**（同 id），不要再写第二条 `- insert:`
- 本包的 `exports` 必须显式导出 `./package.json` 与 `./cordis.patch.yml`：宿主
  `@deepseek-ai/dsh-client-modules` 会用 `createRequire().resolve('<pkg>/package.json')`
  读 `dsh.client` 声明，不导出就会 `ERR_PACKAGE_PATH_NOT_EXPORTED`

### 发布流程

仓库 `CynthiaYX/dsh-plan-act-models` 就是分发仓库：**仓库根 = npm 包根**，tag 触发发布，
Release 附件同时提供 `dsh-plan-act-models-<version>.tgz` 与稳定名 `dsh-plan-act-models.tgz`
（后者让 `releases/latest/download/dsh-plan-act-models.tgz` 这种"永远最新"的安装/更新地址可用）。

1. 改 `package.json` 的 `version`，提交并推送。
2. 打 tag 并推送（**注意**：Windows PowerShell 5.1 不支持 `&&`，要用 `;` 或分成两行）：

   ```powershell
   git tag v<version>
   git push origin main --tags
   ```

3. `.github/workflows/release.yml` 会先校验 tag 与 `package.json` 一致，再 `npm test`、`npm pack`，
   最后把两个 tgz 挂到该 tag 的 Release 上。
4. 装/更新的人用 **设置 → 插件** 或 `dsh plugin add <Release 附件地址>` 即可，不需要本地构建。

### 上传前清单

本包**尚未发布到 npm**，GitHub Release 才是当前的发布通道。发布前依次确认：

1. `node --test` 全绿（143 个用例）。
2. `npm pack --dry-run` 的文件列表里没有 `lib/*.js`（该 glob 曾指向不存在的文件）。
3. `package.json` 无 `private`，`license` 与 `repository` 齐全。
4. `cordis.patch.yml` 的 `id` 与 `client.js` 的 `ENTRY` 逐字相同 —— `client.test.mjs`
   做静态比对，`client-bundle.test.mjs` 真的执行 `apply()` 并断言传进
   `configForms.get()` 的 namespace 就是 patch 的 `id`。改一处必须改另一处。
5. 若要同时发 npm，上传后 `npm view dsh-plan-act-models version` 应回显对应版本。

## 配置

| 字段 | 含义 |
| --- | --- |
| `enabled` | **自动切换**总开关。关闭后不再自动切模型；下拉框仍可手选。 |
| `plan` | 下拉框里 `Plan` 那一项：`provider`、`model`、`reasoningEffort`（留空 = 跟随模型默认）。 |
| `act` | 下拉框里 `Act` 那一项，同上。 |
| `projects` | 按工作区根目录（`session.header.cwd`）的覆盖表：`inherit` / `override` / `off`。 |

项目覆盖是**完整的一对**，不做半合并；项目设为 `off` 时该项目内两项都不可选。

## 对话框里的模式下拉框

composer 底部、**原生模型选择器紧左边**，样式是一枚胶囊（圆角 + 模式圆点 + 着色模式词 + 箭头），
点开后向上弹出宿主风格的卡片菜单。**Plan 的模式词是蓝色、Act 是绿色、`自定义` 是虚线灰**，
模型名本身用次级文本色 —— 所以扫一眼就知道当前在哪条轨上。

它不是 `<select>`：原生弹出层无法着色，这正是旧版看起来像一颗跑错片场的系统控件的原因。
改成「按钮 + 手写 listbox」后，配色跟着宿主 `--dsw-*` 主题变量走，深/浅色都对。

| 情况 | 下拉框显示 |
| --- | --- |
| 会话当前选择 = Plan 那一项 | `Plan：DeepSeek V4.1 Flash` |
| 会话当前选择 = Act 那一项 | `Act：DeepSeek V4.1 Flash` |
| 当前选择**两项都不是**（在原生选择器里手动换过模型） | `自定义：<模型>`（灰、虚线边框、不可选，只说明现状） |
| 当前工作区在 `projects` 里被设为 `off` | 两项都灰掉并标 `此项目已停用` |
| 某项 provider/model 不完整 | 该项灰掉并标 `未配置` |
| 宿主没有 `session.selectModel` | 两项都灰掉，悬停提示 `宿主不支持切换模型`（菜单仍可打开，那里写着原因） |

- **显示哪一项只看会话已提交的模型选择**，不看 plan 模式。所以在 plan 模式下选 Act 是允许的，
  下拉框会如实显示 `Act`。`plan` 投影只用来在两项配置完全相同时（provider/model/effort 一样）
  决定先选中哪一个。
- 选项文字里的模型名优先用模型目录的 `name`，查不到退回 model id；**思考复杂度不进正文**，只在悬停提示里：
  `Plan：DeepSeek V4.1 Flash — cline-pass/deepseek-v4.1-flash-1017 (max) · 全局配置`
  （来自项目覆盖时末尾是 `· 项目覆盖：<工作区>`）。
- 切一项 = 调宿主的 `session.selectModel`。它的三个副作用都是宿主原生的：
  校验路由 → 更新 `model/selection` 投影（所有客户端立刻同步）→ 写进会话日志。
  **同时会把该选择存成 profile 的全局默认模型**，与手动改原生选择器完全等价。
- **键盘全程可用**：`Enter`/`Space`/`↓` 打开，`↑`/`↓`/`Home`/`End` 移动，`Enter`/`Space` 选中，
  `Esc` 关闭并把焦点还给触发器，`Tab` 关闭。鼠标：点空白处关闭。
- 切换进行中控件禁用（连菜单也打不开，避免连点两次提交），失败时把 `错误码: 原因`
  显示在右侧小字里（也写进悬停提示），不会静默失败，也不会卡住下一次选择。
- 不显示的两种情况：subagent 会话（宿主从不为它们做路由）、配置镜像尚未就绪
  （`loading`/`unavailable`/`error`）或没有绑定会话。


## 两条自动规则

两条都受 `enabled` 与项目 `off` 约束，都不完整则跳过并各告警一次：

1. **进入 plan → 切到 Plan 那一项**（软切换）。判定依据是宿主 `plan/mode` 事件里 `active: true`，
   不是消息里的 `/plan` 文本。如果当前选择已经算 Plan 那一项就什么都不做；如果 Plan 那项没写
   `reasoningEffort`，则保留你手选的 effort（视为"跟随默认"）。切换完成后你随时可以改回 Act。
2. **批准计划 → 切到 Act 那一项**（硬规则）。判定依据只有一条：
   `exit_plan_mode` 的工具结果 `value.approved === true` 且不是错误结果。
   `keep planning`、失败、其它任何工具都绝不触发。

离开 plan 模式（`/plan off`、计划被取消）**不碰模型**。这就是本次改动脱钩的地方。

## 状态说明

设置页顶部会直接反映读取结果：

- `正在读取配置…`：客户端的 settings 镜像还在拉取。
- `宿主没有提供配置项「plan-act-models」`：Loader 行没启用/没加载，此时页面不会给你一个
  写了也存不进去的表单。
- `读取配置失败：…`：镜像报错，原样展示原因。

## 已知限制

1. **两条配置都不写 `reasoningEffort` 时，下拉框无法区分两项**：provider 与 model 都一样，
   "当前在哪一项"没有可比较的差异，此时按 plan 模式决出显示项（tie-break），
   选另一项的效果也只是把 effort 改回默认。
2. 手动在原生选择器里换到的模型若恰好等于某一项的 route，会显示成那一项（语义等价，不算错）。
3. `enabled` 关闭只停自动切换；它不会锁住下拉框，也不会阻止你手选一个和 plan 模式不匹配的模型。
4. 若被链接安装（目录 junction / `link:`），`lib/schema.mjs` 会依次尝试裸导入宿主安装里的
   `@deepseek-ai/schemastery`、`DSH_SCHEMASTER_ROOT` 指定的副本、从 `process.execPath` 与启动参数
   往上回溯找到的 `resources/app.asar` / `app.asar.unpacked` 副本（回溯 8 层，也接受相邻的普通
   `node_modules`），最后才是 profile 里的副本。**每一份都会先校验能力**：必须带 `.volatile()`
   （schemastery ≥ 3.18.5）。profile 的上级 `node_modules` 里常残留旧副本（例如 3.18.1 的
   陈旧 junction），旧副本能 resolve 但没有 `.volatile()`，直接用会让插件在声明 Config 时就崩，
   所以现在被跳过并在报错里点名版本。全都不可用时插件整体不加载——设置页显示「宿主没有提供配置项」，
   报错列出每条试过的路径，可用 `DSH_SCHEMASTER_ROOT` 指向副本目录。
5. **自动切换失败只降级，不拖垮会话**：`selectModel` 被拒绝（模型不在目录里、连接不可用）时
   插件只告警一次并跳过；`agent/created` 里挂载监听器抛出的异常同样就地吞掉，
   否则那个 Agent 永远 publish 不出来。
6. **挂载点只有两个事件**：每个 root Agent 的 `tools/result`（审批）与根平面的
   `session/event`（`plan/mode`）。不再有请求期改写，所以没有「比宿主更早装监听器」的优先级问题。
7. **下拉框沿用硬编码中文**：与设置页一致，没有走 Client locale 服务；`client.js` 里甚至不能出现
   `locale` 字样（`test/client.test.mjs` 有既有断言）。
8. **`conversation.input.right` 目前无人占用**，所以我们的条目稳定落在模型选择器左侧；若将来有别的
   包也注册到同一个座位，顺序由 `order` 决定（本插件是 100），届时可能需要重新排序。

## 开发

```powershell
# 在仓库根执行；`npm test` 也会跑同样八个文件
npm test
```

`$node` 指向安装目录里的 Node（`D:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`），
或直接用系统 `node`（需 ≥ 20，仓库在 Node 24 上验证）。

- 八个用例文件都只依赖 `node:test` 与包内源码，**不需要**运行中的 Host：
  `routing.test.mjs` 跑纯决策表（`resolveTarget` 矩阵、`sameTrack`/`sessionTrack`、
  两个 switch 的真值表），
  `host.test.mjs` 直接 import `lib/host.mjs` 验证模型目录容错、`committedSelection` 与 `createSwitcher`，
  `index.test.mjs` **真正加载 `index.js`** 并驱动两条事件路径（含"approved:false 不切"、
  "subagent 不挂"、"开关关闭两条都不动"），
  `client.test.mjs` 对 `client.js` 做静态回归断言（`<select>`、`selectModel`、镜像哨兵），
  `client-view.test.mjs` 从 `client.js` 里抽出 `#region plan-act-view` 那块镜像实现，用
  输入矩阵与 `lib/routing.mjs` 的 `resolveTarget`/`sessionTrack` 逐项比对，并断言选项文字是 `模式：模型`，
  `client-bundle.test.mjs` **真的执行 bundle**：伪造 `window.__ModuleLoader__` 与
  `configForms`/`slots`/`remote` 三个 Service，调用 factory 拿到 module 再跑 `apply()`，
  断言注册的 settings 页 id 与传进 `configForms.get()` 的 namespace 都等于 patch 的 `id`，
  **并带一个最小 hooks 渲染器真的把下拉框渲染出来**（选项文字与顺序、`modelSelection` 决定选中项、
  `自定义` 占位、onChange 的 payload、pending 禁用、四种降级、失败小字、开关关闭仍可选），
  `schema.test.mjs` 校验 schemastery 解析（含「旧副本缺 `.volatile()` 必须被拒绝」）。
  `commit.test.mjs` 校验提交信息格式。
- `client.js` 无法 import `lib/routing.mjs`（它是发给页面的 classic script），所以路由判定在
  `#region plan-act-view … #endregion` 之间有一份手写镜像。`client-view.test.mjs` 靠这对哨兵
  把镜像抽出来做等价断言：**改 `resolveTarget`/`sessionTrack` 就必须同步改镜像，否则测试会红**；
  哨兵被删会直接失败，不会静默空跑。
- `client-bundle.test.mjs` 用 `?case=N` 查询串绕开 ESM 模块缓存：bundle 的全部效果就是那一次
  `load()` 调用，模块被缓存后第二次 import 不会重新执行。它自带的 hooks 渲染器会重渲染
  直到 state 稳定，因为"模型目录到达"和"切换失败"都只会在第二遍才可见。
- `index.test.mjs` 用 `DSH_SCHEMASTER_ROOT` 在系统临时目录里造一个假的 schemastery（版本号写成
  3.18.5，并把所有 helper 挂在 default export 上——打包版 `schemastery` 只有
  `export { Schema as default }`，没有任何具名导出），因此在没有宿主的机器上也能加载入口。
  这个文件是**必需的**：曾经 `index.js` 引用了未定义的 `rootOf`，而当时全绿，
  因为没有任何测试 import 入口，结果发出去的包在宿主里 `fiberPhase: failed`。
- `lib/host.mjs` 把「枚举模型目录」与「用宿主的 selectModel 提交选择」从 `index.js` 拆了出来，
  便于无宿主测试。
- `lib/routing.mjs` 是纯逻辑（不依赖宿主）：`resolveTarget` 解析一项，`sessionTrack` 判断
  选择落在哪一项，`switchPlan`/`switchActOnApproval` 回答"这次事件该不该切"。
- `tools/read-header.mjs` 从 `session.v4.jsonl.zstd` 里解出每次 `request/header` 与 `plan/mode`，
  用来确认「Plan 模式下真的走了 Plan 路由」：
  ```powershell
  & $node "$pkg\tools\read-header.mjs" "$env:USERPROFILE\.dsh\sessions\<dir>\session-<id>\session.v4.jsonl.zstd"
  ```
  注意该文件是多帧 zstd，一次 `zstdDecompressSync` 只能解出第一帧（244 字节的会话头）。
