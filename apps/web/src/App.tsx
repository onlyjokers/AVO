import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Activity,
  ArrowLeft,
  Check,
  CircleStop,
  Eye,
  FileText,
  FlaskConical,
  Gauge,
  GitBranch,
  History,
  ImagePlus,
  Images,
  LockKeyhole,
  PanelBottom,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  TrendingUp,
  Upload,
  X,
} from "lucide-react";
import { Link, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import type { CandidateDraft, DraftEvaluation, ExperimentalFeatures, ProviderHealth, RunEvent, RunSnapshot, TaskManifest, Usage, VariationAttemptRecord } from "@avo/contracts";
import { api, artifactUrl, evaluatorAssetUrl, type BenchmarkReport, type EvaluatorInputSummary } from "./api.ts";

export function App() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="AVO 首页"><span className="brand-mark">A</span><span>AVO 图像编辑实验室</span></Link>
        <nav><Link to="/"><Images size={16} />任务</Link><Link to="/benchmarks"><FlaskConical size={16} />实验</Link></nav>
      </header>
      <main><Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/tasks/new" element={<NewTask />} />
        <Route path="/tasks/:id" element={<TaskDetail />} />
        <Route path="/runs/:id" element={<RunDetail />} />
        <Route path="/benchmarks" element={<Benchmarks />} />
        <Route path="/benchmarks/:id" element={<BenchmarkDetail />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes></main>
    </div>
  );
}

function Dashboard() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<TaskManifest[]>([]);
  const [runs, setRuns] = useState<RunSnapshot[]>([]);
  const [health, setHealth] = useState<(ProviderHealth & { mode: string }) | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    const errors: string[] = [];
    await Promise.allSettled([
      api.tasks().then((data) => setTasks(data.items)).catch((cause) => errors.push(`任务读取失败：${(cause as Error).message}`)),
      api.runs().then((data) => setRuns(data.items)).catch((cause) => errors.push(`运行记录读取失败：${(cause as Error).message}`)),
      api.health().then(setHealth).catch((cause) => errors.push(`Provider 检查失败：${(cause as Error).message}`)),
    ]);
    setError(errors.join("；"));
  }, []);
  useEffect(() => { void load(); }, [load]);
  return <div className="page">
    <PageHeading title="任务" description="创建约束编辑任务，运行 AVO 或对照方法。" actions={<><FolderImportButton onCreated={(created) => { if (created.length === 1) navigate(`/tasks/${created[0]!.id}`); else navigate("/benchmarks"); }} /><button className="icon-button" onClick={() => void load()} title="刷新"><RefreshCw /></button><Link className="primary-button" to="/tasks/new"><Plus />新建任务</Link></>} />
    {error && <ErrorBanner message={error} />}
    {health && <HealthStrip health={health} />}
    <section className="section-band">
      <div className="section-title"><h2>任务资料</h2><span>{tasks.length} 个</span></div>
      {tasks.length === 0 ? <Empty title="还没有任务" detail="上传一个原图和甲方编辑要求开始。" /> : <div className="task-grid">{tasks.map((task) => <Link className="task-card" to={`/tasks/${task.id}`} key={task.id}>
        <img src={artifactUrl(task.source_artifact_id)} alt="" />
        <div><h3>{task.title}</h3><p>{task.user_brief}</p><span>{task.references.length} 张公开参考图{task.has_hidden_evaluation ? " · 已配置隐藏评价" : ""}</span></div>
      </Link>)}</div>}
    </section>
    <section className="section-band">
      <div className="section-title"><h2>最近运行</h2><span>{runs.length} 次</span></div>
      <RunTable runs={runs.slice(0, 8)} />
    </section>
  </div>;
}

function NewTask() {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [source, setSource] = useState<File | null>(null);
  const [references, setReferences] = useState<File[]>([]);
  const [hiddenReferences, setHiddenReferences] = useState<File[]>([]);
  const [hiddenTarget, setHiddenTarget] = useState<File | null>(null);
  const [privateRubric, setPrivateRubric] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!source) return setError("请选择一个原图");
    setBusy(true); setError("");
    try {
      const sourceArtifact = await api.upload(source);
      const referenceArtifacts = await Promise.all(references.map(async (file) => ({
        artifact_id: (await api.upload(file)).artifact.id,
        caption: file.name,
      })));
      const hiddenReferenceTokens = await Promise.all(hiddenReferences.map(async (file) => ({
        upload_token: (await api.uploadSealed(file)).upload_token,
        caption: file.name,
      })));
      const hiddenTargetToken = hiddenTarget ? (await api.uploadSealed(hiddenTarget)).upload_token : undefined;
      const created = await api.createTask({
        title,
        user_brief: brief,
        source_artifact_id: sourceArtifact.artifact.id,
        references: referenceArtifacts,
        hidden_references: hiddenReferenceTokens,
        ...(hiddenTargetToken ? { hidden_target_token: hiddenTargetToken } : {}),
        ...(privateRubric.trim() ? { private_rubric: privateRubric.trim() } : {}),
      });
      navigate(`/tasks/${created.task.id}`);
    } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  };
  return <div className="page narrow-page">
    <PageHeading title="新建编辑任务" description="提交原始意图与媒体；评价轴和目标严格度由 Verifier 在每次 Invocation 开始时推导。" actions={<Link className="icon-button" to="/" title="返回"><ArrowLeft /></Link>} />
    <form className="task-form" onSubmit={(event) => void submit(event)}>
      <label>任务名称<input value={title} onChange={(event) => setTitle(event.target.value)} required placeholder="例如：替换花束并保持人物不变" /></label>
      <label>用户 Brief<textarea value={brief} onChange={(event) => setBrief(event.target.value)} required rows={8} placeholder="描述编辑目标与必须保持的内容。Agent 会据此自行编写图片生成 Prompt。" /></label>
      <div className="upload-row">
        <UploadField title="原图" detail="必需，PNG / JPEG / WebP" files={source ? [source] : []} onFiles={(files) => setSource(files[0] ?? null)} single />
        <UploadField title="参考图" detail="可选，可多选" files={references} onFiles={setReferences} />
      </div>
      <details className="evaluator-inputs">
        <summary><ShieldCheck />Evaluator-only Inputs <span>不会进入 Main Agent 上下文</span></summary>
        <div className="upload-row">
          <UploadField title="隐藏参考图" detail="可选，可多选" files={hiddenReferences} onFiles={setHiddenReferences} />
          <UploadField title="隐藏目标图" detail="可选，仅评价方可见" files={hiddenTarget ? [hiddenTarget] : []} onFiles={(files) => setHiddenTarget(files[0] ?? null)} single />
        </div>
        <label>私有评价说明<textarea value={privateRubric} onChange={(event) => setPrivateRubric(event.target.value)} rows={5} placeholder="只提供给隐藏评价模型；Main Agent 只会看到评价后的文字反馈。" /></label>
      </details>
      {error && <ErrorBanner message={error} />}
      <button className="primary-button submit-button" disabled={busy}>{busy ? <RefreshCw className="spin" /> : <Check />}{busy ? "正在创建" : "创建任务"}</button>
    </form>
  </div>;
}

function UploadField(props: { title: string; detail: string; files: File[]; onFiles: (files: File[]) => void; single?: boolean }) {
  return <label className="upload-field">
    <input type="file" accept="image/png,image/jpeg,image/webp" multiple={!props.single} onChange={(event) => props.onFiles(Array.from(event.target.files ?? []))} />
    <Upload /><strong>{props.title}</strong><span>{props.detail}</span>
    {props.files.length > 0 && <small>{props.files.map((file) => file.name).join("、")}</small>}
  </label>;
}

const roleProfilesPreferenceKey = "avo.role-profiles.v1";

const savedRoleProfiles = (models: Awaited<ReturnType<typeof api.modelProfiles>>) => {
  const profiles = { ...models.defaults };
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(roleProfilesPreferenceKey) ?? "null");
    if (!saved || typeof saved !== "object") return profiles;
    for (const role of ["main", "verifier", "supervisor"] as const) {
      const selected = (saved as Record<string, unknown>)[role];
      if ((selected === "qwen" || selected === "78code") && models.options.some((option) => option.id === selected && option.configured)) profiles[role] = selected;
    }
  } catch { /* Browser storage is optional; startup defaults remain usable. */ }
  return profiles;
};

function TaskDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [task, setTask] = useState<TaskManifest | null>(null);
  const [evaluatorInputs, setEvaluatorInputs] = useState<EvaluatorInputSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<Awaited<ReturnType<typeof api.modelProfiles>> | null>(null);
  const [profiles, setProfiles] = useState<Awaited<ReturnType<typeof api.modelProfiles>>["defaults"]>();
  const [features, setFeatures] = useState<ExperimentalFeatures>({ svg_editing: false, photo_adjustments: true, iterative_search: false, copilot_routing: false });
  const [error, setError] = useState("");
  useEffect(() => {
    void api.modelProfiles().then((value) => { setModels(value); setProfiles(savedRoleProfiles(value)); }).catch((cause) => setError(cause.message));
    void Promise.all([api.task(id), api.evaluatorInputs(id)])
      .then(([data, evaluator]) => { setTask(data.task); setEvaluatorInputs(evaluator.evaluator_inputs); })
      .catch((cause) => setError(cause.message));
  }, [id]);
  const start = async (mode: "avo" | "one_shot" | "best_of_n") => {
    if (!profiles) return;
    setBusy(true); setError("");
    try { const result = await api.createRun(id, mode, profiles, mode === "avo" ? features : undefined); navigate(`/runs/${result.run.id}`); }
    catch (cause) { setError((cause as Error).message); setBusy(false); }
  };
  if (!task) return <Loading error={error} />;
  return <div className="page">
    <PageHeading title={task.title} description={task.user_brief} actions={<Link className="icon-button" to="/" title="返回"><ArrowLeft /></Link>} />
    <section className="asset-inspector">
      <div className="source-preview"><img src={artifactUrl(task.source_artifact_id)} alt="原图" /><span>原图</span></div>
      <div className="reference-strip">{task.references.length ? task.references.map((reference) => <figure key={reference.artifact_id}><img src={artifactUrl(reference.artifact_id)} alt="参考图" /><figcaption>{reference.caption ?? "参考图"}</figcaption></figure>) : <Empty title="没有参考图" detail="AVO 将只使用原图和历史候选。" />}</div>
    </section>
    {evaluatorInputs?.has_hidden_evaluation && <details className="evaluator-summary">
      <summary><ShieldCheck />Evaluator-only Inputs</summary>
      <div className="sealed-preview-grid">
        {(evaluatorInputs.references ?? []).map((reference) => <figure key={reference.index}>
          <img src={evaluatorAssetUrl(task.id, `reference-${reference.index}`)} alt="隐藏参考" />
          <figcaption>{reference.caption || reference.original_name}</figcaption>
        </figure>)}
        {evaluatorInputs.has_hidden_target && <figure><img src={evaluatorAssetUrl(task.id, "target")} alt="隐藏目标" /><figcaption>{evaluatorInputs.hidden_target_name}</figcaption></figure>}
      </div>
      {evaluatorInputs.private_rubric && <p>{evaluatorInputs.private_rubric}</p>}
    </details>}
    {error && <ErrorBanner message={error} />}
    <section className="method-picker">
      {models && profiles && <div className="role-model-picker">
        {(["main", "verifier", "supervisor"] as const).map((role) => <label key={role}>{({ main: "Main Agent", verifier: "Verifier", supervisor: "Supervisor" })[role]}
          <select aria-label={`${role} model`} disabled={busy} value={profiles[role]} onChange={(event) => {
            const next = { ...profiles, [role]: event.target.value as "qwen" | "78code" };
            setProfiles(next);
            try { localStorage.setItem(roleProfilesPreferenceKey, JSON.stringify(next)); } catch { /* Keep the current selection when storage is unavailable. */ }
          }}>
            {models.options.map((option) => <option key={option.id} value={option.id} disabled={!option.configured}>{option.id} · {option.model}{option.configured ? "" : " (未配置)"}</option>)}
          </select>
        </label>)}
      </div>}
      <fieldset className="experimental-flags" disabled={busy}>
        <legend>AVO 实验选项</legend>
        {([["photo_adjustments", "像素调色 / 色调"], ["iterative_search", "独立轨迹 / 回退"], ["copilot_routing", "意图解释 / 工具路由"], ["svg_editing", "旧版 SVG 工具"]] as const).map(([key, label]) =>
          <label key={key}><input type="checkbox" checked={Boolean(features[key])} onChange={(event) => setFeatures((current) => ({ ...current, [key]: event.target.checked }))} />{label}</label>)}
      </fieldset>
      <MethodButton icon={<Activity />} title="AVO 自主闭环" detail="24 次预算内执行自主 Variation，并由 Agentic Verifier维护正式单 Lineage。" onClick={() => void start("avo")} disabled={busy || !profiles} primary />
      <MethodButton icon={<Play />} title="One-shot" detail="一次规划、一次生成、一次验证。" onClick={() => void start("one_shot")} disabled={busy || !profiles} />
      <MethodButton icon={<Images />} title="Best-of-24" detail="预先规划 24 个无反馈方案，再统一验证。" onClick={() => void start("best_of_n")} disabled={busy || !profiles} />
    </section>
  </div>;
}

type RunAssetSelection = {
  kind: "source" | "public-reference" | "evaluator-only";
  label: string;
  url: string;
  artifactId?: string;
};

