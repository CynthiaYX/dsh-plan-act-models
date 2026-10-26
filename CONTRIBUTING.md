# 参与这个仓库

这是一个小插件：一个宿主半边（`index.js` + `lib/*.mjs`）和一个浏览器半边
（`client.js`，一个 `window.__ModuleLoader__` bundle）。没有构建步骤，也没有运行期依赖，
`node --test` 就是全部工具链。

## 提交信息

规范只有三条，因为这里唯一反复出问题的是**话说太多**：

```
<type>(<scope>): <summary>

<为什么，不是做了什么>
```

1. **标题**写成 `type(scope): summary`，72 字符以内，句尾不加句号。
2. 标题和正文之间**空一行**；正文每行 100 字符以内，12 行以内。
3. 正文只解释**为什么**。改了哪些文件、加了什么函数，`git show` 里都有。

能从一行看懂的改动就别写正文——一个 `fix(client): ...` 是合格的完整提交。

### type

| type | 用于 |
| --- | --- |
| `feat` | 用户可见的新能力 |
| `fix` | 修 bug |
| `docs` | 只动 README / INSTALL / 注释 |
| `test` | 只动测试 |
| `refactor` | 行为不变的结构调整 |
| `perf` | 性能 |
| `build` | `package.json`、打包、发布流程 |
| `ci` | `.github/` |
| `chore` | 杂项（版本号、忽略文件） |
| `revert` | 回滚 |
| `style` | 只动空白/格式 |

### scope

可选，用改动的主战场，不写模块全路径。本仓库常用的：

`routing`（`lib/routing.mjs` 的决策表）、`host`（`index.js` + `lib/host.mjs`）、
`client`（`client.js` bundle）、`view`（对话框里的标签）、`schema`（`lib/schema.mjs`）、
`profile`（`cordis.patch.yml` / 配置项）、`test`、`docs`。

### 例子

```
feat(view): show the resolved route beside the model selector
```

```
fix(routing): read the committed plan state on the first request after a switch

The transition only flips once, so the request that follows it still saw the
previous route and the Act model was used one turn late.
```

### 会被拒绝的写法

- 没有 `type:` 前缀的标题。
- 标题以 `.` 或 `。` 结尾。
- 正文紧贴标题（缺空行）。
- 标题超过 72 字符、正文行超过 100 字符。
- 任何形式的署名行：`Generated with …`、`🤖`、AI 协作者邮箱。
  提交解释改动本身，不解释谁敲的字。

`Merge …`、`Revert "…"`、`fixup!`/`squash!`/`amend!` 是 git 自己生成的标题，不套用上面的规则。

## 让规则自动生效

仓库里带了两个文件，逐个 clone 启用一次：

```powershell
git config core.hooksPath .githooks     # 提交时校验
git config commit.template .gitmessage  # 编辑时给模板
```

- `.githooks/commit-msg` 调用 `tools/commit-check.mjs`，不合规就拒绝提交并指出是哪一条。
  没有 Node 的机器只警告不阻断。
- 手动校验一条信息：

  ```powershell
  node tools/commit-check.mjs .git/COMMIT_EDITMSG
  node tools/commit-check.mjs --message "docs: 补充安装说明"
  ```

  也可以 `git commit --no-verify` 跳过，但 `test/commit.test.mjs` 会保证规则本身没被悄悄放宽。

## 改动前后

```powershell
npm test          # 全部用例
node --check client.js
```

`client.js` 不能 import `lib/`（它是发给页面的经典脚本），路由判定表因此在
`#region plan-act-view` 里镜像了一份。`test/client-view.test.mjs` 会把那个区块抽出来
和真正的 `resolveTarget` 逐项比对——**只改一边会让测试变红**，这是有意的。

改完 `client.js` 若要立刻在桌面版里看到效果，需要把文件同步到 profile 的链接目标并重启应用
（见 README 的「本机开发时的链接安装」）。
