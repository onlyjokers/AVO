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

推荐使用正常照片或至少几 KB 的测试图。当前内网图片网关会错误处理极小且高度可压缩的纯色 PNG；AVO 会将其报告为 `image_provider_compact_image_gateway_bug` 并停止重试。

建议需求写法：

```text
必须修改：把背景替换为傍晚的室内场景。
必须保持：人物身份、姿态、服装、构图和画幅不变。
参考图用途：只参考背景光线与色调，不复制参考图中的人物。
验收标准：人物边缘无光晕，背景透视合理，不增加文字或水印。
```

## 3. 验证 AVO 闭环

One-shot 成功后，在同一个任务中选择 `AVO 多轮闭环`：

- 每轮 Main Agent 可以查看原图、参考图、历史候选和上一轮 Qwen 反馈。
- Qwen 返回有效 `PASS` 后立即停止。
- 最多调用 24 次图片生成。
- 连续三次 `FAIL` 后会运行一次只读 Supervisor。
- `FAIL` 候选保留在 trajectory，不进入成功 lineage。

运行页可检查：

- 当前候选与原图对比。
- `generation_count / max_generations` 预算。
- 每个 Attempt 的 Observation、Hypothesis、Intervention。
- Prompt 变化、生成输入和 usage。
- Qwen 的逐条需求判定、分数和证据。
- PASS 候选是否标记为 `Lineage`。

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
4. 等待 `one_shot`、`best_of_n` 和 `avo` 全部结束。
5. 检查 PASS 数、首次 PASS 所需生成数、最高分、延迟、usage 和 1-24 次预算前缀曲线。
6. 查看每个 run 的实际候选图后，记录“AVO 更好 / 暂时无结论 / 没有更好”。

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
