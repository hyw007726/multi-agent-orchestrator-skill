[English](./README.md) | [简体中文](./README_zh-CN.md)

# Multi-Agent Orchestrator

用 Git worktree 隔离多个代码 Agent，让它们并行开发、各改各的文件，并由后台进程负责监控、重启和验证。

Multi-Agent Orchestrator 是一个 Agent Skill，也是一套无依赖的 Node.js 本地运行时。它适合把一个较大的开发任务拆成多个边界清晰的子任务，分别交给 Claude Code、Codex、Gemini CLI，以及 Kilo Code、OpenCode 等其他代码 Agent 在独立 worktree 中完成。主会话负责拆分任务和最终合并，后台循环负责看住 worker、处理问题、跑验证命令，并生成最终交接摘要。

你可以在 Claude Code、Codex、Gemini CLI，或任何能读取 `SKILL.md` 并执行 shell 命令的本地代码 Agent 中使用它。

<!-- 后续可在这里放仪表盘截图或 GIF：
![Dashboard showing parallel worker status](docs/assets/dashboard.png)
-->

## 它解决什么问题

手动开多个终端跑 Agent 很快会遇到几个问题：上下文不一致、多个 Agent 改同一个文件、某个 Agent 卡住没人管、最后不知道该合并哪些改动。这个项目提供的是一层本地协调机制：

- **Worker agent**：在独立 git worktree 里完成一个明确的子任务。
- **Reviewer agent**：可选，只读检查任务拆分方案，提前发现边界重叠和验证缺口。
- **后台监督循环**：监控 worker 日志和文件变化，处理提问、超时、重启和验证。
- **主会话**：负责架构判断、共享基础改动、最终 diff review 和合并。

核心能力：

- 把大功能拆给多个代码 Agent 并行处理。
- 用 `coord/DECISIONS.md` 记录需求、架构约束、文件归属和关键决策。
- 用 `coord/context.json` 保存每个 worker 的任务边界和上下文。
- 用 `coord/CALLER_CONTEXT.md` 保存主会话里的重要背景，避免后台进程依赖聊天记录。
- 监控 worker 是否还活着、是否真的有进展、验证是否通过。
- 提供终端仪表盘。
- 生成确定性的 `coord/review-summary.txt`，方便主会话做最终合并。
- 支持 Claude Code、Codex、Gemini CLI，以及 Kilo Code、OpenCode、自定义适配器等其他 CLI。

## 适合什么时候用

适合有明显并行边界的任务，例如：

- 同时开发多个相互独立的页面或功能入口；
- 后端、前端、测试、迁移脚本可以拆开做；
- 在多个模块里做同类清理或迁移；
- 让多个 Agent 分头排查、修复不同问题。

不适合小改动，也不适合多个 Agent 需要反复修改同一个共享文件的任务。遇到 schema、路由、类型定义、依赖配置这类共享基础，先在主 worktree 里处理并提交，再把剩余工作拆给 worker。

## 安全提醒

本项目通过 git worktree 隔离 worker 的工作目录，但不会替你沙箱化被调用的代码 Agent。worker CLI 仍然可能按照自身权限读写文件、运行命令。

默认模板会使用各 CLI 的自动执行或跳过确认模式，目的是让后台 worker 不被交互式提示卡住。只在你能接受 review 和回滚生成代码的仓库中使用。合并前一定要看 diff；这个工具是协调层，不是 code review 的替代品。

## 前置条件

- Node.js。
- 支持 worktree 的 Git。
- 目标项目本身已经是 Git 仓库。
- 至少安装并登录一个受支持的 worker CLI，并配置好默认模型。

运行时没有 npm 依赖，不需要 `npm install`，没有 `node_modules`，也没有构建步骤。

worker 是非交互运行的。选择的 CLI 必须提前登录，并能在没有设置向导或浏览器授权弹窗的情况下回答一个很短的 prompt。

## 安装

下面的快速开始使用 `ORCHESTRATOR_HOME` 表示本仓库安装路径。

### Claude Code

```bash
git clone https://github.com/hyw007726/multi-agent-orchestrator-skill.git \
  ~/src/multi-agent-orchestrator

mkdir -p ~/.claude/skills
ln -s ~/src/multi-agent-orchestrator \
  ~/.claude/skills/multi-agent-orchestrator

export ORCHESTRATOR_HOME="$HOME/src/multi-agent-orchestrator"
```

### Codex

```bash
curl -fsSL https://raw.githubusercontent.com/hyw007726/multi-agent-orchestrator-skill/main/install-codex.sh | sh
export ORCHESTRATOR_HOME="${CODEX_HOME:-$HOME/.codex}/skills/multi-agent-orchestrator"
```

安装后重启 Codex。以后重复执行同一条安装命令即可更新 skill。

