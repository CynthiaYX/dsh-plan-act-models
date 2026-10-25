# 双轨 · Plan / Act 模型（dsh-plan-act-models）

按 RooCode 的 Plan/Act 思路给 DeepSeek Harness 加一层纯插件实现：

- 会话处于 **Plan 模式**时，模型请求使用你配置的 **Plan 路由**（provider + model + 思考复杂度）。
- 离开 Plan（Act）时，**批准 `exit_plan_mode` 之后的第一条模型请求**就换成 **Act 路由**。
- 两组路由各自独立，可以指向不同的 provider / 连接；插件不存 API Key，全部复用宿主凭据。
- 手动在原生模型选择器里换模型 = 当前模式的**临时覆盖**，下一次真正的 Plan↔Act 切换时清除，不会写回配置。
- 配置非法时**失败关闭**：请求被阻止并报出是哪一项不合法，不静默回退、不自动换 provider。
- 只作用于 runtime-root 会话（Web/CLI）；**不接管 subagent / 后台委派任务**。

## 安装

分发包是 `dsh-plan-act-models-0.2.0.tgz`（`npm pack` 产物，无运行期依赖、可离线安装）。
完整步骤、验证清单与排错见 **[INSTALL.md](./INSTALL.md)**，安装路线摘录：

- **桌面版**：应用内 **设置 → 插件 → 从本地文件安装** 选 tarball，然后重启应用。
  桌面 profile 由应用独占管理，外部 `dsh --profile desktop …` 会报
  `managed exclusively by the Electron application`。
- **CLI / Web 普通 profile**：`dsh plugin --profile <profile> add "<绝对路径>\dsh-plan-act-models-0.2.0.tgz"`，
  Launcher 会自动把 bundle 写进 `dsh.profile.bundles`，然后重启。
- **直接从本仓库装**（不需要本地有 tarball）：装最新 Release 附件，或按 git 引用装源码——

  ```powershell
  dsh plugin --profile <profile> add "https://github.com/CynthiaYX/dsh-plan-act-models/releases/latest/download/dsh-plan-act-models.tgz"
  # 或锁定到某个 tag 的源码
  dsh plugin --profile <profile> add "github:CynthiaYX/dsh-plan-act-models#v0.2.0"
  ```

  两者都指向同一套文件；Release 附件是 `npm pack` 产物，`github:` 走整仓 tarball，
  仓库根就是包根，没有需要裁剪的子目录。

  > 目前仓库还没有打 tag，所以上面的 Release 地址与 `#v0.2.0` 引用暂时取不到东西；
  > 在第一个 `v*` tag 推上去之前，请用本地 tarball 安装。发布见下文「发布流程」。

配置入口：**设置 → 双轨 · Plan / Act 模型**（首次默认关闭）。

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

1. `node --test` 全绿（56 个用例）。
2. `npm pack --dry-run` 的文件列表里没有 `lib/*.js`（该 glob 曾指向不存在的文件）。
3. `package.json` 无 `private`，`license` 与 `repository` 齐全。
4. `cordis.patch.yml` 的 `id` 与 `client.js` 的 `ENTRY` 逐字相同 —— `client.test.mjs`
   做静态比对，`client-bundle.test.mjs` 真的执行 `apply()` 并断言传进
   `configForms.get()` 的 namespace 就是 patch 的 `id`。改一处必须改另一处。
5. 若要同时发 npm，上传后 `npm view dsh-plan-act-models version` 应回显对应版本。

## 配置

| 字段 | 含义 |
| --- | --- |
| `enabled` | 总开关。关闭后不再自动切换，也不再阻塞请求，当前模型保持不变。 |
| `plan` | Plan 模式路由：`provider`、`model`、`reasoningEffort`（留空 = 跟随模型默认）。 |
| `act` | Act 模式路由，同上。 |
| `projects` | 按工作区根目录（`agent.session.header.cwd`）的覆盖表：`inherit` / `override` / `off`。 |

启用前 Plan 与 Act 必须都完整（provider + model）。项目覆盖是**完整的一对**，不做半合并；
项目设为 `off` 时该项目内不做任何切换。

