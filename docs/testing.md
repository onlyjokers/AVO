# AVO MVP 测试指南

## 1. 启动开发环境

项目根目录的 `.env` 已配置真实 Provider，并被 Git 忽略。启动命令：

```bash
cd /Users/ziqi/Desktop/StrangeDreamWorkspace/AVO
pnpm install
pnpm dev
```

服务地址：

- Web UI: <http://127.0.0.1:4311>
- API health: <http://127.0.0.1:4310/health>

首次打开 Web UI 时会执行真实 Provider readiness，包括一个 Main Agent 回合、一次图片编辑以及 Qwen checklist/verification 调用。结果会在当前 API 进程内缓存；重启 API 后首次打开会重新执行并可能产生费用。

## 2. 先运行低成本真实 smoke

1. 打开 Web UI，等待顶部显示“真实模型模式”和“可以运行”。
2. 确认 `codex`、`generator`、`verifier` 三项均为绿色。
3. 点击“新建任务”。
4. 填写任务名称和完整编辑要求。
5. 上传一个 PNG、JPEG 或 WebP 原图；可选上传多张参考图。
6. 创建任务后先选择 `One-shot`。
7. 在运行页等待状态结束，检查原图/候选对比、Prompt、生成输入、Qwen 分项和时间线。

推荐使用正常照片或至少几 KB 的测试图。一次 Agent `avo_generate_image` 最多在 Provider adapter 内执行 5 次提交，每次等待 120 秒并使用不同的 `client_task_id`。前四次超时不会返回 Main Agent，也不会生成 Draft 或 Memory 经验；任一次成功即返回，五次失败后才返回聚合错误。每次 Provider 尝试仍写入 Controller 技术审计，以便核对请求与费用。

建议需求写法：

```text
必须修改：把背景替换为傍晚的室内场景。
必须保持：人物身份、姿态、服装、构图和画幅不变。
参考图用途：只参考背景光线与色调，不复制参考图中的人物。
验收标准：人物边缘无光晕，背景透视合理，不增加文字或水印。
```

## 3. 验证 AVO 闭环

One-shot 成功后，在同一个任务中选择 `AVO 多轮闭环`：

- 每个 Agent Invocation 启动一个新的 Codex thread，内部是一条不划分固定阶段的自主 Variation Attempt。
- 同一 Invocation 只创建一个持续的 `turn/start`；Agent 在其中顺序调用工具，Controller 不会在每个动作后 interrupt。
- 15 分钟进入柔性收尾，或剩余时间不足一次 P95 生成、评价和 60 秒决策时停止新生成；20 分钟硬截止只关闭当前 Attempt 并继续 Run。
- 内部 Codex Provider 代理固定使用低推理、`parallel_tool_calls=false`、8192 输出上限和 DashScope 会话缓存，并逐块转发 Responses SSE。
- Agent 查看的是最长边 1024 的分析预览；生成、Verifier 与 UI 继续使用 Provider 原始图片。
- Main Agent 可以自主选择父代、编写 Prompt，并反复执行生成、查看、评价和修订。
- 每个 Invocation 无条件形成一条 `VariationAttemptRecord`；最终可提交一个 Verifier 推荐 Commit 的候选，或用 `avo_abandon_attempt` 记录测得的失败方向。
- submit/abandon 同时携带下一版 Memory，避免在关闭前单独写 Memory 失败。
- Agentic Verifier 在每次 Invocation 开始时从人类 Brief、公开/隐藏媒体和私有说明推导固定评价框架；同一 Invocation 内所有候选使用同一 revision。
- 每次评价都是 Candidate 与正式 incumbent 的 A/B 比较。只有技术门禁通过、Verifier 判定严格 `better` 且推荐 Commit 的候选进入单 Lineage `x(t+1)`。
- `equivalent`、`worse`、`uncertain` 和未提交候选只进入 Search Archive；绝对分数和 Pareto 都不能决定 Commit 或 Final。
- 最多调用 24 次图片生成、运行 90 分钟或执行 40 个 Agent Invocation。
- 每次评价后由确定性 Monitor 检查高价值异常，命中时才调用 Supervisor；连续 3 个 Attempt 没有新正式版本时在边界介入。Supervisor 只能管理搜索策略或返回 `stop_search`，Final 由终局 Verifier 选择。

