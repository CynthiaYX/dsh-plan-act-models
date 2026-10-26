# 安装说明

`dsh-plan-act-models` 是一个**纯插件**的 DSH bundle：装上就在对话框里得到一个 **Plan / Act 模式
下拉框**，并可选地按模式自动切换模型。它不改宿主代码、不存 API Key。

安装包：`dsh-plan-act-models-0.4.0.tgz`（`npm pack` 产物）。别人给你的就是这个 tarball；
也可以直接从 GitHub Release 取（本仓库每次打 `v*` tag 都会挂上同名的 tgz 与稳定名
`dsh-plan-act-models.tgz`），命令里把路径或 URL 换成你手里的那份即可。

## 装前确认

| 项 | 要求 |
| --- | --- |
| DSH | 与本包开发时同一大版本（`@deepseek-ai/dsh@0.2.1-rc.3` 或兼容版本） |
| Profile | 桌面版用应用自带的 `desktop` profile；CLI/Web 用你自己起的普通 profile |
| 网络 | 装本地 tarball 时不需要；从 GitHub / npm 装时需要能访问对应站点 |

## 路线 A：桌面版（推荐）

桌面版的 profile 由 Electron 独占管理（在外部执行 `dsh --profile desktop …` 会直接报
`profile "desktop" is managed exclusively by the Electron application`），因此必须用应用内的插件界面：

1. 打开 **设置 → 插件**，进入插件管理 / 本地安装入口
2. 选择 **从本地文件安装**，指向 `dsh-plan-act-models-0.4.0.tgz` 的绝对路径
3. 等安装完成后 **重启应用**（新装的 bundle 需要重启才会被加载）
4. 打开 **设置 → 双轨 · Plan / Act 模型**，确认页面能正常显示（不是「宿主没有提供配置项」）

## 路线 B：CLI / Web 等普通 profile

在装 DSH 的机器上执行（`<profile>` 换成你的 profile 名）：

```powershell
# 本地 tarball
dsh plugin --profile <profile> add "C:\路径\dsh-plan-act-models-0.4.0.tgz"
# 或：直接装最新 Release 附件 / 锁到某个 tag 的源码
dsh plugin --profile <profile> add "https://github.com/CynthiaYX/dsh-plan-act-models/releases/latest/download/dsh-plan-act-models.tgz"
dsh plugin --profile <profile> add "github:CynthiaYX/dsh-plan-act-models#v0.4.0"
```

- 安装成功后 Launcher 会把新 bundle 自动写进该 profile `package.json` 的 `dsh.profile.bundles`，
  不需要手工编辑 profile。
- 之后重启该 profile 的 Host。
- 若 `dsh` 命令不在 PATH，直接用安装目录里的：`D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`。

## 装完的配置步骤

1. **设置 → 双轨 · Plan / Act 模型**
2. 分别填 **Plan** 与 **Act** 的 provider、model、思考复杂度（思考复杂度可以留空 = 跟随模型默认；
   下拉项来自宿主的模型目录，不支持思考复杂度的模型不会出现该字段的有效选项）
3. 想让它**自动**按模式切模型，勾选 **启用自动切换** 并保存；不勾也可以，下拉框照样能手动切

保存前两组都必须是完整的 provider + model（下拉框的两项都指向它们）。只想让某个项目不参与，
可以在「项目覆盖」里把它设成 `off`。

## 验证清单