保存后按设计只影响**新会话**与**已存在会话的下一次真正的 Plan↔Act 切换**；界面没有
「立即应用到当前会话」按钮（RooCode 同样不把临时选择写回配置）。

## 状态说明

设置页顶部会直接反映读取结果：

- `正在读取配置…`：客户端的 settings 镜像还在拉取。
- `宿主没有提供配置项「plan-act-models」`：Loader 行没启用/没加载，此时页面不会给你一个
  写了也存不进去的表单。
- `读取配置失败：…`：镜像报错，原样展示原因。

## 行为边界

- 新会话按当前模式解析：非 Plan 会话的第一条请求即使用 Act 路由。
- **已经存在的会话**（重启后恢复、或插件刚启用）不会立刻被切换，等下一次真正的 Plan↔Act 切换才接管。
- 路由判定读的是宿主**已提交**的 plan 状态（`agentPresets.serviceFor(agent, 'planMode').get(agent)`，
  退路是根平面的 `sessionProjections.stateOf(session, 'plan')`），不是消息里的 `/plan` 文本。
- 不改写全局默认模型：请求在 `agent/request` 里被改写，profile 里 `agent-default-model` 保持原样。
- 原生模型选择器上的显示可能滞后（架构优先），真实生效的路由以请求日志/插件状态为准。

## 已知限制

1. 手动改模型靠对比「会话自身选择解析出的路由」来识别，比较包含 provider、model **与思考复杂度**；
   若恰好选回与该值完全相同的三元组，无法区分（语义等价）。
2. `system-prompt/assemble` 里的 `{{provider}}`/`{{model}}` 变量比请求路由晚一格；路由本身不滞后。
3. 插件会过滤宿主自动追加的 `[model changed: …]` 提示，避免与实际路由矛盾；若该提示是某一步唯一的输入，则保留。
4. 若被链接安装（目录 junction / `link:`），`lib/schema.mjs` 会依次尝试裸导入宿主安装里的
   `@deepseek-ai/schemastery`、`DSH_SCHEMASTER_ROOT` 指定的副本、从 `process.execPath` 与启动参数
   往上回溯找到的 `resources/app.asar` / `app.asar.unpacked` 副本（回溯 8 层，也接受相邻的普通
   `node_modules`），最后才是 profile 里的副本。**每一份都会先校验能力**：必须带 `.volatile()`
   （schemastery ≥ 3.18.5）。profile 的上级 `node_modules` 里常残留旧副本（例如 3.18.1 的
   陈旧 junction），旧副本能 resolve 但没有 `.volatile()`，直接用会让插件在声明 Config 时就崩，
   所以现在被跳过并在报错里点名版本。全都不可用时插件整体不加载——设置页显示「宿主没有提供配置项」，
   报错列出每条试过的路径，可用 `DSH_SCHEMASTER_ROOT` 指向副本目录。
5. **优先级靠注册顺序**：插件用 `{prepend:true}` 把监听器排到 `agent/request` 最外层，因此能盖过
   宿主在 Agent 创建时装好的模型选择（它比 `agent/created` 更早注册）。宿主没有优先级 API；
   若将来某个包在插件之后也用 `prepend` 装自己的选择，它会排在我们外面并接管路由 —— 此时插件
   把这个值当作「手动选择」并停止改写。
6. 插件不保证宿主原生模型选择器显示的就是实际请求的模型（隔离优先于显示），真实路由以请求日志为准。
7. **读 plan 模式依赖宿主结构**：`plan-mode` 装在 Agent preset 内部并带 `isolate: { planMode: true }`，
   因此插件自己的 fiber 上 `ctx.get('planMode')` 永远是 `undefined`。插件改为依次尝试
   `agentPresets.serviceFor(agent, 'planMode')` 与根平面的 `sessionProjections.stateOf(session, 'plan')`。
   两者都不可用时，插件会**在日志里告警一次**并退回「按 Act 路由」——不再静默。