运行页默认以 Evolution 为主视图，可检查：

- 正式版本序列 `x0 → x1 → ...`、版本间的 Attempt、Draft、比较结论和真实 Parent 连线。
- 任意历史 Draft 与 Parent/Source 的大图对比，以及公开 Reference。
- `generation_count / max_generations` 预算。
- 每个 Attempt 的 Observation、Hypothesis、Intervention、结束原因和 Memory Diff。
- Prompt 变化、生成输入和 usage。
- Qwen 的 Candidate-vs-incumbent 结论、目标进展、置信度、动态评价轴和证据。
- 候选是否被 Verifier 接受为正式 `x(t+1)`，或仅进入 Search Archive。
- Supervisor 决策或结构化调用失败；原始 Agent 日志位于底部抽屉。

运行中可以点击“停止”。停止、失败或进程中断的 run 可在页面中点击“恢复”；已成功完成的 Provider 调用不会因恢复而自动重放。

## 4. 批量导入任务

单个任务文件夹：

```text
task-01/
  task.json
  source.png
  references/
    lighting.jpg
```

`task.json`：

```json
{
  "title": "替换背景并保持人物",
  "request": "替换为傍晚室内背景，保持人物、服装和构图不变。",
  "source": "source.png",
  "references": [
    {
      "path": "references/lighting.jpg",
      "caption": "只参考光线和色调"
    }
  ]
}
```

点击任务页的“导入文件夹”，可以选择一个任务文件夹，或选择包含 1-10 个上述子文件夹的 benchmark 根目录。Manifest 只允许相对路径，绝对路径和 `..` 会被拒绝。

## 5. 运行三方法 Benchmark

完成至少一次 One-shot 和一次 AVO smoke 后：

1. 准备 5-10 个代表真实工作的任务。
2. 打开“实验”。
3. 选择任务并点击“启动三方法实验”。
4. 不同任务默认以 3 路并发执行；同一任务的 `one_shot`、`best_of_n` 和 `avo` 保持串行以保证方法比较公平。
5. 等待 `one_shot`、`best_of_n` 和 `avo` 全部结束。
6. 检查 PASS 数、首次 PASS 所需生成数、最高分、延迟、usage 和 1-24 次预算前缀曲线。
7. 查看每个 run 的实际候选图后，记录“AVO 更好 / 暂时无结论 / 没有更好”。

最坏情况下，每个任务会执行：

- One-shot: 1 次图片生成。
- Best-of-24: 24 次图片生成。
- AVO: 最多 24 次图片生成。
- 合计上限: 49 次图片生成/任务，另有相应的 Main Agent 和 Verifier 调用。

因此不要直接用 10 个任务开始第一次真实实验。先用 1 个任务确认质量、延迟和费用，再扩大到 5-10 个任务。当前费用显示为 `unpriced`，报告会保存 token usage 和调用次数，但不会自动计算真实金额。

## 6. 无外部费用的工程回归

以下命令不调用真实 Provider：

```bash
pnpm check
pnpm test:e2e
```

其中 `pnpm check` 包含 typecheck、单元/API 测试和 build；Playwright 会强制使用 fake Provider。

只验证真实 Qwen Main Agent 与 Codex app-server/MCP，图片生成和 Verifier 保持 fake：

```bash
set -a
source .env
set +a
pnpm --filter @avo/api test:codex
```

该 smoke 会调用 Qwen Main Agent，因此不是零费用测试。

## 7. 数据与清理

- `data/runs/<run-id>/events.jsonl` 是运行事实源。
- `data/runs/<run-id>/snapshot.json` 是可重建缓存。
- 图片保存在 `data/blobs/sha256/`，按 SHA-256 去重。
- `.env`、`data/`、`tmp/`、构建产物和图片均不会进入 Git。
- UI 只支持显式删除整个 run；仍被其他 task/run 引用的 blob 不会被删除。

停止开发服务器时，在运行 `pnpm dev` 的终端按 `Ctrl+C`。再次运行 `pnpm dev` 会保留任务、run、事件和图片。
