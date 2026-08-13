[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md)

# Codex SwitchBridge

**在已保存的 Codex 账号与兼容 Responses 的 API 提供商之间无缝切换，让两种模式共用本地对话历史，并分别查看每个账号或 API 的本地 Token 用量。**

Codex SwitchBridge 会在一次受保护的切换操作中同时更新凭据和提供商路由。账号模式与兼容的 API 提供商模式使用同一个本地历史目录，因此更改 Codex 的身份验证方式不会把新对话拆分到不同的时间线中。

VS Code 扩展会在编辑器区域打开图形化仪表盘，用于展示当前模式、共享历史状态、账号配额重置时间以及本地 Token 总用量。已保存账号和 API 提供商会显示在同一个扁平路由列表中。Token 明细包含按来源统计的环形图，橙色历史图表则可按天、周或月汇总本地记录。仪表盘既可以跟随 VS Code 的显示语言，也可以立即在英文与简体中文之间切换。

## 使用预览

打开活动栏中的 **Codex SwitchBridge** 后，已保存账号和 API 提供商会作为同级条目显示在同一个扁平的 **账号与 API 路由** 列表中，同时自动打开仪表盘或将其切换到前台。你可以在路由列表中管理账号和 API，在宽屏仪表盘中查看配额、重置时间、自动切换状态和本地 Token 历史。

![Codex SwitchBridge 英文深色仪表盘](./assets/screenshots/dashboard-en-dark.png)

同一个仪表盘可以立即切换为简体中文：

![Codex SwitchBridge 简体中文浅色仪表盘](./assets/screenshots/dashboard-zh-light.png)

Codex SwitchBridge 支持 Windows、macOS 和 Linux，可以在 VS Code 中使用，也可以通过命令行使用。