### Gemini CLI

```bash
git clone https://github.com/hyw007726/multi-agent-orchestrator-skill.git \
  ~/src/multi-agent-orchestrator

gemini extensions install ~/src/multi-agent-orchestrator

export ORCHESTRATOR_HOME="$HOME/src/multi-agent-orchestrator"
```

安装后会得到 `/multi-agent-orchestrator` 命令。

### 手动使用

任何本地代码 Agent 都可以直接读取这个仓库的 workflow：

```text
请读取 /path/to/multi-agent-orchestrator/SKILL.md，并在当前项目中按这个 workflow 执行。
```

## 快速开始

进入你想让 Agent 修改的目标项目，先跑预检：

```bash
cd /path/to/target-project
node "$ORCHESTRATOR_HOME/scripts/preflight.js"
```

然后在你的主 Agent 会话里发起编排。

Claude Code 或其他本地 Agent：

```text
请读取 /path/to/multi-agent-orchestrator/SKILL.md，并把下面这个任务拆给并行 worker：

<描述要实现的大功能或迁移>
```

Codex 示例：

```text
Use $multi-agent-orchestrator to split this implementation into parallel worker agents:

<描述要实现的大功能或迁移>
```

Gemini CLI 示例：

```text
/multi-agent-orchestrator split this implementation into parallel worker agents:

<描述要实现的大功能或迁移>
```

主会话会依次完成：

1. 判断执行方式：`direct`、`single_worker`、`parallel` 或 `phased`；
2. 先处理共享基础文件，避免 worker 之间产生冲突；
3. 起草任务拆分方案；
4. 创建或更新 `coord/context.json`、`coord/DECISIONS.md` 和 `coord/CALLER_CONTEXT.md`；
5. 启动 worker worktree 和后台监督循环；
6. 查看最终 diff，合并通过 review 的改动。

## 推荐启动命令

常见场景可以从目标项目根目录运行：

```bash
node "$ORCHESTRATOR_HOME/scripts/prepare-run.js" \
  --project "Build the requested feature" \
  --task "Build the requested feature" \
  --coord ./coord
```

这个命令会跑预检，必要时初始化 `coord/`，生成一个待填写的任务拆分草案，然后停下来等待主会话 review。填好草案后再执行：

```bash
node "$ORCHESTRATOR_HOME/scripts/prepare-run.js" \
  --approve-draft \
  --draft-plan ./coord/plan-reviews/draft-plan-v1.json \
  --coord ./coord
```

审批步骤会写入最终协调文件，验证 `context.json`，并打印 `launch-all.js` 命令。它不会自动启动 worker。

## 常用命令

以下命令都在目标项目根目录运行。

```bash
# 检查 worker、orchestrator、reviewer CLI 是否可用并已登录。
node "$ORCHESTRATOR_HOME/scripts/preflight.js"

# 创建 worktree 前验证 context.json。
node "$ORCHESTRATOR_HOME/scripts/validate-context.js" --coord ./coord

# 启动 worker worktree 和后台监督循环。
node "$ORCHESTRATOR_HOME/scripts/launch-all.js" --coord ./coord

# 中止后检查过现场，再复用保留下来的 worktree 继续。
node "$ORCHESTRATOR_HOME/scripts/launch-all.js" --coord ./coord --resume

# 打开终端仪表盘。
node "$ORCHESTRATOR_HOME/scripts/dashboard.js" --coord ./coord
```

多数情况下，你不需要手动跑完这些命令；让主会话 Agent 读完 `SKILL.md` 后代你执行即可。

## 工作流程

1. 主会话先当“架构师”：选择执行模式，拆分任务，处理共享基础，分配文件边界，并给每个 worker 指定 `read_first` 文件。
2. `scripts/prepare-run.js` 或 `scripts/bootstrap.js` 初始化 `coord/`，这是主会话、worker 和后台循环共享的状态目录。
3. `scripts/materialize-plan.js` 把已批准的草案转成 `coord/context.json`、`coord/DECISIONS.md` 和 `coord/CALLER_CONTEXT.md`。
4. `scripts/launch-all.js` 验证上下文，为每个 worker 创建 git worktree，渲染 worker prompt，启动 worker，并拉起后台循环。
5. `scripts/orchestrator-loop.js` 处理 worker 提问，读取进度心跳，识别无进展超时，检测卡住的 worker，按限制重启，并执行验证命令。
6. 所有 worker 结束后，后台循环根据 worker 自报告生成 `coord/review-summary.txt`。
7. 主会话查看 diff，运行最终检查，合并可接受的改动，并清理完成的 worktree。

中止流程是可检查的：在仪表盘确认中止会停止运行中的 worker，并标记为 `terminated`，但会保留 worker worktree、`coord/` 日志、事件、请求和决策，方便排查。