8. **`enabled` 关闭期间不记录手动选择**：重新打开后按当前模式恢复路由，不需要先做一次 Plan↔Act 切换。
9. **挂载失败只降级，不拖垮会话**：`attach` 是在宿主的 `agent/created` 里同步执行的，而那条路径
   不做 catch——一次抛出就会让该 Agent 永远 publish 不出来（对话框一直是禁用状态，必须关掉插件才能说话）。
   所以插件现在把挂载/卸载自己的任何异常就地吞掉，只在日志里告警一次并跳过该会话；其余会话不受影响。
   注意 `agent/request` 里的「配置不合法」仍然照常抛错，那是刻意保留的失败关闭。

## 开发

```powershell
# 在仓库根执行；`npm test` 也会跑同样六个文件
$pkg = '<克隆目录>\dsh-plan-act-models'
& $node --test "$pkg\test\routing.test.mjs" "$pkg\test\host.test.mjs" "$pkg\test\index.test.mjs" "$pkg\test\client.test.mjs" "$pkg\test\client-bundle.test.mjs" "$pkg\test\schema.test.mjs"
```

`$node` 指向安装目录里的 Node（`D:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`），
或直接用系统 `node`（需 ≥ 20，仓库在 Node 24 上验证）。

- 六个用例文件都只依赖 `node:test` 与包内源码，**不需要**运行中的 Host：
  `routing.test.mjs` 跑纯决策表（模式切换、临时覆盖、项目覆盖、非法配置阻塞），
  `host.test.mjs` 直接 import `lib/host.mjs` 验证 plan 模式读取与模型目录容错，
  `index.test.mjs` **真正加载 `index.js`** 并驱动它的三个监听器，
  `client.test.mjs` 对 `client.js` 做静态回归断言，
  `client-bundle.test.mjs` **真的执行 bundle**：伪造 `window.__ModuleLoader__` 与
  `configForms`/`slots` 两个 Service，调用 factory 拿到 module 再跑 `apply()`，断言
  注册的 settings 页 id 与传进 `configForms.get()` 的 namespace 都等于 patch 的 `id`，
  `schema.test.mjs` 校验 schemastery 解析（含「旧副本缺 `.volatile()` 必须被拒绝」）。
  `schema.test.mjs` 在找不到可用副本的机器上会走「报错必须可执行」那一条分支，不会误报失败。
- `client-bundle.test.mjs` 用 `?case=N` 查询串绕开 ESM 模块缓存：bundle 的全部效果就是那一次
  `load()` 调用，模块被缓存后第二次 import 不会重新执行。
- `index.test.mjs` 用 `DSH_SCHEMASTER_ROOT` 在系统临时目录里造一个假的 schemastery（版本号写成
  3.18.5，并把所有 helper 挂在 default export 上——打包版 `schemastery` 只有
  `export { Schema as default }`，没有任何具名导出），因此在没有宿主的机器上也能加载入口。
  这个文件是**必需的**：曾经`index.js` 引用了未定义的 `rootOf`/`resumed`，而当时 40 个用例全绿，
  因为没有任何测试 import 入口，结果发出去的包在宿主里 `fiberPhase: failed`。
- `lib/host.mjs` 把「读 plan 模式」与「枚举模型目录」从 `index.js` 拆了出来，便于无宿主测试；
  但入口本身也已经被 `index.test.mjs` 覆盖，不再有「`index.js` 无法测试」这个假设。
- `lib/routing.mjs` 是纯逻辑状态机（不依赖宿主）：新会话 Act、进入 Plan、退出 Plan 后第一条请求、
  临时覆盖与清除、恢复会话不立即切换、项目覆盖/禁用、非法配置阻塞。
- `tools/read-header.mjs` 从 `session.v4.jsonl.zstd` 里解出每次 `request/header` 与 `plan/mode`，
  用来确认「Plan 模式下真的走了 Plan 路由」：
  ```powershell
  & $node "$pkg\tools\read-header.mjs" "$env:USERPROFILE\.dsh\sessions\<dir>\session-<id>\session.v4.jsonl.zstd"
  ```
  注意该文件是多帧 zstd，一次 `zstdDecompressSync` 只能解出第一帧（244 字节的会话头）。