function RunDetail() {
  const { id = "" } = useParams();
  const [run, setRun] = useState<RunSnapshot | null>(null);
  const [task, setTask] = useState<TaskManifest | null>(null);
  const [evaluatorInputs, setEvaluatorInputs] = useState<EvaluatorInputSummary | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [selectedDraftId, setSelectedDraftId] = useState<string>();
  const [selectedAsset, setSelectedAsset] = useState<RunAssetSelection>();
  const [compareAgainst, setCompareAgainst] = useState<"source" | "parent">("parent");
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>("all");
  const [logsOpen, setLogsOpen] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const data = await api.run(id);
      const [taskData, eventData, evaluatorData, evaluatorResults] = await Promise.all([
        api.task(data.run.task_id),
        api.runEvents(id),
        api.evaluatorInputs(data.run.task_id),
        api.evaluatorResults(id),
      ]);
      const qualityByEvaluation = new Map(evaluatorResults.quality_measurements.map((item) => [item.evaluation_id, item]));
      setRun({
        ...data.run,
        evaluation_frame_revisions: evaluatorResults.evaluation_frames,
        comparative_decisions: evaluatorResults.comparative_decisions,
        final_verifier_decisions: evaluatorResults.final_decisions,
        evaluations: data.run.evaluations.map((evaluation) => ({
          ...evaluation,
          ...(qualityByEvaluation.get(evaluation.id) ? {
            source_quality_debt: qualityByEvaluation.get(evaluation.id)!.source_quality_debt,
            step_quality_debt: qualityByEvaluation.get(evaluation.id)!.step_quality_debt,
            validator_elapsed_ms: qualityByEvaluation.get(evaluation.id)!.validator_elapsed_ms,
          } : {}),
        })),
      });
      setTask(taskData.task);
      setEvents(eventData.items);
      setEvaluatorInputs(evaluatorData.evaluator_inputs);
      setSelectedDraftId((current) => current && data.run.drafts.some((draft) => draft.id === current)
        ? current
        : data.run.drafts.find((draft) => draft.id === data.run.submitted_draft_id)?.id ?? data.run.drafts.at(-1)?.id);
      setError("");
      return eventData.items.at(-1)?.sequence ?? 0;
    } catch (cause) {
      setError((cause as Error).message);
      return undefined;
    }
  }, [id]);
  useEffect(() => {
    let cancelled = false;
    let stream: EventSource | undefined;
    let refreshTimer: number | undefined;
    let reconnectTimer: number | undefined;
    let fallback: number | undefined;
    const scheduleLoad = () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void load(), 150);
    };
    const connect = async () => {
      const sequence = await load();
      if (cancelled) return;
      if (sequence === undefined) {
        reconnectTimer = window.setTimeout(() => void connect(), 2_000);
        return;
      }
      stream = new EventSource(`/api/runs/${id}/events?after=${sequence}`);
      stream.onmessage = scheduleLoad;
      fallback = window.setInterval(() => void load(), 5_000);
    };
    void connect();
    return () => {
      cancelled = true;
      stream?.close();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (fallback !== undefined) window.clearInterval(fallback);
    };
  }, [load]);
  if (!run || !task) return <Loading error={error} />;

  const currentDraft = selectedAsset ? undefined : run.drafts.find((draft) => draft.id === selectedDraftId) ?? run.drafts.at(-1);
  const currentEvaluation = currentDraft ? evaluationForDraft(run, currentDraft) : undefined;
  const currentAttempt = currentDraft ? run.attempts.find((attempt) => attempt.draft_id === currentDraft.id) : undefined;
  const currentStep = currentDraft
    ? run.variation_attempts.find((attempt) => attempt.attempt === (currentAttempt?.decision_step ?? currentDraft.origin_step ?? currentDraft.round))
    : run.variation_attempts.at(-1);
  const currentDecision = currentEvaluation?.comparative_decision_id
    ? run.comparative_decisions.find((decision) => decision.id === currentEvaluation.comparative_decision_id)
    : undefined;
  const currentFrame = currentDecision
    ? run.evaluation_frame_revisions.find((frame) => frame.id === currentDecision.evaluation_frame_revision_id)
    : currentStep ? run.evaluation_frame_revisions.find((frame) => frame.id === currentStep.evaluation_frame_revision_id) : undefined;
  const parentDraft = currentDraft ? run.drafts.findLast((draft) => draft.artifact_id === currentDraft.parent_artifact_id) : undefined;
  const parentUrl = currentDraft ? artifactUrl(currentDraft.parent_artifact_id) : artifactUrl(task.source_artifact_id);
  const compareUrl = compareAgainst === "source" ? artifactUrl(task.source_artifact_id) : parentUrl;
  const compareLabel = compareAgainst === "source" ? "Source" : parentDraft ? `Parent · Step ${parentDraft.round}` : "Parent · Source";
  const selectedUrl = selectedAsset?.url ?? (currentDraft ? artifactUrl(currentDraft.artifact_id) : undefined);
  const selectedLabel = selectedAsset?.label ?? (currentDraft ? `Draft ${run.drafts.indexOf(currentDraft) + 1}` : "等待草稿");
  const currentMemoryRevision = currentStep?.memory_revision_id
    ? run.memory_revisions.find((revision) => revision.id === currentStep.memory_revision_id)
    : undefined;
  const currentSupervisorId = run.terminal_supervisor_decision_id ?? currentStep?.supervisor_decision_id;
  const currentSupervisor = currentSupervisorId
    ? run.supervisor_decisions.find((decision) => decision.id === currentSupervisorId)
    : undefined;
  const currentSupervisorFailure = currentStep
    ? run.supervisor_failures.findLast((failure) => failure.variation_step === currentStep.attempt)
    : run.supervisor_failures.at(-1);
  const promptDiff = currentDraft ? summarizePromptDiff(parentDraft?.prompt ?? "", currentDraft.prompt) : undefined;
  const active = ["queued", "running", "stop_requested"].includes(run.status);
  const displayedStep = active
    ? run.active_variation_attempt
    : run.variation_attempts.at(-1)?.attempt ?? run.active_variation_attempt;
  const officialLineage = [...run.lineage_nodes].sort((left, right) => (left.version ?? 0) - (right.version ?? 0));
  const visibleEvents = events.filter((event) => matchesTimelineFilter(event, timelineFilter));

  const selectDraft = (draftId: string) => { setSelectedAsset(undefined); setSelectedDraftId(draftId); };
  const selectArtifact = (asset: RunAssetSelection) => { setSelectedDraftId(undefined); setSelectedAsset(asset); };
  const remove = async () => {
    if (!window.confirm("删除这次运行及其未被引用的候选图？此操作不可撤销。")) return;
    try { await api.deleteRun(run.id); window.location.href = "/"; }
    catch (cause) { setError((cause as Error).message); }
  };

  return <div className="run-page evolution-page">
    <header className="run-statusbar">
      <Link className="icon-button" to={`/tasks/${task.id}`} title="返回任务"><ArrowLeft /></Link>
      <div className="run-identity"><span className={`status-dot ${run.status}`} /><strong>{modeLabel(run.config.mode)}{run.config.experiment ? ` · 实验 ${run.config.experiment.arm}` : ""}</strong><small>{terminalSummary(run)}</small></div>
      <div className="run-vitals">
        <span><b>{displayedStep}</b>Attempt</span>
        <span><b>x{run.active_evolution_version}</b>Incumbent</span>
        <span><b>{run.generation_count}/{run.config.max_generations}</b>{run.config.experimental_features?.svg_editing || run.config.experimental_features?.photo_adjustments ? "候选" : "生成"}</span>
        <span><b>{run.verifier_count}</b>验证</span>
        <span><b>{formatCompactNumber(run.agent_total_tokens)}</b>Agent tokens</span>
        {run.step_deadline && <span><b>{deadlineStateLabel(run)}</b>{formatRemainingDeadline(run.step_deadline.hard_deadline_at)}</span>}
      </div>
      <button className="secondary-button" onClick={() => setLogsOpen((open) => !open)}><PanelBottom />运行日志 <small>{events.length}</small></button>
      <div className="run-actions">{active
        ? <button className="danger-button" onClick={() => void api.stopRun(run.id).then(() => load())}><CircleStop />停止</button>
        : <>{["stopped", "interrupted", "failed", "finalization_pending"].includes(run.status) && <button className="secondary-button" onClick={() => void api.resumeRun(run.id).then(() => load())}><RotateCcw />{run.status === "finalization_pending" ? "重试终局选择" : "恢复"}</button>}<button className="danger-button" onClick={() => void remove()}><X />删除</button></>}
      </div>
    </header>
    {error && <ErrorBanner message={error} />}

    <div className="evolution-layout">
      <main className="evolution-workspace">
        <section className="evolution-map" aria-label="Evolution">
          <header><div><GitBranch /><strong>Official Lineage</strong><span>x0 → x{run.active_evolution_version} · {run.variation_attempts.length} Attempts · {run.drafts.length} Drafts</span></div>{run.memory_pending && <em>Memory pending</em>}</header>
          <div className="evolution-track">
            {officialLineage.map((node) => <div className="evolution-version-group" key={node.id}>
              {run.variation_attempts.filter((attempt) => attempt.target_version === (node.version ?? 0)).map((attempt) => <EvolutionAttempt key={attempt.id} run={run} attempt={attempt} {...(currentDraft ? { selectedDraftId: currentDraft.id } : {})} onSelectDraft={selectDraft} />)}
              <button className={`evolution-source ${run.incumbent_node_id === node.id ? "incumbent" : ""} ${selectedAsset?.artifactId === node.artifact_id || currentDraft?.id === node.draft_id ? "selected" : ""}`} onClick={() => node.draft_id ? selectDraft(node.draft_id) : selectArtifact({ kind: "source", label: "x0 · Source", url: artifactUrl(node.artifact_id), artifactId: node.artifact_id })}>
                <img src={artifactUrl(node.artifact_id)} alt={`x${node.version ?? 0}`} /><span>x{node.version ?? 0}{node.kind === "seed" ? " · Source" : ""}</span><small>{shortArtifact(node.artifact_id)}</small>{run.final_lineage_node_id === node.id && <em>Verifier Final</em>}
              </button>
            </div>)}
            {run.variation_attempts.filter((attempt) => attempt.target_version > run.active_evolution_version).map((attempt) => <EvolutionAttempt key={attempt.id} run={run} attempt={attempt} {...(currentDraft ? { selectedDraftId: currentDraft.id } : {})} onSelectDraft={selectDraft} />)}
          </div>
          {run.search_archive.length > 0 && <details className="search-archive"><summary>Search Archive · {run.search_archive.length}</summary><div>{run.search_archive.map((entry) => {
            const draft = run.drafts.find((item) => item.id === entry.draft_id);
            return draft ? <button key={entry.id} onClick={() => selectDraft(draft.id)}><img src={artifactUrl(draft.artifact_id)} alt="Archived candidate" /><span>{entry.outcome}</span><small>Attempt {entry.attempt}</small></button> : null;
          })}</div></details>}
        </section>

        <section className="compare-workspace">
          <header><div><Eye /><strong>版本对比</strong></div><div className="compare-switch"><button className={compareAgainst === "parent" ? "active" : ""} onClick={() => setCompareAgainst("parent")}>Parent</button><button className={compareAgainst === "source" ? "active" : ""} onClick={() => setCompareAgainst("source")}>Source</button></div></header>
          <div className="comparison evolution-comparison">
            <figure><img src={compareUrl} alt={compareLabel} /><figcaption>{compareLabel}</figcaption></figure>
            <figure>{selectedUrl ? <img src={selectedUrl} alt={selectedLabel} /> : <div className="image-placeholder"><ImagePlus /><span>等待第一张草稿</span></div>}<figcaption>{selectedLabel}{currentEvaluation ? ` · ${finalEvaluationLabel(currentEvaluation)}` : ""}</figcaption></figure>
          </div>
        </section>
      </main>

      <aside className="evolution-inspector">
        <header><span>{selectedAsset ? assetKindLabel(selectedAsset.kind) : currentDraft ? draftStepLabel(currentDraft, currentAttempt?.decision_step) : "Run"}</span><h2>{selectedLabel}</h2>{currentDraft && <StatusPill label={draftEvolutionStatus(run, currentDraft)} />}</header>
        {currentDraft ? <>
          <InspectorSection icon={<Images />} title="Parent 与 References">
            <div className="inspector-assets">
              <button onClick={() => selectArtifact({ kind: "source", label: parentDraft ? `Parent · Step ${parentDraft.round}` : "Parent · Source", url: parentUrl, artifactId: currentDraft.parent_artifact_id })}><img src={parentUrl} alt="Parent" /><span>Parent</span></button>
              {currentDraft.generation_input.reference_artifact_ids.map((artifactId) => <button key={artifactId} onClick={() => selectArtifact({ kind: "public-reference", label: publicReferenceLabel(task, artifactId), url: artifactUrl(artifactId), artifactId })}><img src={artifactUrl(artifactId)} alt="Reference" /><span>{publicReferenceLabel(task, artifactId)}</span></button>)}
              {currentDraft.generation_input.reference_artifact_ids.length === 0 && <p>本次生成未使用辅助参考图。</p>}
            </div>
          </InspectorSection>
          <InspectorSection icon={<FileText />} title="Prompt">
            {currentDraft.svg_edit && <small>SVG 编辑 · 文档 r{currentDraft.svg_edit.revision} · {currentDraft.svg_edit.operations.join(" → ")}</small>}
            {currentDraft.photo_edit && <small className="photo-recipe">像素调色 · {JSON.stringify(currentDraft.photo_edit.recipe)}</small>}
            <p className="inspector-prompt">{currentDraft.prompt}</p>
            {promptDiff && (promptDiff.added || promptDiff.removed) && <details><summary>相对 Parent Prompt 的变化</summary><div className="prompt-diff">{promptDiff.removed && <del>{promptDiff.removed}</del>}{promptDiff.added && <ins>{promptDiff.added}</ins>}</div></details>}
          </InspectorSection>
          <InspectorSection icon={<Activity />} title="Agent Invocation">
            <dl className="inspector-dl"><dt>Observation</dt><dd>{currentAttempt?.agent_summary.observation ?? currentStep?.summary.observation ?? "未提交"}</dd><dt>Hypothesis</dt><dd>{currentAttempt?.agent_summary.hypothesis ?? currentStep?.summary.hypothesis ?? "未记录"}</dd><dt>Intervention</dt><dd>{currentAttempt?.agent_summary.intervention ?? currentStep?.summary.intervention ?? "未记录"}</dd><dt>结束原因</dt><dd>{currentStep?.terminal_reason ?? stepStatusLabel(currentStep?.status)}</dd></dl>
          </InspectorSection>
          <InspectorSection icon={<TrendingUp />} title="Candidate vs Incumbent">
            {currentEvaluation && currentDecision ? <>
              <div className="evaluation-summary"><b>{preferenceLabel(currentDecision.preference)}</b><strong>{targetProgressLabel(currentDecision.target_progress)}</strong><span>{Math.round(currentDecision.confidence * 100)}% · {recommendationLabel(currentDecision.recommendation)}</span></div>
              {currentDecision.candidate_quality && <p>交付质量：{({ acceptable: "可接受", unacceptable: "不可接受", uncertain: "待确认" })[currentDecision.candidate_quality.delivery_status]}</p>}
              <div className="compact-requirements">{currentDecision.axis_judgments.map((judgment) => <div key={judgment.axis_id}><b className={judgment.verdict}>{judgment.verdict.toUpperCase()}</b><span>{currentFrame?.axes.find((axis) => axis.id === judgment.axis_id)?.label ?? judgment.axis_id}</span><strong>{judgment.candidate_score ?? "-"} / {judgment.incumbent_score ?? "-"}</strong><p>{judgment.evidence}</p></div>)}</div>
              {currentDecision.feedback_for_main_agent.length > 0 && <ul>{currentDecision.feedback_for_main_agent.map((feedback) => <li key={feedback}>{feedback}</li>)}</ul>}
              <DebtSignals evaluation={currentEvaluation} />
            </> : <p>该 Draft 尚未评价。</p>}
          </InspectorSection>
          {currentFrame && <InspectorSection icon={<Gauge />} title={`Evaluation Frame r${currentFrame.revision}`}>
            <p>{currentFrame.target_interpretation.role} · {currentFrame.target_interpretation.rationale}</p>
            <p>{currentFrame.change_summary}</p>
            <small>+ {currentFrame.axis_diff.added.join(", ") || "-"} · - {currentFrame.axis_diff.removed.join(", ") || "-"} · changed {currentFrame.axis_diff.changed.join(", ") || "-"}</small>
            <details><summary>{currentFrame.axes.length} 个动态评价轴</summary><div className="compact-requirements">{currentFrame.axes.map((axis) => <div key={axis.id}><b>{axis.importance}</b><span>{axis.label}</span><strong>{axis.mode}</strong><p>{axis.criterion}</p></div>)}</div></details>
          </InspectorSection>}
          <InspectorSection icon={<FileText />} title="Memory Diff">
            {currentMemoryRevision ? <MemoryDiff revision={currentMemoryRevision} /> : <p>{currentStep?.memory_pending ? "本 Attempt 在写入长期 Memory 前结束；Attempt Record 已保留全部事实。" : "本 Attempt 没有长期 Memory 变化。"}</p>}
          </InspectorSection>
        </> : <InspectorSection icon={<Eye />} title="资源"><p>当前查看的是 {selectedLabel}。从 Evolution 选择 Draft 可查看完整 Parent、Prompt、评价和 Memory。</p></InspectorSection>}

        {evaluatorInputs?.has_hidden_evaluation && <InspectorSection icon={<LockKeyhole />} title="Evaluator-only Inputs">
          <div className="inspector-assets sealed-assets">
            {(evaluatorInputs.references ?? []).map((reference) => <button key={reference.index} onClick={() => selectArtifact({ kind: "evaluator-only", label: reference.caption || reference.original_name, url: evaluatorAssetUrl(task.id, `reference-${reference.index}`) })}><img src={evaluatorAssetUrl(task.id, `reference-${reference.index}`)} alt="Evaluator-only reference" /><span>{reference.caption || reference.original_name}</span></button>)}
            {evaluatorInputs.has_hidden_target && <button onClick={() => selectArtifact({ kind: "evaluator-only", label: evaluatorInputs.hidden_target_name || "Hidden target", url: evaluatorAssetUrl(task.id, "target") })}><img src={evaluatorAssetUrl(task.id, "target")} alt="Hidden target" /><span>Hidden target</span></button>}
          </div><small>这些图片仅供本地用户与 Verifier 查看，未发送给 Main Agent。</small>
        </InspectorSection>}
        {(currentSupervisor || currentSupervisorFailure) && <InspectorSection icon={<ShieldCheck />} title="Supervisor">
          {currentSupervisor && <dl className="inspector-dl"><dt>策略</dt><dd>{supervisorStrategyLabel(currentSupervisor.branch_strategy)}</dd><dt>诊断</dt><dd>{currentSupervisor.diagnosis}</dd><dt>Try</dt><dd>{currentSupervisor.try.join(" · ")}</dd></dl>}
          {currentSupervisorFailure && <div className="supervisor-failure"><strong>调用失败 · {currentSupervisorFailure.code}</strong><span>{currentSupervisorFailure.triggers.join(" · ")}</span><small>{currentSupervisorFailure.duration_ms}ms · {currentSupervisorFailure.attempts} 次尝试</small><details><summary>技术详情</summary><pre>{currentSupervisorFailure.detail}</pre></details></div>}
        </InspectorSection>}
      </aside>
    </div>

    <section className={`run-log-drawer ${logsOpen ? "open" : ""}`} aria-hidden={!logsOpen}>
      <header><div><History /><strong>运行日志</strong><span>{visibleEvents.length}/{events.length}</span></div><button className="icon-button" onClick={() => setLogsOpen(false)} title="关闭日志"><X /></button></header>
      <div className="timeline-filters">{(["all", "agent", "tools", "generation", "verification", "errors"] as TimelineFilter[]).map((filter) => <button className={timelineFilter === filter ? "active" : ""} key={filter} onClick={() => setTimelineFilter(filter)}>{timelineFilterLabel(filter)}</button>)}</div>
      <div className="run-log-list">{[...visibleEvents].reverse().map((event) => <TimelineEventCard event={event} key={event.sequence} />)}</div>
    </section>
  </div>;
}

