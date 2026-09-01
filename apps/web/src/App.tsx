import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Activity,
  ArrowLeft,
  Check,
  CircleStop,
  FlaskConical,
  Gauge,
  History,
  ImagePlus,
  Images,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";
import { Link, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import type { ProviderHealth, RunEvent, RunSnapshot, TaskManifest, Usage } from "@avo/contracts";
import { api, artifactUrl, type BenchmarkReport } from "./api.ts";

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
    try {
      const [taskData, runData, healthData] = await Promise.all([api.tasks(), api.runs(), api.health()]);
      setTasks(taskData.items); setRuns(runData.items); setHealth(healthData); setError("");
    } catch (cause) { setError((cause as Error).message); }
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
        <div><h3>{task.title}</h3><p>{task.request}</p><span>{task.references.length} 张参考图</span></div>
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
  const [request, setRequest] = useState("");
  const [source, setSource] = useState<File | null>(null);
  const [references, setReferences] = useState<File[]>([]);
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
      const created = await api.createTask({ title, request, source_artifact_id: sourceArtifact.artifact.id, references: referenceArtifacts });
      navigate(`/tasks/${created.task.id}`);
    } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  };
  return <div className="page narrow-page">
    <PageHeading title="新建编辑任务" description="原图固定为保持性依据；Agent 只可使用此任务内的图片。" actions={<Link className="icon-button" to="/" title="返回"><ArrowLeft /></Link>} />
    <form className="task-form" onSubmit={(event) => void submit(event)}>
      <label>任务名称<input value={title} onChange={(event) => setTitle(event.target.value)} required placeholder="例如：替换花束并保持人物不变" /></label>
      <label>甲方编辑要求<textarea value={request} onChange={(event) => setRequest(event.target.value)} required rows={8} placeholder="完整描述必须修改与必须保持的内容" /></label>
      <div className="upload-row">
        <UploadField title="原图" detail="必需，PNG / JPEG / WebP" files={source ? [source] : []} onFiles={(files) => setSource(files[0] ?? null)} single />
        <UploadField title="参考图" detail="可选，可多选" files={references} onFiles={setReferences} />
      </div>
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

function TaskDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [task, setTask] = useState<TaskManifest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void api.task(id).then((data) => setTask(data.task)).catch((cause) => setError(cause.message)); }, [id]);
  const start = async (mode: "avo" | "one_shot" | "best_of_n") => {
    setBusy(true); setError("");
    try { const result = await api.createRun(id, mode); navigate(`/runs/${result.run.id}`); }
    catch (cause) { setError((cause as Error).message); setBusy(false); }
  };
  if (!task) return <Loading error={error} />;
  return <div className="page">
    <PageHeading title={task.title} description={task.request} actions={<Link className="icon-button" to="/" title="返回"><ArrowLeft /></Link>} />
    <section className="asset-inspector">
      <div className="source-preview"><img src={artifactUrl(task.source_artifact_id)} alt="原图" /><span>原图</span></div>
      <div className="reference-strip">{task.references.length ? task.references.map((reference) => <figure key={reference.artifact_id}><img src={artifactUrl(reference.artifact_id)} alt="参考图" /><figcaption>{reference.caption ?? "参考图"}</figcaption></figure>) : <Empty title="没有参考图" detail="AVO 将只使用原图和历史候选。" />}</div>
    </section>
    {error && <ErrorBanner message={error} />}
    <section className="method-picker">
      <MethodButton icon={<Activity />} title="AVO 多轮闭环" detail="最多 24 次生成，接收 Qwen 反馈，PASS 后立即停止。" onClick={() => void start("avo")} disabled={busy} primary />
      <MethodButton icon={<Play />} title="One-shot" detail="一次规划、一次生成、一次验证。" onClick={() => void start("one_shot")} disabled={busy} />
      <MethodButton icon={<Images />} title="Best-of-24" detail="预先规划 24 个无反馈方案，再统一验证。" onClick={() => void start("best_of_n")} disabled={busy} />
    </section>
  </div>;
}