[![GitHub 版本](https://img.shields.io/github/v/release/baoshichao001-dev/codex-switchbridge)](https://github.com/baoshichao001-dev/codex-switchbridge/releases)
[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/baoshichao001-dev.codex-switchbridge?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=baoshichao001-dev.codex-switchbridge)
[![许可证：MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

## 两种模式，一份本地对话历史

```text
Codex 账号模式  <->  Codex SwitchBridge  <->  Responses API 提供商模式
                               |
                       CODEX_HOME 中的共享历史
```

| 功能 | SwitchBridge 的处理方式 |
| --- | --- |
| 账号与 API 切换 | 同时应用所选账号凭据或 API 提供商配置，以及与其匹配的 Codex 配置 |
| 共享对话历史 | 两种模式使用同一个 Codex 历史目录，因此都能看到新建的本地对话 |
| 本地 Token 用量 | 在本地索引 Codex rollout 计数器，按天、周或月绘制使用情况，并按已保存账号或 API 提供商拆分统计 |
| 状态保留 | 应用下一个模式前，先保存即将退出的账号或提供商凭据 |
| 安全切换 | 串行执行并发切换，以原子方式写入身份验证数据，并保留可用于回滚的备份 |
| 重载处理 | 当 Codex 扩展需要读取新的身份验证状态时，默认显示不阻塞操作的重载按钮 |

> 共享对话历史只在一个 `CODEX_HOME` 内生效。它不会复制或合并 ChatGPT 网页历史、Codex Cloud 任务、连接器、配额，也不会在设备之间同步对话历史。

## 快速开始

### VS Code 扩展

从 [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=baoshichao001-dev.codex-switchbridge) 安装扩展。你也可以打开 VS Code 的扩展视图，搜索 `Codex SwitchBridge` 或 `@id:baoshichao001-dev.codex-switchbridge`。

如需离线安装，请从 [GitHub Releases](https://github.com/baoshichao001-dev/codex-switchbridge/releases) 下载最新的 `.vsix` 文件，然后运行 **Extensions: Install from VSIX...**。也可以在终端中执行下面的命令。请将 VERSION 替换为下载文件名中的版本号。

```bash
code --install-extension codex-switchbridge-VERSION.vsix
```

打开活动栏中的 **Codex SwitchBridge**。扁平的 **账号与 API 路由** 列表会把已保存账号和 API 提供商放在侧边栏的同一个目录下，仪表盘则会在中央编辑器区域自动打开或回到前台。标题栏中的 **打开仪表盘** 操作仍然可以作为备用入口。

### CLI

从 GitHub Release 安装 CLI 压缩包：

```bash
npm install --global ./codex-switchbridge-cli-0.3.0.tgz
codex-switchbridge --version
```

发布到 npm 后，可以从注册表安装同一个软件包：

```bash
npm install --global codex-switchbridge-cli
```

## 在账号与 API 提供商之间切换

在 VS Code 中使用 **切换账号** 或 **切换 API 提供商**。SwitchBridge 会保存当前选择，更新 `auth.json` 和 `config.toml`，然后刷新账号与提供商视图。

通过 CLI 操作：

```bash
# 切换到已保存的 Codex 账号
codex-switchbridge use work

# 切换到已保存且兼容 Responses 的 API 提供商
# 默认启用共享本地历史
codex-switchbridge mode team-api

# 兼容性需要时，保留提供商专属历史
codex-switchbridge mode team-api --separate-history
```

使用 `codex-switchbridge use <name>` 返回指定账号。如果 `mode account` 只能识别出一个已保存账号，它会恢复该账号。如果保存了多个账号，CLI 会要求你通过 `use <name>` 明确选择，而不会自行猜测。

API 提供商配置会保存写入 `auth.json` 的身份验证内容，以及写入 `config.toml` 的提供商配置。共享历史要求设置 `wire_api = "responses"`，并为提供商配置有效的 `base_url`。

## 编辑器仪表盘、配额重置时间与本地 Token 用量

VS Code 仪表盘会读取当前 `CODEX_HOME` 下本地 Codex rollout 文件中的账号配额元数据和累计 `token_count` 事件。它可以显示：

- 账号服务返回的每个配额窗口的剩余百分比，包括 5 小时、7 天以及具名限制；
- 每个可用配额重置时间的秒级实时倒计时；
- 同一重置时间对应的本地时间，包括秒和时区偏移；
- 上游返回的精确 UTC 时间戳，并在存在时保留毫秒；
- 账号服务提供该数据时，可用的已获得速率限制重置次数；
- 当前账号存在可用的已获得重置次数时，提供需要确认的 **使用一次重置** 操作；
- 已记录的总 Token、输入、输出、缓存输入和推理输出；
- 已归属和未归属的用量合计；
- 每个账号和 API 提供商的用量与会话数；
- 按互斥的账号、API 提供商和未归属总量进行比较的来源环形图；
- 支持来源和日期筛选的橙色日、周或月用量图；
- 所选范围的总量、平均值、峰值和预估用量；
- 索引覆盖范围、会话数、开始跟踪时间和最后刷新时间。

重置时钟优先使用配额服务返回的绝对时间戳。如果服务只返回相对倒计时，SwitchBridge 会在查询时计算对应的时间戳。缺失、无效或已经到期的重置元数据都会明确标出。倒计时根据系统时钟重新计算，无需刷新整个仪表盘即可更新。账号配额请求与 OAuth Token 刷新会依次尝试 `codex-switchbridge.proxy`、VS Code 的 `http.proxy`，以及扩展宿主的 `HTTPS_PROXY`、`HTTP_PROXY` 或 `ALL_PROXY` 环境变量。解析环境变量时仍会遵守 `NO_PROXY`。专用代理设置仅作用于当前计算机，不参与设置同步。VS Code 会把它存入本地设置。如果代理 URL 中含有凭据，请优先使用无需身份验证的本地代理，或妥善保护计算机设置文件。

使用仪表盘标题栏中的语言选择器，可以选择 **自动**、**English** 或 **简体中文**。自动模式会跟随 VS Code 的显示语言；明确选择某种语言后，该设置会保存在当前窗口中，并且无需重载 VS Code 即可生效。

重置操作使用官方 Codex App Server 方法。执行前会确认同一个已保存账号仍处于活动状态并请求用户确认；每次最多使用一个已获得的重置次数，带有幂等键，完成后会刷新配额。如果已安装的 Codex 版本不支持使用重置次数，SwitchBridge 会改为打开官方 Usage 页面。

输入和输出共同构成记录的总量。缓存输入已包含在输入中，推理输出也已包含在输出中，因此不会再次累加这两个数值。环形图只使用互斥的已归属来源总量，不会重复计算缓存输入或推理输出。

SwitchBridge 开始本地跟踪后，才会记录每个选项的用量归属。此后，索引会把每次 Token 增量归属到 Codex 记录该增量时处于活动状态的账号或 API 提供商，即使同一段对话跨越了模式切换也是如此。旧的共享 `openai` 会话无法安全地归属到某一个已保存条目，因此会保留在 **早期或未归属** 类别中。旧的提供商标记会话只有在其提供商 ID 只匹配一个已保存配置时才会归属。

账号服务提供的是剩余百分比，而不是绝对的剩余 Token 数。历史图表记录的是设备本地活动计数器，不代表账单、费用或远端余额。无法精确确定日期的旧索引活动会标记为预估，日期不可靠的活动不会进入图表。除非 API 提供商提供兼容的配额接口，否则其配置只显示本地计数器。SwitchBridge 不会上传 rollout 内容。本地索引只保存计数器、时间戳、文件指纹和不透明 ID，不保存对话文本、路径、账号标签、提供商名称或凭据。使用 **刷新本地 Token 用量** 可以立即重新索引；否则扩展会在常规后台维护期间刷新索引。

## 对话历史如何保持可见

Codex 通常会按模型提供商对本地对话进行分组。自定义提供商 ID 可能导致返回账号模式后看不到某些对话，即使对应文件仍然存在。

SwitchBridge 会避免新对话出现这种分裂：

1. 账号模式使用 Codex 内置的 `openai` 提供商。
2. 兼容 Responses 的 API 提供商保留相同的历史身份，同时由 SwitchBridge 应用其 API 密钥和基础 URL。
3. 切换回账号模式时，恢复账号凭据和原始 OpenAI 路由。

因此，两种模式会读取同一个 `CODEX_HOME` 下的同一份本地对话历史。SwitchBridge 同步的是用于索引历史的路由，而不是在每次切换后复制对话文本。

VS Code 扩展和兼容的 CLI 提供商切换默认都会启用共享历史。在 VS Code 中，可通过 `codex-switchbridge.shareHistoryAcrossProviders` 控制此功能。

### 修复旧的提供商标记对话

启用共享路由前创建的对话可能仍使用提供商专属 ID。要将它们纳入共享本地历史：

1. 停止当前正在进行的 Codex 输出。
2. 运行 **Codex SwitchBridge: Repair Shared Conversation History**。
3. 修复完成后，使用状态栏中的 **建议重载** 操作。

修复命令会先创建备份，只修改提供商身份字段，并验证 JSONL 与 SQLite 记录。如果检查期间 rollout 文件发生变化，命令会停止。扩展激活时绝不会改写历史。只有执行这项维护命令时才需要 Python 3。

有关准确范围和安全检查，请参阅[跨模式对话历史](./docs/shared-history.md)。

## 功能

- 在 VS Code 中一键切换本地或同步的 Codex 账号与 API 提供商
- 将已保存账号和 API 提供商作为同级条目显示在一个扁平的侧边栏路由列表中
- 通过一条 CLI 命令切换账号或 API 提供商
- 为兼容 Responses 的提供商路由共享本地对话历史
- 宽屏编辑器仪表盘，提供图形化配额、精确重置时钟、已获得重置次数的使用功能、来源环形图，以及可按天、周或月筛选的本地 Token 历史
- 运行时切换英文与简体中文仪表盘，并提供本地化的 VS Code 命令和设置
- 显示账号配额、刷新 Token，并轮换执行后台维护
- 将已保存账号和提供商存储在本地或通过 VS Code 设置同步
- 可选择加密已保存的身份验证数据
- 导入和导出已保存账号
- 先备份，再修复旧的提供商标记本地对话
- 跨窗口切换锁与回滚快照

## CLI 命令

| 命令 | 说明 |
| --- | --- |
| `codex-switchbridge add <name>` | 运行 `codex login`，并将结果保存为具名账号 |
| `codex-switchbridge list` | 列出已保存账号和 API 提供商 |
| `codex-switchbridge use <name>` | 切换到已保存账号并恢复账号模式 |
| `codex-switchbridge mode [name]` | 显示当前模式，或切换到默认共享历史的 API 提供商 |
| `codex-switchbridge mode <name> --separate-history` | 切换到使用提供商专属本地历史的 API 提供商 |
| `codex-switchbridge remove <name>` | 删除已保存账号 |
| `codex-switchbridge quota [name]` | 显示账号配额用量 |
| `codex-switchbridge current` | 显示当前账号或 API 提供商模式 |
| `codex-switchbridge refresh [name]` | 刷新账号访问 Token |
| `codex-switchbridge export [file]` | 将已保存账号导出为 JSON |
| `codex-switchbridge import <file>` | 从 JSON 文件导入已保存账号 |

使用 `--auth-dir <path>` 或 `CODEX_SWITCHBRIDGE_AUTH_DIR`，可以将已保存条目放在默认 Codex 目录之外。使用 `--password` 或 `CODEX_SWITCHBRIDGE_PASSWORD` 解锁加密条目。

## VS Code 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `codex-switchbridge.language` | `auto` | 跟随 VS Code，或在仪表盘中使用英文或简体中文 |
| `codex-switchbridge.proxy` | `""` | 仅作用于当前计算机的 HTTP(S) 代理，用于账号配额请求和 OAuth Token 刷新；不参与设置同步；留空时使用 VS Code 和扩展宿主的代理设置 |
| `codex-switchbridge.shareHistoryAcrossProviders` | `true` | 让账号模式与兼容的 API 提供商模式都能看到新的本地对话历史 |
| `codex-switchbridge.reloadWindowAfterSwitch` | `statusBar` | 切换后显示重载操作、完全不提示或自动重载 |
| `codex-switchbridge.quotaRefreshInterval` | `30` | 每个时间间隔检查一个已保存账号，执行 Token 维护和配额刷新 |
| `codex-switchbridge.tokenAutoUpdate` | `true` | 在后台维护期间刷新已经过期或即将过期的已保存账号 Token |
| `codex-switchbridge.showStatusBar` | `true` | 在状态栏显示当前选择、配额、Token 用量和重载建议 |
| `codex-switchbridge.authDirectory` | `""` | 将本地已保存条目存入此目录；留空时使用默认 Codex 目录 |

## 数据与切换安全

本地账号使用 `auth_{name}.json`，本地 API 提供商使用 `provider_{name}.json`。VS Code 也可以将加密条目保存在同步的扩展存储中。

切换操作覆盖当前 `auth.json` 前，SwitchBridge 会把即将退出的账号或提供商的最新凭据写回对应的已保存条目。随后，它会在一个跨进程锁内更新身份验证、提供商路由和共享历史路由状态。身份验证文件采用原子替换；如果转换失败，则恢复快照。

配额查询和本地 Token 索引都是只读操作。它们不会轮换 Token、改写已保存的身份验证数据或修改对话文件。Token 维护是单独的操作。

部分 Codex 工具会在启动时缓存身份验证。SwitchBridge 无法强制另一个扩展进程清除该缓存，因此成功切换文件后，仍可能需要重载 VS Code 窗口。默认情况下，重载建议会保留在状态栏中，而不会反复弹窗。

请勿同时运行 **Codex Account Switch** 和 Codex SwitchBridge。这两个扩展会写入相同的本地 Codex 文件。

## 开发

```bash
npm install
npm run build
npm run verify
```

仪表盘视觉测试还需要 Playwright Chromium 及其 Linux 系统依赖：

```bash
npx playwright install --with-deps chromium
npm run test:visual -w packages/vscode
```

对于没有 `/etc/fonts/fonts.conf` 的精简 Linux 镜像，必须通过 `FONTCONFIG_FILE` 和 `FONTCONFIG_PATH` 提供有效的 Fontconfig 配置，否则 Chromium 无法测量或渲染文字。

项目结构：

```text
packages/
  core/     共享身份验证、提供商路由、历史路由、配额和存储逻辑
  cli/      命令行界面
  vscode/   VS Code 扩展
scripts/    历史维护和发布辅助工具
docs/       架构、行为和部署说明
```

发布流程请参阅[部署](./docs/deployment.md)。

## 项目来源与许可证

Codex SwitchBridge 是一个独立的开源项目，源自 [jqknono/codex-account-switch](https://github.com/jqknono/codex-account-switch)，并由 `baoshichao001-dev` 进行了大量修改。

本项目采用 [MIT 许可证](./LICENSE)发布，并保留上游项目的版权声明和许可证文本。