function EvolutionAttempt({ run, attempt, selectedDraftId, onSelectDraft }: { run: RunSnapshot; attempt: VariationAttemptRecord; selectedDraftId?: string; onSelectDraft: (id: string) => void }) {
  const drafts = attempt.draft_ids.map((id) => run.drafts.find((draft) => draft.id === id)).filter((draft): draft is CandidateDraft => Boolean(draft));
  const carriedSelection = attempt.selected_draft_id && !attempt.draft_ids.includes(attempt.selected_draft_id)
    ? run.drafts.find((draft) => draft.id === attempt.selected_draft_id)
    : undefined;
  return <article className={`evolution-step ${attempt.status}`}>
    <header><span>Attempt {attempt.attempt} → x{attempt.target_version}</span><b>{stepStatusLabel(attempt.status)}</b><small>{formatCompactNumber(attempt.usage_delta.total_tokens)} tokens · {attempt.usage_delta.tool_calls} tools</small></header>
    <div className="evolution-drafts">{drafts.length ? drafts.map((draft) => {
      const evaluation = evaluationForDraft(run, draft);
      const decision = evaluation?.comparative_decision_id ? run.comparative_decisions.find((item) => item.id === evaluation.comparative_decision_id) : undefined;
      const commit = run.lineage_nodes.find((node) => node.draft_id === draft.id);
      return <button className={`${selectedDraftId === draft.id ? "selected" : ""} ${evaluation?.correctness_gate.passed ? "pass" : evaluation ? "fail" : "unevaluated"}`} key={draft.id} onClick={() => onSelectDraft(draft.id)}>
        <img src={artifactUrl(draft.artifact_id)} alt={`Attempt ${attempt.attempt} Draft`} /><span>{decision ? preferenceLabel(decision.preference) : evaluation ? finalEvaluationLabel(evaluation) : draftStatusLabel(draft.status)}</span><small>from {shortArtifact(draft.parent_artifact_id)}</small>{commit && <em>x{commit.version}</em>}{decision && !commit && <em>{recommendationLabel(decision.recommendation)}</em>}
      </button>;
    }) : <p>没有生成 Draft</p>}</div>
    {carriedSelection && <button className="evolution-carried-decision" onClick={() => onSelectDraft(carriedSelection.id)}>
      采用历史 Draft · Origin Attempt {carriedSelection.origin_step ?? carriedSelection.round}
    </button>}
    {attempt.terminal_reason && <footer title={attempt.terminal_reason}>{terminalReasonLabel(attempt.terminal_reason)}</footer>}
  </article>;
}