- [ ] 设置页能保存，重新打开仍是刚才的值
- [ ] 对话框底部、**模型选择器左边**出现一个下拉框，两项分别是 `Plan：…` / `Act：…`
- [ ] 选 `Act` → 原生模型选择器同步变成 Act 那个模型；刷新页面后选择还在
- [ ] 悬停下拉框能看到 `provider/model (effort) · 全局配置`（来自项目覆盖时是 `· 项目覆盖：<工作区>`）
- [ ] 在原生选择器里手选一个不属于两项的模型 → 下拉框显示灰的 `自定义：<模型>`
- [ ] 把某个项目设成 `off`，打开那个工作区的会话 → 两项都灰掉并标 `此项目已停用`
- [ ] 关掉「启用自动切换」→ 下拉框**仍可选**，只是悬停提示末尾多了 `· 自动切换已关闭`
- [ ] 会话进入 Plan 模式 → 下拉框自动跳到 `Plan`，随后仍可手动改回 `Act` 且不会被改回
- [ ] 在 `/plan` 下手动选 `Act` → 对话继续用 Act 模型，插件不干预
- [ ] 批准 `exit_plan_mode` 进入实施 → 强制切到 `Act`（忽略之前选的是什么）
- [ ] 计划被取消 / `/plan off` → 模型**不变**
- [ ] 把 Plan 那一项填成不存在的 model → 该项灰掉并显示 `未配置`；选中时会显示错误小字
- [ ] 把某个项目覆盖设成 `override` 但路由留空 → 保存时就被拦下（不会等到运行时才报错）
- [ ] subagent / 后台委派任务不受影响（会话里根本不显示这个下拉框）
- [ ] 不完整的路由配置 → 日志里各告警一次「路由缺少 provider 或 model，自动切换已跳过」

### 怎么确认「模型真的切了」

以请求日志为准，不看界面：

```powershell
$node = 'D:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
# 仓库里 tools\read-header.mjs 的路径（克隆目录或已安装的 bundle 目录都行）
$tool = 'D:\path\to\dsh-plan-act-models\tools\read-header.mjs'
& $node $tool "$env:USERPROFILE\.dsh\sessions\<session-dir>\session.v4.jsonl.zstd"
```

（`read-header.mjs` 会打印每个 `request/header` 的 provider / model / reasoningEffort。）
由于下拉框走的是宿主原生的 `session.selectModel`，这里看到的就是你选的那一项，与原生选择器一致。

注意该会话文件是**多帧 zstd**，一次 `zstdDecompressSync` 只能解出第一帧（244 字节的会话头）；
`read-header.mjs` 已经按帧循环解压，直接用它即可。

## 排错

| 现象 | 处理 |
| --- | --- |
| 设置里看不到「双轨 · Plan / Act 模型」 | Loader 里该插件的行没启用；或安装后没重启 |
| 页面显示 `宿主没有提供配置项「plan-act-models」` | 插件的 Host 半边没加载成功，先看启动日志里有没有 `plan-act-models` 相关报错 |
| 页面显示 `读取配置失败：…` | settings 镜像报错，按提示信息排查 |
| 对话框里没有这个下拉框 | 先确认设置页能正常读取配置（镜像未就绪时刻意不显示）；再看是不是 subagent 会话；最后确认 profile 安装的是不是新版 bundle |
| 两项都灰掉，标着 `此项目已停用` | 当前工作区在项目覆盖里被设成 `off`，改成 `inherit` 或 `override` |
| 某一项标着 `未配置` | 该项的 provider/model 不完整，到设置里补全或重新选 |
| 悬停提示里有 `宿主不支持切换模型` | 这个版本的 Host 没有暴露 `session.selectModel`，下拉框只能展示不能切换 |
| 选了之后右侧出现 `session/model-unavailable: …` | 该模型不在当前宿主的可用目录里；到设置里按下拉重新选一次 |
| 自动切换没发生 | 依次看：总开关是否打开、工作区是否被设成 `off`、两条路由是否完整（日志会各告警一次） |
| 卸载 | 在插件界面移除，或从 profile `package.json` 依赖与 `dsh.profile.bundles` 中删掉该包，再重启 |

## 已知限制（影响判断，不影响可用性）

1. 切一项等于宿主的原生换模型，**会把该模型同时写进 profile 的全局默认模型**
   （和手动改原生选择器完全一样）。若你希望全局默认保持不变，切换后再用原生选择器改回来。
2. 两条配置都不指定思考复杂度时，两项的 provider/model 完全相同，下拉框只能按 plan 模式
   决定显示哪一项（语义上等价）。
3. 在原生选择器里手选的模型若恰好等于某一项的 route，会显示成那一项（语义等价，不算错）。

细节见包内 `README.md`。