## 运行时文件

| 路径 | 用途 |
| --- | --- |
| `coord/context.json` | 运行上下文、执行模式、任务映射、`read_first` 提示和 worker 边界。 |
| `coord/DECISIONS.md` | 需求、架构、API、文件归属和约束的可读记录。 |
| `coord/CALLER_CONTEXT.md` | 主会话背景，会放进仲裁和 worker 重启 prompt。 |
| `coord/agents.json` | 当前 worker 状态。 |
| `coord/decisions.json` / `coord/decisions.jsonl` | 最近决策和追加式审计日志。 |
| `coord/events.jsonl` | 追加式结构化事件日志。 |
| `coord/progress/<agent>.json` | 可选 worker 进度心跳。 |
| `coord/plan-reviews/` | 可选计划草案、reviewer 输出和主会话的处理记录。 |
| `coord/review-summary.txt` | 最终交接摘要。 |
| `.agents/worktrees/<agent>` | 大多数 CLI 使用的 worker git worktree。 |
| `.kilocode/worktrees/<agent>` | Kilo Code 使用的 worker git worktree。 |

## 配置

运行时会从目标项目根目录读取 `orchestrator.config.jsonc`。也支持纯 JSON 的 `orchestrator.config.json`，以及旧版可执行配置 `orchestrator.config.js`。如果多个文件同时存在，优先级是 JSONC、JSON、JS。

个人机器上的覆盖配置可以放在未追踪的 `orchestrator.config.local.jsonc`。

最小配置示例：

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/hyw007726/multi-agent-orchestrator-skill/main/references/orchestrator-config.schema.json",
  "default_cli": "kilo",
  "default_timeout_mins": 10,
  "default_progress_timeout_mins": 15,
  "default_max_restarts": 3
}
```

常用配置项：

- `default_cli`：默认 worker CLI。
- `orchestrator_cli`：负责仲裁 worker 请求的 CLI；不填则跟随 `default_cli`。
- `cli_templates`：启动不同 CLI 的命令模板。
- `cli_health_checks`：预检时使用的轻量检查命令。
- `reviewers`：可选的只读计划 reviewer。
- `default_timeout_mins`：日志停止输出多久后认为 worker 卡住。
- `default_progress_timeout_mins`：日志还在输出但代码没有变化多久后认为无进展。
- `default_max_restarts`：每个 worker 最多重启次数。
- `launch_dashboard`：是否自动打开仪表盘。

仓库根目录的 `orchestrator.config.jsonc` 包含更完整的模板；`references/orchestrator-config.schema.json` 可为编辑器提供补全和校验。

## 模型选择

模型选择跟随实际启动 worker 的 CLI：

- 如果 CLI 支持启动参数指定模型，把模型参数放进 `cli_templates.<cli>`。
- 如果 CLI 不支持启动时指定模型，就在该 CLI 自己的配置里选择模型。
- 如果不同 worker 要用不同模型，建议定义不同 CLI alias，再在 `tasks.<name>.cli` 中引用。

预检输出会显示能识别到的固定模型；如果某个 CLI 使用自身默认配置，预检也会明确说明编排器看不到具体模型。

## 支持的 Worker CLI

内置模板支持：

- `claude`
- `codex`
- `gemini`
- `kilo`
- `opencode`

自定义 CLI 也可以接入，但需要同时配置 `cli_templates.<name>` 和 `cli_health_checks.<name>`。运行时不会猜测自定义 CLI 的命令格式。

## 开发

运行默认测试：

```bash
node scripts/run-tests.js
```

默认测试使用 fake CLI 和临时 Git 仓库，不需要真实 worker 账号或 API key。

实时模型测试需要手动开启，因为会调用已登录的 provider CLI，可能产生模型调用费用。详见 [docs/live-model-tests.md](docs/live-model-tests.md)。

## 更多文档

- [SKILL.md](SKILL.md)：给主会话 Agent 使用的权威 workflow。
- [references/schemas.md](references/schemas.md)：协调文件和 prompt schema 细节。
- [CONTRIBUTING.md](CONTRIBUTING.md)：贡献指南。
- [SECURITY.md](SECURITY.md)：漏洞报告和安全边界。

## 收录信息

如果要把本项目加入 catalog 或 awesome list，建议使用：

```markdown
- **[hyw007726/multi-agent-orchestrator-skill](https://github.com/hyw007726/multi-agent-orchestrator-skill)** - Parallel coding agents in isolated git worktrees.
```

建议 GitHub topics：

```text
agent-skills, claude-code, codex-skills, codex-cli, gemini-cli, ai-agents, coding-agents, multi-agent-systems, agent-orchestration, git-worktrees
```