function InspectorSection({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return <section className="inspector-section"><header>{icon}<strong>{title}</strong></header><div>{children}</div></section>;
}

function StatusPill({ label }: { label: string }) { return <span className="status-pill">{label}</span>; }

function DebtSignals({ evaluation }: { evaluation: DraftEvaluation }) {
  const metrics = Object.values(evaluation.source_quality_debt).flat().filter((metric) => metric.severity === "warn" || metric.severity === "severe");
  return <div className="debt-signals">{metrics.length ? metrics.map((metric) => <span className={metric.severity} key={metric.id}>{humanize(metric.id)} · {metric.severity}</span>) : <span className="ok">No quality debt warnings</span>}</div>;
}

function MemoryDiff({ revision }: { revision: RunSnapshot["memory_revisions"][number] }) {
  return <div className="memory-diff">{Object.entries(revision.diff).map(([key, diff]) => <section key={key}><strong>{humanize(key)}</strong>{diff.added.map((value) => <ins key={`a-${value}`}>+ {value}</ins>)}{diff.removed.map((value) => <del key={`r-${value}`}>- {value}</del>)}</section>)}</div>;
}

const humanize = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const evaluationForDraft = (run: RunSnapshot, draft: CandidateDraft) => run.evaluations.findLast((evaluation) =>
  evaluation.draft_id === draft.id || evaluation.artifact_id === draft.artifact_id);
const stepStatusLabel = (status?: VariationAttemptRecord["status"]) => ({
  running: "运行中",
  submitted: "已提交",
  abandoned: "已放弃",
  runtime_cutoff: "运行时截断",
  failed: "失败",
}[status ?? "running"]);
const draftEvolutionStatus = (run: RunSnapshot, draft: CandidateDraft) => {
  const evaluation = evaluationForDraft(run, draft);
  const decision = evaluation?.comparative_decision_id
    ? run.comparative_decisions.find((item) => item.id === evaluation.comparative_decision_id)
    : undefined;
  const commit = run.lineage_nodes.find((node) => node.draft_id === draft.id);
  const attempt = run.attempts.findLast((item) => item.draft_id === draft.id);
  if (commit) return `Official x${commit.version ?? "?"} · ${preferenceLabel(decision?.preference ?? "better")}`;
  if (attempt?.commit_outcome) return `${finalEvaluationLabel(evaluation)} · ${commitOutcomeLabel(attempt.commit_outcome)}`;
  if (decision) return `${preferenceLabel(decision.preference)} · ${recommendationLabel(decision.recommendation)}`;
  if (evaluation) return finalEvaluationLabel(evaluation);
  return draftStatusLabel(draft.status);
};
const finalEvaluationLabel = (evaluation?: DraftEvaluation) => {
  if (!evaluation) return "未评价";
  return evaluation.correctness_gate.passed ? "已比较" : "技术门禁阻止";
};
const commitOutcomeLabel = (outcome: NonNullable<RunSnapshot["attempts"][number]["commit_outcome"]>) => ({
  committed: "Official Commit",
  gate_blocked: "门禁阻止",
  not_improving: "未改善",
  dominated: "历史策略未接受",
  duplicate: "重复版本",
}[outcome]);
const draftStepLabel = (draft: CandidateDraft, decisionStep?: number) => {
  const originStep = draft.origin_step ?? draft.round;
  return decisionStep && decisionStep !== originStep
    ? `Origin Attempt ${originStep} · Decision Attempt ${decisionStep}`
    : `Attempt ${originStep}`;
};
const preferenceLabel = (preference: RunSnapshot["comparative_decisions"][number]["preference"]) => ({
  better: "优于 incumbent",
  equivalent: "与 incumbent 等价",
  worse: "弱于 incumbent",
  uncertain: "比较不确定",
})[preference];
const targetProgressLabel = (progress: RunSnapshot["comparative_decisions"][number]["target_progress"]) => ({
  improved: "目标接近度提升",
  unchanged: "目标接近度不变",
  regressed: "目标接近度下降",
  not_applicable: "无目标距离轴",
})[progress];
const recommendationLabel = (recommendation: RunSnapshot["comparative_decisions"][number]["recommendation"]) => ({
  commit: "Verifier 建议 Commit",
  archive: "仅存入 Archive",
  adjudicate: "需要复核",
})[recommendation];
const publicReferenceLabel = (task: TaskManifest, artifactId: string) => task.references.find((reference) => reference.artifact_id === artifactId)?.caption ?? `Reference ${shortArtifact(artifactId)}`;
const assetKindLabel = (kind: RunAssetSelection["kind"]) => ({ source: "Source", "public-reference": "Public Reference", "evaluator-only": "Evaluator-only" } satisfies Record<RunAssetSelection["kind"], string>)[kind];
const formatCompactNumber = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${Math.round(value / 1_000)}k` : String(value);
const deadlineStateLabel = (run: RunSnapshot) => {
  if (!run.step_deadline) return "";
  const current = Date.now();
  if (current >= Date.parse(run.step_deadline.hard_deadline_at)) return "硬截止";
  if (current >= Date.parse(run.step_deadline.soft_deadline_at)) return "柔性收尾";
  return "自主搜索";
};
const formatRemainingDeadline = (hardDeadlineAt: string) => {
  const remaining = Math.max(0, Date.parse(hardDeadlineAt) - Date.now());
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  return `${minutes}:${String(seconds).padStart(2, "0")} 剩余`;
};
const terminalReasonLabel = (reason: string) => ({
  agent_step_token_budget_exhausted: "Step token limit",
  agent_token_budget_exhausted: "Run token limit",
  agent_tool_call_limit_exhausted: "Tool limit",
  agent_context_window_near_limit: "Context safety cutoff",
  agent_step_timeout: "Step timeout",
  agent_ended_without_decision: "Agent ended without decision",
}[reason] ?? reason.replaceAll("_", " "));

function Benchmarks() {
  const [tasks, setTasks] = useState<TaskManifest[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [items, setItems] = useState<Array<{ id: string; status: string; task_ids: string[]; created_at: string }>>([]);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const load = useCallback(async () => {
    try { setTasks((await api.tasks()).items); setItems((await api.benchmarks()).items); } catch (cause) { setError((cause as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const start = async () => {
    try { const created = await api.createBenchmark(selected); navigate(`/benchmarks/${created.benchmark.id}`); }
    catch (cause) { setError((cause as Error).message); }
  };
  return <div className="page">
    <PageHeading title="对照实验" description="同一任务比较 one-shot、无反馈 best-of-24 与 AVO。" />
    {error && <ErrorBanner message={error} />}
    <section className="benchmark-builder">
      <div className="section-title"><h2>选择 1–10 个任务</h2><span>{selected.length} 已选</span></div>
      <div className="selection-list">{tasks.map((task) => <label key={task.id}><input type="checkbox" checked={selected.includes(task.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, task.id] : selected.filter((id) => id !== task.id))} /><img src={artifactUrl(task.source_artifact_id)} alt="" /><span><strong>{task.title}</strong><small>{task.user_brief}</small></span></label>)}</div>
      <button className="primary-button" disabled={selected.length < 1 || selected.length > 10} onClick={() => void start()}><FlaskConical />启动三方法实验</button>
    </section>
    <section className="section-band"><div className="section-title"><h2>历史实验</h2><span>{items.length}</span></div><div className="benchmark-list">{items.map((item) => <Link to={`/benchmarks/${item.id}`} key={item.id}><FlaskConical /><span><strong>{item.task_ids.length} 个任务</strong><small>{item.status} · {new Date(item.created_at).toLocaleString("zh-CN")}</small></span></Link>)}</div></section>
  </div>;
}

function BenchmarkDetail() {
  const { id = "" } = useParams();
  const [report, setReport] = useState<BenchmarkReport | null>(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => { try { setReport(await api.benchmark(id)); } catch (cause) { setError((cause as Error).message); } }, [id]);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 2_000); return () => clearInterval(timer); }, [load]);
  if (!report) return <Loading error={error} />;
  return <div className="page">
    <PageHeading title="Benchmark 报告" description={`${report.benchmark.task_ids.length} 个任务 · ${report.benchmark.status}`} actions={<Link className="icon-button" to="/benchmarks" title="返回"><ArrowLeft /></Link>} />
    <div className="aggregate-grid">{report.aggregate.map((item) => <section key={item.mode}><span>{modeLabel(item.mode)}</span><strong>{item.passes} / {item.tasks}</strong><small>平均 {item.average_generations.toFixed(1)} 次 · Final 置信度 {item.average_best_score.toFixed(1)} · {(item.average_latency_ms / 1000).toFixed(1)} 秒</small><small>{item.unpriced ? "费用未定价" : `$${item.estimated_cost_usd.toFixed(4)}`}</small></section>)}</div>
    <div className="table-scroll"><table><thead><tr><th>任务</th><th>方法</th><th>状态</th><th>正式版本</th><th>首次 Commit</th><th>生成</th><th>验证</th><th>Final 置信度</th><th>延迟</th><th>费用</th><th /></tr></thead><tbody>{report.rows.map((row) => <tr key={row.run_id}><td>{row.task_id}</td><td>{modeLabel(row.mode)}</td><td>{row.status}</td><td>x{row.final_version}</td><td>{row.first_pass_generation ?? "-"}</td><td>{row.generation_count}</td><td>{row.verifier_count}</td><td>{row.best_score}</td><td>{(row.total_latency_ms / 1000).toFixed(1)}s</td><td>{row.usage.unpriced ? "未定价" : `$${(row.usage.estimated_cost_usd ?? 0).toFixed(4)}`}</td><td><Link to={`/runs/${row.run_id}`}>查看</Link></td></tr>)}</tbody></table></div>
    <section className="prefix-report"><div className="section-title"><h2>1–24 次生成预算前缀</h2><span>绿色表示该预算内已产生正式 Commit</span></div>{report.rows.map((row) => <div className="prefix-row" key={row.run_id}><span>{modeLabel(row.mode)} · {shortRun(row.run_id)}</span><div>{row.prefix_curve.map((point) => <i className={point.passed ? "passed" : point.budget <= row.generation_count ? "attempted" : ""} key={point.budget} title={`预算 ${point.budget} · ${point.passed ? "已有正式版本" : "尚无正式版本"} · Final 置信度 ${point.best_score}`}>{point.budget}</i>)}</div></div>)}</section>
    <section className="conclusion"><h2>人工实验结论</h2><p>此结论不会修改任何 Qwen verdict。</p><textarea rows={4} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="记录你对图片结果与实验过程的判断" /><div>{(["avo_better", "inconclusive", "not_better"] as const).map((verdict) => <button className="secondary-button" key={verdict} onClick={() => void api.concludeBenchmark(id, verdict, notes).then(() => load())}>{verdict === "avo_better" ? "AVO 更好" : verdict === "not_better" ? "没有更好" : "暂时无结论"}</button>)}</div></section>
  </div>;
}

function HealthStrip({ health }: { health: ProviderHealth & { mode: string } }) {
  return <section className="health-strip"><div><Activity /><span><strong>{health.mode === "fake" ? "安全模拟模式" : "真实模型模式"}</strong><small>{health.runnable ? "可以运行" : "配置未完成"}</small></span></div>{(["codex", "generator", "verifier"] as const).map((key) => <span className={health[key].ok ? "healthy" : "unhealthy"} key={key}>{health[key].ok ? <Check /> : <X />}{key}<small>{health[key].message}</small></span>)}</section>;
}

function FolderImportButton({ onCreated }: { onCreated: (tasks: TaskManifest[]) => void }) {
  const [busy, setBusy] = useState(false);
  const importFolder = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    try {
      const relativePath = (file: File) => (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const root = relativePath(files[0]!).split("/")[0] ?? "";
      const normalized = new Map(files.map((file) => [relativePath(file).replace(new RegExp(`^${escapeRegExp(root)}/`), ""), file]));
      const manifestPaths = [...normalized.keys()].filter((path) => path === "task.json" || path.endsWith("/task.json")).sort();
      if (manifestPaths.length < 1 || manifestPaths.length > 10) throw new Error("文件夹必须包含 1–10 个 task.json");
      const createdTasks: TaskManifest[] = [];
      for (const manifestPath of manifestPaths) {
        const manifestFile = normalized.get(manifestPath)!;
        const manifest = JSON.parse(await manifestFile.text()) as {
          title?: unknown;
          request?: unknown;
          source?: unknown;
          references?: Array<{ path?: unknown; caption?: unknown }>;
        };
        if (typeof manifest.title !== "string" || typeof manifest.request !== "string" || typeof manifest.source !== "string") {
          throw new Error(`${manifestPath} 必须包含 title、request 和 source`);
        }
        const taskDirectory = manifestPath === "task.json" ? "" : manifestPath.slice(0, -"task.json".length);
        const sourcePath = resolveManifestPath(taskDirectory, manifest.source);
        const sourceFile = normalized.get(sourcePath);
        if (!sourceFile) throw new Error(`找不到原图：${sourcePath}`);
        const source = await api.upload(sourceFile);
        const references = await Promise.all((manifest.references ?? []).map(async (reference) => {
          if (typeof reference.path !== "string") throw new Error(`${manifestPath} 的参考图 path 无效`);
          const referencePath = resolveManifestPath(taskDirectory, reference.path);
          const file = normalized.get(referencePath);
          if (!file) throw new Error(`找不到参考图：${referencePath}`);
          const uploaded = await api.upload(file);
          return {
            artifact_id: uploaded.artifact.id,
            ...(typeof reference.caption === "string" ? { caption: reference.caption } : {}),
          };
        }));
        const created = await api.createTask({
          title: manifest.title,
          user_brief: manifest.request,
          source_artifact_id: source.artifact.id,
          references,
        });
        createdTasks.push(created.task);
      }
      onCreated(createdTasks);
    } catch (cause) {
      window.alert((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return <label className="secondary-button folder-import" title="导入含 task.json 的任务文件夹">
    <input type="file" multiple {...({ webkitdirectory: "" } as Record<string, string>)} onChange={(event) => void importFolder(Array.from(event.target.files ?? []))} />
    {busy ? <RefreshCw className="spin" /> : <Upload />}{busy ? "导入中" : "导入文件夹"}
  </label>;
}

function RunTable({ runs }: { runs: RunSnapshot[] }) { return runs.length ? <div className="run-table">{runs.map((run) => <Link to={`/runs/${run.id}`} key={run.id}><span className={`status-dot ${run.status}`} /><strong>{modeLabel(run.config.mode)}</strong><span>{run.generation_count} 次生成</span><span>{run.status}</span><small>{new Date(run.updated_at).toLocaleString("zh-CN")}</small></Link>)}</div> : <Empty title="还没有运行" detail="打开一个任务选择实验方法。" />; }
function PageHeading({ title, description, actions }: { title: string; description: string; actions?: React.ReactNode }) { return <div className="page-heading"><div><h1>{title}</h1><p>{description}</p></div><div className="heading-actions">{actions}</div></div>; }
function MethodButton({ icon, title, detail, onClick, disabled, primary }: { icon: React.ReactNode; title: string; detail: string; onClick: () => void; disabled: boolean; primary?: boolean }) { return <button className={primary ? "method primary-method" : "method"} onClick={onClick} disabled={disabled}>{icon}<span><strong>{title}</strong><small>{detail}</small></span><Play /></button>; }
function Metric({ label, value }: { label: string; value: number }) { return <span><strong>{value}</strong><small>{label}</small></span>; }
function Empty({ title, detail }: { title: string; detail: string }) { return <div className="empty"><Images /><strong>{title}</strong><span>{detail}</span></div>; }
function Loading({ error }: { error: string }) { return <div className="loading">{error ? <ErrorBanner message={error} /> : <><RefreshCw className="spin" /><span>正在加载</span></>}</div>; }
function ErrorBanner({ message }: { message: string }) { return <div className="error-banner"><X />{message}</div>; }
type TimelineFilter = "all" | "agent" | "tools" | "generation" | "verification" | "errors";
function TimelineEventCard({ event }: { event: RunEvent }) {
  const summary = fullEventSummary(event);
  const preview = summary.length > 500 ? `${summary.slice(0, 500)}…` : summary;
  return <article className={`attempt ${eventTone(event.type)}`}>
    <header><span>#{event.sequence}</span><strong>{eventLabel(event.type)}</strong><b>{eventScore(event)}</b></header>
    {summary.length > 500
      ? <details><summary>{preview}</summary><pre>{summary}</pre></details>
      : <p>{summary}</p>}
    <small>{new Date(event.at).toLocaleTimeString("zh-CN")}</small>
  </article>;
}
const eventLabel = (type: string) => ({
  "run.created": "创建运行",
  "run.started": "开始运行",
  "run.resumed": "恢复运行",
  "run.finalization_started": "开始终局选择",
  "run.finalization_resumed": "重试终局选择",
  "run.stop_requested": "请求停止",
  "run.recovered_interrupted": "进程恢复",
  "run.completed": "运行完成",
  "generation.completed": "生成完成（旧版）",
  "draft.generated": "草稿生成完成",
  "draft.viewed": "Agent 查看草稿",
  "draft.evaluated": "质量与语义评价",
  "draft.rejected_preverify": "草稿预检拒绝",
  "draft.abandoned": "草稿未提交",
  "variation_step.started": "Variation Step 开始",
  "variation_step.recorded": "Variation Step 已记录",
  "variation_step.abandoned": "Variation Step 已放弃",
  "candidate.submitted": "候选已提交",
  "lineage.committed": "正式版本 Commit",
  "evaluation_frame.created": "评价框架已冻结",
  "variation_attempt.started": "Variation Attempt 开始",
  "variation_attempt.recorded": "Variation Attempt 完成",
  "verifier.final_selected": "Verifier 已选择 Final",
  "verifier.final_selection_failed": "终局 Verifier 待重试",
  "trajectory.recorded": "仅记录到 Trajectory",
  "parent.selected": "选择父代",
  "references.selected": "选择参考图",
  "hypothesis.updated": "更新 Hypothesis",
  "contextCompaction": "上下文压缩",
  "contextCompaction.failed": "上下文压缩失败",
  "candidate.verification_started": "开始验证",
  "candidate.failed": "Qwen FAIL",
  "candidate.passed": "Qwen PASS",
  "candidate.verification_error": "验证异常",
  "supervisor.completed": "Supervisor",
  "supervisor.failed": "Supervisor 调用失败",
  "agent.turn_started": "Agent 开始",
  "agent.step_started": "自主 Variation Step 开始",
  "agent.step_completed": "自主 Variation Step 完成",
  "agent.action_checkpoint": "Agent 动作检查点",
  "agent.phase_started": "阶段开始",
  "agent.phase_completed": "阶段完成",
  "agent.phase_yielded": "阶段让步",
  "agent.message": "Agent 消息",
  "agent.reasoning_summary": "推理摘要",
  "agent.tool_completed": "工具调用",
  "agent.usage_updated": "Agent Usage",
  "agent.policy_violation": "策略阻止",
  "agent.budget_warning": "Agent 预算预警",
  "agent.diagnostic": "Agent 技术诊断",
  "run.submission_recovered": "恢复历史提交",
  "run.verification_resumed": "恢复验证",
  "run.recovery_failed": "历史恢复失败",
  "working_memory.updated": "记忆更新",
}[type] ?? type.replaceAll("_", " "));
const eventTone = (type: string) => type.includes("passed") ? "passed" : type.includes("failed") || type.includes("error") || type.includes("violation") ? "failed" : "submitted";
const eventScore = (event: RunEvent) => {
  const verification = event.data.verification;
  if (!verification || typeof verification !== "object") return "";
  const score = (verification as Record<string, unknown>).overall_score;
  return typeof score === "number" ? score : "";
};
const eventSummary = (event: RunEvent) => {
  if (event.type === "generation.completed" || event.type === "draft.generated") {
    const draft = event.data.draft as { latency_ms?: number } | undefined;
    const latencyMs = draft?.latency_ms ?? event.data.latency_ms;
    const latency = typeof latencyMs === "number" ? ` · ${(latencyMs / 1000).toFixed(1)}s` : "";
    return `候选图已写入内容寻址存储${latency}`;
  }
  if (event.type === "agent.message" && typeof event.data.text === "string") return event.data.text;
  if (event.type === "agent.tool_completed") return `${String(event.data.tool ?? "工具")} · ${String(event.data.status ?? "完成")}`;
  if (event.type === "agent.reasoning_summary") return compactEventValue(event.data.summary);
  if (event.type === "candidate.failed" || event.type === "candidate.passed") {
    const verification = event.data.verification as Record<string, unknown> | undefined;
    return compactEventValue(verification?.feedback) || (event.type === "candidate.passed" ? "所有冻结需求通过" : "候选未通过验证");
  }
  if (event.type === "supervisor.completed") {
    const decision = event.data.decision as Record<string, unknown> | undefined;
    return compactEventValue(decision?.diagnosis) || "Supervisor 已记录决策";
  }
  if (event.type === "supervisor.failed") {
    const failure = event.data.failure as Record<string, unknown> | undefined;
    if (!failure) return "Supervisor 调用失败，主 Run 继续执行";
    const triggers = Array.isArray(failure.triggers) ? failure.triggers.join(" · ") : "触发原因未知";
    return `${String(failure.code ?? "unknown_error")} · ${triggers} · ${String(failure.attempts ?? 1)} 次尝试`;
  }
  if (event.type === "variation_step.recorded") {
    const record = event.data.record as Record<string, unknown> | undefined;
    if (!record) return "Variation Step 已持久化";
    return `${String(record.status ?? "recorded")} · ${String(record.terminal_reason ?? "正常结束")}`;
  }
  if (typeof event.data.reason === "string") return event.data.reason;
  if (typeof event.data.error === "string") return event.data.error;
  return eventLabel(event.type);
};
const fullEventSummary = (event: RunEvent) => {
  if (event.type === "agent.reasoning_summary") return fullEventValue(event.data.summary);
  if (event.type === "agent.message" && typeof event.data.text === "string") return event.data.text;
  if (event.type === "agent.diagnostic") return String(event.data.detail ?? event.data.code ?? "");
  const summary = eventSummary(event);
  return summary || fullEventValue(event.data);
};
const fullEventValue = (value: unknown) => {
  if (Array.isArray(value)) return value.map(String).join("\n");
  if (value && typeof value === "object") return JSON.stringify(value, null, 2);
  return value === undefined || value === null ? "" : String(value);
};
const compactEventValue = (value: unknown) => {
  if (Array.isArray(value)) return value.map(String).join(" · ").slice(0, 500);
  if (value && typeof value === "object") return JSON.stringify(value).slice(0, 500);
  return value === undefined || value === null ? "" : String(value).slice(0, 500);
};
const shortArtifact = (artifactId: string) => artifactId.replace("sha256:", "").slice(0, 12);
const shortRun = (runId: string) => runId.replace("run-", "").slice(0, 8);
const formatUsage = (usage?: Usage) => {
  if (!usage) return "未提供 usage";
  const tokens = usage.total_tokens !== undefined ? `${usage.total_tokens} tokens` : "token 数未知";
  const cost = usage.unpriced || usage.estimated_cost_usd === undefined ? "未定价" : `$${usage.estimated_cost_usd.toFixed(4)}`;
  return `${tokens} · ${cost}`;
};
const summarizePromptDiff = (before: string, after: string) => {
  if (before === after) return { removed: "", added: "" };
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) suffix += 1;
  const clip = (value: string) => value.length > 800 ? `${value.slice(0, 797)}...` : value;
  return {
    removed: clip(before.slice(prefix, before.length - suffix)),
    added: clip(after.slice(prefix, after.length - suffix)),
  };
};
const modeLabel = (mode: string) => mode === "avo" ? "AVO" : mode === "one_shot" ? "One-shot" : "Best-of-N";
const draftStatusLabel = (status: CandidateDraft["status"]) => ({
  generated: "待查看/提交",
  submitted: "已提交",
  verifying: "验证中",
  verified: "已验证",
  rejected_preverify: "质量硬门禁拒绝",
  abandoned: "未提交",
  carried_forward: "待后续决策",
  ambiguous: "生成状态不确定",
} satisfies Record<CandidateDraft["status"], string>)[status];
const terminalSummary = (run: RunSnapshot) => run.status === "finalization_pending"
  ? `终局 Verifier 待重试 · ${run.pending_finalization?.failure_code ?? "unknown_error"}`
  : ({
  codex_event_timeout: "Agent 回合超时",
  agent_token_budget_exhausted: "已用完显式配置的 Agent token 预算",
  variation_step_budget_exhausted: "Variation Step 数量预算已耗尽",
  variation_attempt_budget_exhausted: "Variation Attempt 数量预算已耗尽",
  agent_abandoned_one_shot: "One-shot Agent 未提交候选",
  agent_tool_call_limit_exhausted: "Agent 已达到工具调用上限",
  agent_phase_tool_call_limit_exhausted: "Agent 当前阶段的工具调用过多",
  agent_phase_no_progress: "Agent 当前阶段连续两次没有产生进展",
  agent_phase_tool_violation: "Agent 调用了当前阶段不允许的工具",
  codex_interrupt_timeout: "Agent 提交或达到预算后未能及时中断",
  legacy_submission_recovered: "历史候选已恢复，等待验证",
  recovered_verification_finished_ready_to_resume: "历史候选验证完成，可继续运行",
  verifier_passed: "Qwen 验证通过",
  generation_budget_exhausted: "已使用完整生成预算",
  supervisor_accepted_pareto_best: "旧版 Supervisor 已结束运行",
  supervisor_stopped_search: "Supervisor 已建议停止搜索，Final 由 Verifier 选择",
  }[run.terminal_reason ?? ""] ?? run.terminal_reason ?? "运行中");
const supervisorStrategyLabel = (strategy: RunSnapshot["supervisor_decisions"][number]["branch_strategy"]) => ({
  continue: "继续当前分支",
  restart_source: "从 Source 重启",
  restore_history: "恢复历史节点",
  diversify: "切换搜索方向",
  accept_best_and_finish: "旧版：接受 Pareto 最优并结束",
  stop_search: "停止搜索并交给终局 Verifier",
})[strategy];
const matchesTimelineFilter = (event: RunEvent, filter: TimelineFilter) => {
  if (filter === "all") return true;
  if (filter === "agent") return event.type.startsWith("agent.");
  if (filter === "tools") return event.type === "agent.tool_completed";
  if (filter === "generation") return event.type.startsWith("draft.") || event.type.startsWith("generation.");
  if (filter === "verification") return event.type.startsWith("candidate.") || event.type.startsWith("supervisor.");
  return eventTone(event.type) === "failed" || event.type === "agent.diagnostic" || event.type === "agent.policy_violation";
};
const timelineFilterLabel = (filter: TimelineFilter) => ({
  all: "全部",
  agent: "Agent",
  tools: "工具",
  generation: "生成",
  verification: "验证",
  errors: "错误",
}[filter]);
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const resolveManifestPath = (directory: string, relativePath: string) => {
  const segments = `${directory}${relativePath}`.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === "..") || segments[0] === "") throw new Error(`不安全的任务路径：${relativePath}`);
  return segments.filter((segment) => segment && segment !== ".").join("/");
};