function RunDetail() {
  const { id = "" } = useParams();
  const [run, setRun] = useState<RunSnapshot | null>(null);
  const [task, setTask] = useState<TaskManifest | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [selectedAttemptId, setSelectedAttemptId] = useState<string>();
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const data = await api.run(id);
      const [taskData, eventData] = await Promise.all([api.task(data.run.task_id), api.runEvents(id)]);
      setRun(data.run);
      setTask(taskData.task);
      setEvents(eventData.items);
      setError("");
    }
    catch (cause) { setError((cause as Error).message); }
  }, [id]);
  useEffect(() => {
    void load();
    const events = new EventSource(`/api/runs/${id}/events`);
    events.onmessage = () => void load();
    const fallback = setInterval(() => void load(), 5_000);
    return () => { events.close(); clearInterval(fallback); };
  }, [load]);
  if (!run || !task) return <Loading error={error} />;
  const current = run.attempts.find((attempt) => attempt.id === selectedAttemptId) ?? run.attempts.at(-1);
  const previous = current ? run.attempts[run.attempts.findIndex((attempt) => attempt.id === current.id) - 1] : undefined;
  const promptDiff = current ? summarizePromptDiff(previous?.prompt ?? task.request, current.prompt) : undefined;
  const active = ["queued", "running", "stop_requested"].includes(run.status);
  const remove = async () => {
    if (!window.confirm("删除这次运行及其未被引用的候选图？此操作不可撤销。")) return;
    try { await api.deleteRun(run.id); window.location.href = "/"; }
    catch (cause) { setError((cause as Error).message); }
  };
  return <div className="run-page">
    <div className="run-header">
      <Link className="icon-button" to={`/tasks/${task.id}`} title="返回任务"><ArrowLeft /></Link>
      <div><span className={`status-dot ${run.status}`} /> <strong>{modeLabel(run.config.mode)}</strong><small>{run.status} · {run.terminal_reason ?? "运行中"}</small></div>
      <div className="run-actions">{active ? <button className="danger-button" onClick={() => void api.stopRun(run.id).then(() => load())}><CircleStop />停止</button> : <>{["stopped", "interrupted", "failed"].includes(run.status) && <button className="secondary-button" onClick={() => void api.resumeRun(run.id).then(() => load())}><RotateCcw />恢复</button>}<button className="danger-button" onClick={() => void remove()}><X />删除</button></>}</div>
    </div>
    <div className="run-layout">
      <section className="visual-stage">
        <div className="comparison">
          <figure><img src={artifactUrl(task.source_artifact_id)} alt="原图" /><figcaption>原图</figcaption></figure>
          <figure>{current ? <img src={artifactUrl(current.generated_artifact_id)} alt="当前候选" /> : <div className="image-placeholder"><ImagePlus /><span>等待第一张候选图</span></div>}<figcaption>当前候选 {current ? `· ${current.status}` : ""}</figcaption></figure>
        </div>
        {run.attempts.length > 0 && <div className="attempt-strip" aria-label="候选轨迹">{run.attempts.map((attempt) => <button className={attempt.id === current?.id ? "selected" : ""} key={attempt.id} onClick={() => setSelectedAttemptId(attempt.id)} title={`查看候选 #${attempt.round}`}>
          <img src={artifactUrl(attempt.generated_artifact_id)} alt="" />
          <span>#{attempt.round} · {attempt.status === "passed" ? "PASS" : attempt.status === "failed" ? "FAIL" : attempt.status}</span>
          {run.lineage_attempt_ids.includes(attempt.id) && <b>Lineage</b>}
        </button>)}</div>}
        <div className="prompt-panel"><span>当前 Prompt</span><p>{(current?.prompt ?? run.prompt) || "尚未生成 Prompt"}</p></div>
        {current && <section className="attempt-detail">
          <header><div><span>Attempt #{current.round}</span><h2>{current.agent_summary.intervention}</h2></div><strong className={current.status}>{current.verification?.overall_score ?? "-"}</strong></header>
          <div className="attempt-detail-grid">
            <div><span>Observation</span><p>{current.agent_summary.observation}</p></div>
            <div><span>Hypothesis</span><p>{current.agent_summary.hypothesis}</p></div>
            <div><span>生成输入</span><p>Base: {shortArtifact(current.generation_input.base_artifact_id)}<br />References: {current.generation_input.reference_artifact_ids.length}</p></div>
            <div><span>Usage</span><p>{formatUsage(current.generation_usage)}<br />Verifier: {current.verification ? `${current.verification.latency_ms}ms` : "未完成"}</p></div>
          </div>
          {promptDiff && (promptDiff.added || promptDiff.removed) && <div className="prompt-diff"><span>Prompt 变化</span>{promptDiff.removed && <del>{promptDiff.removed}</del>}{promptDiff.added && <ins>{promptDiff.added}</ins>}</div>}
          {current.verification && <div className="requirement-results">{current.verification.requirements.map((requirement) => <div key={requirement.requirement_id}><strong>{requirement.verdict}</strong><span>{requirement.requirement_id}</span><b>{requirement.score}</b><p>{requirement.evidence}</p></div>)}</div>}
        </section>}
      </section>
      <aside className="run-sidebar">
        <div className="budget"><Gauge /><div><strong>{run.generation_count} / {run.config.max_generations}</strong><span>生成预算</span></div><progress value={run.generation_count} max={run.config.max_generations} /></div>
        <div className="metrics-row"><Metric label="验证" value={run.verifier_count} /><Metric label="Lineage" value={run.lineage_attempt_ids.length} /><Metric label="连续失败" value={run.consecutive_failures} /></div>
        <div className="timeline-heading"><History /><strong>运行时间线</strong><span>{events.length}</span></div>
        <div className="timeline">{events.length === 0 ? <Empty title="等待 Agent" detail="事件会在这里实时出现。" /> : [...events].reverse().map((event) => <article className={`attempt ${eventTone(event.type)}`} key={event.sequence}>
          <header><span>#{event.sequence}</span><strong>{eventLabel(event.type)}</strong><b>{eventScore(event)}</b></header>
          <p>{eventSummary(event)}</p>
          <small>{new Date(event.at).toLocaleTimeString("zh-CN")}</small>
        </article>)}</div>
      </aside>
    </div>
  </div>;
}

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
      <div className="selection-list">{tasks.map((task) => <label key={task.id}><input type="checkbox" checked={selected.includes(task.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, task.id] : selected.filter((id) => id !== task.id))} /><img src={artifactUrl(task.source_artifact_id)} alt="" /><span><strong>{task.title}</strong><small>{task.request}</small></span></label>)}</div>
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
    <div className="aggregate-grid">{report.aggregate.map((item) => <section key={item.mode}><span>{modeLabel(item.mode)}</span><strong>{item.passes} / {item.tasks}</strong><small>平均 {item.average_generations.toFixed(1)} 次 · {item.average_best_score.toFixed(1)} 分 · {(item.average_latency_ms / 1000).toFixed(1)} 秒</small><small>{item.unpriced ? "费用未定价" : `$${item.estimated_cost_usd.toFixed(4)}`}</small></section>)}</div>
    <div className="table-scroll"><table><thead><tr><th>任务</th><th>方法</th><th>状态</th><th>PASS</th><th>首次 PASS</th><th>生成</th><th>验证</th><th>最高分</th><th>延迟</th><th>费用</th><th /></tr></thead><tbody>{report.rows.map((row) => <tr key={row.run_id}><td>{row.task_id}</td><td>{modeLabel(row.mode)}</td><td>{row.status}</td><td>{row.passed ? "是" : "否"}</td><td>{row.first_pass_generation ?? "-"}</td><td>{row.generation_count}</td><td>{row.verifier_count}</td><td>{row.best_score}</td><td>{(row.total_latency_ms / 1000).toFixed(1)}s</td><td>{row.usage.unpriced ? "未定价" : `$${(row.usage.estimated_cost_usd ?? 0).toFixed(4)}`}</td><td><Link to={`/runs/${row.run_id}`}>查看</Link></td></tr>)}</tbody></table></div>
    <section className="prefix-report"><div className="section-title"><h2>1–24 次生成预算前缀</h2><span>绿色表示该预算内首次 PASS</span></div>{report.rows.map((row) => <div className="prefix-row" key={row.run_id}><span>{modeLabel(row.mode)} · {shortRun(row.run_id)}</span><div>{row.prefix_curve.map((point) => <i className={point.passed ? "passed" : point.budget <= row.generation_count ? "attempted" : ""} key={point.budget} title={`预算 ${point.budget} · ${point.passed ? "PASS" : "未 PASS"} · 最佳分 ${point.best_score}`}>{point.budget}</i>)}</div></div>)}</section>
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
          request: manifest.request,
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
const eventLabel = (type: string) => ({
  "run.created": "创建运行",
  "run.started": "开始运行",
  "run.resumed": "恢复运行",
  "run.stop_requested": "请求停止",
  "run.recovered_interrupted": "进程恢复",
  "generation.completed": "生成完成",
  "candidate.failed": "Qwen FAIL",
  "candidate.passed": "Qwen PASS",
  "candidate.verification_error": "验证异常",
  "supervisor.completed": "Supervisor",
  "agent.turn_started": "Agent 开始",
  "agent.message": "Agent 消息",
  "agent.reasoning_summary": "推理摘要",
  "agent.tool_completed": "工具调用",
  "agent.usage_updated": "Agent Usage",
  "agent.policy_violation": "策略阻止",
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
  if (event.type === "generation.completed") {
    const latency = typeof event.data.latency_ms === "number" ? ` · ${(event.data.latency_ms / 1000).toFixed(1)}s` : "";
    return `候选图已写入内容寻址存储${latency}`;
  }
  if (event.type === "agent.message" && typeof event.data.text === "string") return event.data.text;
  if (event.type === "agent.tool_completed") return `${String(event.data.tool ?? "工具")} · ${String(event.data.status ?? "完成")}`;
  if (event.type === "agent.reasoning_summary") return compactEventValue(event.data.summary);
  if (event.type === "candidate.failed" || event.type === "candidate.passed") {
    const verification = event.data.verification as Record<string, unknown> | undefined;
    return compactEventValue(verification?.feedback) || (event.type === "candidate.passed" ? "所有冻结需求通过" : "候选未通过验证");
  }
  if (event.type === "supervisor.completed") return compactEventValue(event.data.redirect);
  if (typeof event.data.reason === "string") return event.data.reason;
  if (typeof event.data.error === "string") return event.data.error;
  return eventLabel(event.type);
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
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const resolveManifestPath = (directory: string, relativePath: string) => {
  const segments = `${directory}${relativePath}`.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === "..") || segments[0] === "") throw new Error(`不安全的任务路径：${relativePath}`);
  return segments.filter((segment) => segment && segment !== ".").join("/");
};
