# 安装说明

`dsh-plan-act-models` 是一个**纯插件**的 DSH bundle：装上即可给 Plan / Act 两种模式分别指定
provider + model + 思考复杂度。它不改宿主代码、不存 API Key、不改写你的全局默认模型。

安装包：`dsh-plan-act-models-0.2.0.tgz`（`npm pack` 产物）。别人给你的就是这个 tarball；
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
2. 选择 **从本地文件安装**，指向 `dsh-plan-act-models-0.2.0.tgz` 的绝对路径
3. 等安装完成后 **重启应用**（新装的 bundle 需要重启才会被加载）
4. 打开 **设置 → 双轨 · Plan / Act 模型**，确认页面能正常显示（不是「宿主没有提供配置项」）

## 路线 B：CLI / Web 等普通 profile

在装 DSH 的机器上执行（`<profile>` 换成你的 profile 名）：

```powershell
# 本地 tarball
dsh plugin --profile <profile> add "C:\路径\dsh-plan-act-models-0.2.0.tgz"
# 或：直接装最新 Release 附件 / 锁到某个 tag 的源码
dsh plugin --profile <profile> add "https://github.com/CynthiaYX/dsh-plan-act-models/releases/latest/download/dsh-plan-act-models.tgz"
dsh plugin --profile <profile> add "github:CynthiaYX/dsh-plan-act-models#v0.2.0"
```

- 安装成功后 Launcher 会把新 bundle 自动写进该 profile `package.json` 的 `dsh.profile.bundles`，
  不需要手工编辑 profile。
- 之后重启该 profile 的 Host。
- 若 `dsh` 命令不在 PATH，直接用安装目录里的：`D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`。

## 装完的配置步骤

1. **设置 → 双轨 · Plan / Act 模型**
2. 分别填 **Plan** 与 **Act** 的 provider、model、思考复杂度（思考复杂度可以留空 = 跟随模型默认；
   下拉项来自宿主的模型目录，不支持思考复杂度的模型不会出现该字段的有效选项）
3. 勾选 **启用自动切换** 并保存

启用前两组必须都完整。只想让某个项目不切换，可以在「项目覆盖」里把它设成 `off`。

## 验证清单

- [ ] 设置页能保存，重新打开仍是刚才的值
- [ ] 会话进入 Plan 模式 → 请求走 Plan 路由（含思考复杂度）
- [ ] 批准 `exit_plan_mode` 后，**该轮之后的第一个请求**走 Act 路由
- [ ] 在原生选择器里手动换模型（**只改思考复杂度也算**）→ 只是临时覆盖，下一次真正的 Plan↔Act 切换后被清除
- [ ] 把 Plan 路由填成不存在的 model → 请求被阻止并明确报错（不静默回退）
- [ ] 把某个项目覆盖设成 `override` 但路由留空 → 保存时就被拦下（不会等到运行时才报错）
- [ ] 关掉总开关再打开 → 当前会话按当前模式恢复路由，不需要先做一次 Plan↔Act 切换
- [ ] `agent-default-model` 的配置没有被改写（全局默认模型保持原样）
- [ ] subagent / 后台委派任务不受影响

### 怎么确认「Plan 路由真的生效了」

路由判定以请求日志为准，不看界面：

```powershell
$node = 'D:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
# 仓库里 tools\read-header.mjs 的路径（克隆目录或已安装的 bundle 目录都行）
$tool = 'D:\path\to\dsh-plan-act-models\tools\read-header.mjs'
& $node $tool "$env:USERPROFILE\.dsh\sessions\<session-dir>\session.v4.jsonl.zstd"
```

（`read-header.mjs` 会打印每个 `request/header` 的 provider / model / reasoningEffort。）
Plan 模式下这里应当是 Plan 路由的值，Act 模式下应当是 Act 路由的值。

注意该会话文件是**多帧 zstd**，一次 `zstdDecompressSync` 只能解出第一帧（244 字节的会话头）；
`read-header.mjs` 已经按帧循环解压，直接用它即可。

## 排错

| 现象 | 处理 |
| --- | --- |
| 设置里看不到「双轨 · Plan / Act 模型」 | Loader 里该插件的行没启用；或安装后没重启 |
| 页面显示 `宿主没有提供配置项「plan-act-models」` | 插件的 Host 半边没加载成功，先看启动日志里有没有 `plan-act-models` 相关报错 |
| 页面显示 `读取配置失败：…` | settings 镜像报错，按提示信息排查 |
| 保存后不生效 | 按设计只影响新会话与下一次真正的 Plan↔Act 切换；已存在的会话不会立即切换 |
| 请求被阻止并提示模型不可用 | 配置里的 provider/model 与当前宿主可用目录不一致，到设置里按下拉重新选一次 |
| 卸载 | 在插件界面移除，或从 profile `package.json` 依赖与 `dsh.profile.bundles` 中删掉该包，再重启 |

## 已知限制（影响判断，不影响可用性）

1. 原生模型选择器上的显示可能滞后于真实请求路由（隔离优先），真实路由以请求日志为准。
2. 手动改模型靠对比会话自身解析出的路由识别；恰好选回完全相同的值时无法区分（语义等价）。
3. `system-prompt/assemble` 里的 `{{provider}}`/`{{model}}` 变量比请求路由晚一格。
4. 路由优先级靠监听器注册顺序：插件用 `{prepend:true}` 盖过宿主的模型选择；若将来有别的包在插件
   之后也用 `prepend` 装选择，那个包会接管，本插件会把它的值当手动选择并停止改写。

细节见包内 `README.md`。
