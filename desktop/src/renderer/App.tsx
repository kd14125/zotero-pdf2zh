import { useEffect, useState } from "react";
import {
  Activity,
  AlertCircle,
  Archive,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  CircleStop,
  Clock3,
  Copy,
  Download,
  Eye,
  ExternalLink,
  FilePlus2,
  FileText,
  FolderOpen,
  Gauge,
  History,
  KeyRound,
  Link,
  Languages,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ScanSearch,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Unplug,
  X,
} from "lucide-react";
import type {
  AppSettings,
  AppUpdateState,
  LatexState,
  McpIntegrationState,
  MineruConfig,
  ProviderId,
  ProviderProfile,
  RuntimeState,
  TaskRecord,
  TranslationOptions,
} from "../shared/types";

type View = "translate" | "tasks" | "history" | "settings" | "runtime";
type Notice = { type: "success" | "error" | "info"; text: string };

const providerDefinitions: Record<
  ProviderId,
  { label: string; defaultUrl: string; defaultModel: string; keyRequired: boolean }
> = {
  siliconflowfree: {
    label: "SiliconFlow Free",
    defaultUrl: "",
    defaultModel: "",
    keyRequired: false,
  },
  openai: {
    label: "OpenAI",
    defaultUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    keyRequired: true,
  },
  aliyundashscope: {
    label: "阿里云百炼",
    defaultUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus-latest",
    keyRequired: true,
  },
  deepseek: {
    label: "DeepSeek",
    defaultUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    keyRequired: true,
  },
  siliconflow: {
    label: "SiliconFlow",
    defaultUrl: "https://api.siliconflow.cn/v1",
    defaultModel: "Qwen/Qwen2.5-7B-Instruct",
    keyRequired: true,
  },
  zhipu: {
    label: "智谱 AI",
    defaultUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-flash",
    keyRequired: true,
  },
  openaicompatible: {
    label: "OpenAI Compatible",
    defaultUrl: "",
    defaultModel: "",
    keyRequired: true,
  },
  anthropic: {
    label: "Anthropic Messages",
    defaultUrl: "https://api.anthropic.com",
    defaultModel: "",
    keyRequired: true,
  },
};

const defaultOptions: TranslationOptions = {
  sourceLanguage: "en",
  targetLanguage: "zh-CN",
  outputMono: true,
  outputDual: true,
  dualMode: "LR",
  noWatermark: true,
  ocrWorkaround: false,
  autoOcr: true,
  saveGlossary: false,
  disableGlossary: false,
  translateFirst: true,
  qps: 10,
  poolSize: 0,
  mineruFormulaEnhancement: false,
};

export function App() {
  const [view, setView] = useState<View>("translate");
  const [settings, setSettings] = useState<AppSettings>({
    runtimeMirrorUrl: "",
    lastOptions: defaultOptions,
  });
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [runtime, setRuntime] = useState<RuntimeState>({
    status: "missing",
    version: "-",
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
  });
  const [updateState, setUpdateState] = useState<AppUpdateState>({
    status: "idle",
    currentVersion: "0.2.0",
    progress: 0,
    message: "可手动检查新版本",
  });
  const [files, setFiles] = useState<string[]>([]);
  const [options, setOptions] = useState<TranslationOptions>(defaultOptions);
  const [notice, setNotice] = useState<Notice>();
  const [version, setVersion] = useState("0.1.0");
  const [preview, setPreview] = useState<{ url: string; name: string }>();
  const [busy, setBusy] = useState(false);

  const activeTasks = tasks.filter((task) => task.status === "queued" || task.status === "running");
  const historyTasks = tasks.filter(
    (task) => task.status !== "queued" && task.status !== "running",
  );
  const activeProfile =
    profiles.find((profile) => profile.id === settings.activeProfileId) || profiles[0];

  useEffect(() => {
    const load = async () => {
      const [
        loadedSettings,
        loadedProfiles,
        loadedTasks,
        runtimeState,
        loadedUpdateState,
        appVersion,
      ] = await Promise.all([
        window.pdf2zh.app.getSettings(),
        window.pdf2zh.providers.list(),
        window.pdf2zh.tasks.list(),
        window.pdf2zh.runtime.getState(),
        window.pdf2zh.updates.getState(),
        window.pdf2zh.app.getVersion(),
      ]);
      let nextProfiles = loadedProfiles;
      if (!nextProfiles.length) {
        const now = new Date().toISOString();
        const defaultProfile = await window.pdf2zh.providers.save({
          id: crypto.randomUUID(),
          name: "SiliconFlow Free",
          provider: "siliconflowfree",
          baseUrl: "",
          model: "",
          hasApiKey: false,
          extra: {},
          createdAt: now,
          updatedAt: now,
        });
        nextProfiles = [defaultProfile];
        loadedSettings.activeProfileId = defaultProfile.id;
        await window.pdf2zh.app.saveSettings(loadedSettings);
      }
      setSettings(loadedSettings);
      setOptions(loadedSettings.lastOptions || defaultOptions);
      setProfiles(nextProfiles);
      setTasks(loadedTasks);
      setRuntime(runtimeState);
      setUpdateState(loadedUpdateState);
      setVersion(appVersion);
    };
    void load().catch((error) => showError(error, setNotice));
    const offRuntime = window.pdf2zh.runtime.onState(setRuntime);
    const offTasks = window.pdf2zh.tasks.onChanged(setTasks);
    const offUpdates = window.pdf2zh.updates.onState(setUpdateState);
    return () => {
      offRuntime();
      offTasks();
      offUpdates();
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(undefined), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const saveSettings = async (patch: Partial<AppSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await window.pdf2zh.app.saveSettings(next);
  };

  const addFiles = (incoming: string[]) => {
    const valid = incoming.filter((path) => path.toLowerCase().endsWith(".pdf"));
    setFiles((current) => [...new Set([...current, ...valid])]);
  };

  const startTranslation = async () => {
    if (!files.length) return setNotice({ type: "error", text: "请先添加 PDF 文件" });
    if (!activeProfile) return setNotice({ type: "error", text: "请先创建翻译服务配置" });
    if (runtime.status !== "ready") {
      setView("runtime");
      return setNotice({ type: "info", text: "请先完成运行时安装" });
    }
    setBusy(true);
    try {
      await window.pdf2zh.tasks.enqueue({
        inputPaths: files,
        profileId: activeProfile.id,
        options,
      });
      await saveSettings({ lastOptions: options, activeProfileId: activeProfile.id });
      setFiles([]);
      setView("tasks");
      setNotice({ type: "success", text: "任务已加入队列" });
    } catch (error) {
      showError(error, setNotice);
    } finally {
      setBusy(false);
    }
  };

  const openPreview = async (path: string) => {
    try {
      setPreview(await window.pdf2zh.files.preview(path));
    } catch (error) {
      showError(error, setNotice);
    }
  };

  return (
    <div className="app-shell">
      <Sidebar view={view} setView={setView} activeCount={activeTasks.length} version={version} />
      <main className="main-area">
        {notice && <div className={`notice ${notice.type}`}>{notice.text}</div>}
        {view === "translate" && (
          <TranslateView
            files={files}
            addFiles={addFiles}
            removeFile={(path) => setFiles((current) => current.filter((item) => item !== path))}
            moveFile={(index, delta) => setFiles((current) => moveItem(current, index, delta))}
            profiles={profiles}
            activeProfileId={activeProfile?.id}
            selectProfile={(id) => void saveSettings({ activeProfileId: id })}
            options={options}
            setOptions={setOptions}
            runtime={runtime}
            start={startTranslation}
            busy={busy}
          />
        )}
        {view === "tasks" && (
          <TasksView
            tasks={activeTasks}
            cancel={(id) => void window.pdf2zh.tasks.cancel(id)}
            remove={(id) => void window.pdf2zh.tasks.remove(id)}
          />
        )}
        {view === "history" && (
          <HistoryView
            tasks={historyTasks}
            preview={openPreview}
            clear={() => void window.pdf2zh.tasks.clearHistory()}
            retry={async (id) => {
              await window.pdf2zh.tasks.retry(id);
              setView("tasks");
            }}
            optimize={async (id) => {
              try {
                await window.pdf2zh.tasks.optimizeFormulas(id);
                setView("tasks");
                setNotice({ type: "success", text: "MinerU 公式优化任务已加入队列" });
              } catch (error) {
                showError(error, setNotice);
              }
            }}
          />
        )}
        {view === "settings" && (
          <SettingsView
            profiles={profiles}
            settings={settings}
            version={version}
            updateState={updateState}
            activeTaskCount={activeTasks.length}
            refresh={async () => setProfiles(await window.pdf2zh.providers.list())}
            saveSettings={saveSettings}
            notify={setNotice}
          />
        )}
        {view === "runtime" && (
          <RuntimeView
            runtime={runtime}
            settings={settings}
            saveSettings={saveSettings}
            notify={setNotice}
          />
        )}
      </main>
      {preview && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="preview-modal">
            <div className="modal-titlebar">
              <div>
                <FileText size={18} />
                {preview.name}
              </div>
              <button
                className="icon-button"
                title="关闭预览"
                onClick={() => setPreview(undefined)}
              >
                <X size={18} />
              </button>
            </div>
            <iframe title={preview.name} src={preview.url} />
          </div>
        </div>
      )}
    </div>
  );
}

function Sidebar({
  view,
  setView,
  activeCount,
  version,
}: {
  view: View;
  setView: (view: View) => void;
  activeCount: number;
  version: string;
}) {
  const items: Array<{ id: View; label: string; icon: typeof Languages; badge?: number }> = [
    { id: "translate", label: "翻译", icon: Languages },
    { id: "tasks", label: "任务", icon: Activity, badge: activeCount },
    { id: "history", label: "历史", icon: History },
    { id: "settings", label: "设置", icon: Settings },
    { id: "runtime", label: "运行时", icon: Gauge },
  ];
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <Languages size={22} />
        </div>
        <div>
          <strong>PDF2ZH</strong>
          <span>Desktop</span>
        </div>
      </div>
      <nav>
        {items.map(({ id, label, icon: Icon, badge }) => (
          <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}>
            <Icon size={18} />
            <span>{label}</span>
            {Boolean(badge) && <b>{badge}</b>}
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <ShieldCheck size={15} />
        <span>本地安全处理</span>
        <small>v{version}</small>
      </div>
    </aside>
  );
}

function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {actions && <div className="header-actions">{actions}</div>}
    </header>
  );
}

function TranslateView(props: {
  files: string[];
  addFiles: (paths: string[]) => void;
  removeFile: (path: string) => void;
  moveFile: (index: number, delta: number) => void;
  profiles: ProviderProfile[];
  activeProfileId?: string;
  selectProfile: (id: string) => void;
  options: TranslationOptions;
  setOptions: (value: TranslationOptions) => void;
  runtime: RuntimeState;
  start: () => void;
  busy: boolean;
}) {
  const [mineruHelpOpen, setMineruHelpOpen] = useState(false);
  const set = <K extends keyof TranslationOptions>(key: K, value: TranslationOptions[K]) =>
    props.setOptions({ ...props.options, [key]: value });
  const pickFiles = async () => props.addFiles(await window.pdf2zh.dialog.pickPdfs());
  useEffect(() => {
    if (!mineruHelpOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMineruHelpOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mineruHelpOpen]);
  return (
    <div className="page translate-page">
      <PageHeader
        title="PDF 翻译"
        subtitle="添加文档并设置本次翻译参数"
        actions={<RuntimePill runtime={props.runtime} />}
      />
      <div className="translation-grid">
        <section className="workspace-panel">
          <div className="section-title">
            <div>
              <h2>文档队列</h2>
              <span>{props.files.length} 个文件</span>
            </div>
            <button className="secondary-button" onClick={() => void pickFiles()}>
              <FilePlus2 size={16} />
              添加 PDF
            </button>
          </div>
          <div
            className={`drop-zone ${props.files.length ? "compact" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }}
            onDrop={(event) => {
              event.preventDefault();
              props.addFiles(window.pdf2zh.files.pathsFromDrop([...event.dataTransfer.files]));
            }}
            onClick={() => void pickFiles()}
          >
            <div className="drop-icon">
              <FilePlus2 size={28} />
            </div>
            <strong>拖放 PDF 到这里</strong>
            <span>或点击选择多个文件</span>
          </div>
          <div className="file-list">
            {props.files.map((path, index) => (
              <div className="file-row" key={path}>
                <FileText size={18} />
                <div>
                  <strong>{fileName(path)}</strong>
                  <span title={path}>{path}</span>
                </div>
                <div className="row-tools">
                  <button
                    className="icon-button"
                    title="上移"
                    disabled={index === 0}
                    onClick={() => props.moveFile(index, -1)}
                  >
                    <ChevronUp size={16} />
                  </button>
                  <button
                    className="icon-button"
                    title="下移"
                    disabled={index === props.files.length - 1}
                    onClick={() => props.moveFile(index, 1)}
                  >
                    <ChevronDown size={16} />
                  </button>
                  <button
                    className="icon-button danger"
                    title="移除"
                    onClick={() => props.removeFile(path)}
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
        <aside className="options-panel">
          <div className="section-title">
            <div>
              <h2>翻译设置</h2>
              <span>PDF2ZH Next</span>
            </div>
            <SlidersHorizontal size={18} />
          </div>
          <label className="field">
            <span>翻译服务</span>
            <select
              value={props.activeProfileId || ""}
              onChange={(e) => props.selectProfile(e.target.value)}
            >
              {props.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
          <div className="field-grid">
            <label className="field">
              <span>源语言</span>
              <select
                value={props.options.sourceLanguage}
                onChange={(e) => set("sourceLanguage", e.target.value)}
              >
                {languageOptions.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>目标语言</span>
              <select
                value={props.options.targetLanguage}
                onChange={(e) => set("targetLanguage", e.target.value)}
              >
                {languageOptions.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="field">
            <span>输出文件</span>
            <div className="check-row">
              <CheckBox
                label="单语译文"
                checked={props.options.outputMono}
                onChange={(v) => set("outputMono", v)}
              />
              <CheckBox
                label="双语对照"
                checked={props.options.outputDual}
                onChange={(v) => set("outputDual", v)}
              />
            </div>
          </div>
          <div className="field">
            <span>双语版式</span>
            <div className="segmented">
              <button
                className={props.options.dualMode === "LR" ? "active" : ""}
                onClick={() => set("dualMode", "LR")}
              >
                左右对照
              </button>
              <button
                className={props.options.dualMode === "TB" ? "active" : ""}
                onClick={() => set("dualMode", "TB")}
              >
                上下分页
              </button>
            </div>
          </div>
          <div className="field">
            <span>文档处理</span>
            <div className="toggle-list">
              <CheckBox
                label="移除水印"
                checked={props.options.noWatermark}
                onChange={(v) => set("noWatermark", v)}
              />
              <CheckBox
                label="自动 OCR 兼容"
                checked={props.options.autoOcr}
                onChange={(v) => set("autoOcr", v)}
              />
              <CheckBox
                label="OCR 兼容模式"
                checked={props.options.ocrWorkaround}
                onChange={(v) => set("ocrWorkaround", v)}
              />
              <CheckBox
                label="提取并保存术语表"
                checked={props.options.saveGlossary}
                onChange={(v) => set("saveGlossary", v)}
              />
              <div className="check-with-help mineru-option-row">
                <CheckBox
                  label="MinerU 矢量公式增强"
                  checked={props.options.mineruFormulaEnhancement}
                  onChange={(v) => set("mineruFormulaEnhancement", v)}
                />
                <button
                  className="inline-help-button"
                  type="button"
                  title="了解 MinerU 矢量公式增强"
                  aria-label="了解 MinerU 矢量公式增强"
                  onClick={() => setMineruHelpOpen(true)}
                >
                  <CircleHelp size={15} />
                </button>
              </div>
            </div>
          </div>
          <div className="field-grid">
            <label className="field">
              <span>QPS</span>
              <input
                type="number"
                min={1}
                value={props.options.qps}
                onChange={(e) => set("qps", Math.max(1, Number(e.target.value)))}
              />
            </label>
            <label className="field">
              <span>Pool Size</span>
              <input
                type="number"
                min={0}
                value={props.options.poolSize}
                onChange={(e) => set("poolSize", Math.max(0, Number(e.target.value)))}
              />
            </label>
          </div>
          <label className="field">
            <span>结果目录</span>
            <div className="input-action">
              <input
                readOnly
                value={props.options.outputDirectory || "原文件旁的 PDF2ZH-翻译结果"}
              />
              <button
                className="icon-button"
                title="选择目录"
                onClick={async () => {
                  const path = await window.pdf2zh.dialog.pickOutputDirectory();
                  if (path) set("outputDirectory", path);
                }}
              >
                <FolderOpen size={17} />
              </button>
            </div>
          </label>
          <button
            className="primary-button start-button"
            disabled={props.busy || !props.files.length || props.runtime.status !== "ready"}
            onClick={props.start}
          >
            {props.busy ? <LoaderCircle className="spin" size={18} /> : <Play size={18} />}开始翻译{" "}
            <span>{props.files.length || ""}</span>
          </button>
        </aside>
      </div>
      {mineruHelpOpen && (
        <div className="modal-backdrop" onMouseDown={() => setMineruHelpOpen(false)}>
          <section
            className="help-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mineru-help-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-titlebar">
              <div>
                <CircleHelp size={18} />
                <span id="mineru-help-title">MinerU 矢量公式增强</span>
              </div>
              <button
                className="icon-button"
                type="button"
                title="关闭帮助"
                aria-label="关闭帮助"
                onClick={() => setMineruHelpOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="help-modal-body">
              <p className="help-intro">
                <strong>MinerU 提供公式位置和 LaTeX，BabelDOC 负责重新排版。</strong>
                应用会把公式编译为不可拆分的矢量对象，以真实宽度、高度和基线参与中文排版，再清理旧公式框并写回
                PDF。
              </p>
              <section>
                <h3>适合什么时候使用</h3>
                <ul>
                  <li>论文公式较多，普通翻译后发现个别公式被当作正文翻译。</li>
                  <li>行内分式、积分或上下标发生重叠、拆散和重复。</li>
                  <li>从历史记录重新生成公式增强版，不覆盖原翻译结果。</li>
                  <li>普通文档或公式已经正常时可以关闭，以减少等待时间和 MinerU 调用。</li>
                </ul>
              </section>
              <section>
                <h3>如何获取 MinerU Token</h3>
                <ol>
                  <li>打开 MinerU Token 管理页并登录账号。</li>
                  <li>创建或复制可用的 API Token。</li>
                  <li>回到“设置 - MinerU 公式漏检增强”，粘贴 Token 后测试连接并保存。</li>
                </ol>
              </section>
              <div className="help-notice">
                启用后，原始 PDF 会上传到 MinerU，可能消耗 MinerU 配额并增加处理时间。Token 使用
                Windows DPAPI 加密保存在当前电脑。内置 MathJax 无需安装；特殊 LaTeX 宏可切换本机
                LaTeX。
              </div>
            </div>
            <div className="help-modal-actions">
              <a
                className="secondary-button help-link"
                href="https://mineru.net/apiManage/token"
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={16} />
                获取 MinerU Token
              </a>
              <button
                className="primary-button"
                type="button"
                onClick={() => setMineruHelpOpen(false)}
              >
                我知道了
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function TasksView({
  tasks,
  cancel,
  remove,
}: {
  tasks: TaskRecord[];
  cancel: (id: string) => void;
  remove: (id: string) => void;
}) {
  return (
    <div className="page">
      <PageHeader title="任务队列" subtitle="任务按加入顺序依次执行" />
      <div className="task-list">
        {!tasks.length ? (
          <EmptyState icon={Clock3} title="当前没有任务" text="新任务会从翻译页加入这里" />
        ) : (
          tasks.map((task) => (
            <TaskCard key={task.id} task={task} cancel={cancel} remove={remove} />
          ))
        )}
      </div>
    </div>
  );
}

function TaskCard({
  task,
  cancel,
  remove,
}: {
  task: TaskRecord;
  cancel: (id: string) => void;
  remove: (id: string) => void;
}) {
  const running = task.status === "running";
  return (
    <article className="task-card">
      <div className="task-top">
        <div className={`status-icon ${task.status}`}>
          {running ? <LoaderCircle className="spin" size={19} /> : <Clock3 size={19} />}
        </div>
        <div className="task-name">
          <strong>{task.fileName}</strong>
          <span>
            {providerDefinitions[task.provider].label} · {task.options.sourceLanguage} →{" "}
            {task.options.targetLanguage}
            {task.formulaEnhancement ? " · MinerU 公式增强" : ""}
          </span>
        </div>
        <div className="task-actions">
          {running ? (
            <button className="secondary-button danger-text" onClick={() => cancel(task.id)}>
              <CircleStop size={16} />
              取消
            </button>
          ) : (
            <button className="icon-button danger" title="移出队列" onClick={() => remove(task.id)}>
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>
      <div className="progress-line">
        <div style={{ width: `${task.progress.percent}%` }} />
      </div>
      <div className="task-meta">
        <span>{task.progress.stage}</span>
        <span>{task.progress.message}</span>
        <b>{task.progress.percent}%</b>
      </div>
      {task.logs.length > 0 && (
        <details>
          <summary>运行日志</summary>
          <pre>{task.logs.slice(-18).join("\n")}</pre>
        </details>
      )}
    </article>
  );
}

function HistoryView({
  tasks,
  preview,
  retry,
  optimize,
  clear,
}: {
  tasks: TaskRecord[];
  preview: (path: string) => void;
  retry: (id: string) => Promise<void>;
  optimize: (id: string) => Promise<void>;
  clear: () => void;
}) {
  return (
    <div className="page">
      <PageHeader
        title="翻译历史"
        subtitle={`${tasks.length} 条历史记录`}
        actions={
          tasks.length ? (
            <button className="secondary-button danger-text" onClick={clear}>
              <Trash2 size={16} />
              清空记录
            </button>
          ) : undefined
        }
      />
      <div className="history-list">
        {!tasks.length ? (
          <EmptyState icon={Archive} title="还没有翻译记录" text="完成或失败的任务会保存在这里" />
        ) : (
          tasks.map((task) => (
            <article className="history-row" key={task.id}>
              <div className={`history-state ${task.status}`}>
                {task.status === "completed" ? (
                  <Check size={18} />
                ) : task.status === "cancelled" ? (
                  <CircleStop size={18} />
                ) : (
                  <AlertCircle size={18} />
                )}
              </div>
              <div className="history-main">
                <strong>{task.fileName}</strong>
                <span>
                  {providerDefinitions[task.provider].label} ·{" "}
                  {formatTime(task.finishedAt || task.createdAt)} · {duration(task)}
                </span>
                {task.error && <p className="error-text">{task.error}</p>}
                <div className="output-list">
                  {task.outputFiles.map((path) => (
                    <div key={path}>
                      <FileText size={15} />
                      <span>{fileName(path)}</span>
                      <button className="icon-button" title="预览" onClick={() => preview(path)}>
                        <Eye size={15} />
                      </button>
                      <button
                        className="icon-button"
                        title="打开文件"
                        onClick={() => void window.pdf2zh.files.open(path)}
                      >
                        <FolderOpen size={15} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              <div className="history-actions">
                {task.status === "completed" && (
                  <button
                    className="secondary-button"
                    title="从原始 PDF 重新生成增强版，可能再次调用翻译 API"
                    onClick={() => void optimize(task.id)}
                  >
                    <ScanSearch size={15} />
                    优化公式
                  </button>
                )}
                <button className="secondary-button" onClick={() => void retry(task.id)}>
                  <RotateCcw size={15} />
                  重试
                </button>
                <button
                  className="icon-button"
                  title="定位源文件"
                  onClick={() => void window.pdf2zh.files.reveal(task.inputPath)}
                >
                  <FolderOpen size={16} />
                </button>
                <button
                  className="icon-button danger"
                  title="删除记录"
                  onClick={() => void window.pdf2zh.tasks.remove(task.id)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}

function SettingsView({
  profiles,
  settings,
  version,
  updateState,
  activeTaskCount,
  refresh,
  saveSettings,
  notify,
}: {
  profiles: ProviderProfile[];
  settings: AppSettings;
  version: string;
  updateState: AppUpdateState;
  activeTaskCount: number;
  refresh: () => Promise<void>;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
  notify: (notice: Notice) => void;
}) {
  const [selectedId, setSelectedId] = useState(profiles[0]?.id || "");
  const selected = profiles.find((profile) => profile.id === selectedId);
  const [draft, setDraft] = useState<ProviderProfile>(() => selected || newProfile("deepseek"));
  const [apiKey, setApiKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [mcpState, setMcpState] = useState<McpIntegrationState>({
    available: false,
    codexAvailable: false,
    registered: false,
    args: [],
    message: "正在检测 MCP 组件",
  });
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mineruConfig, setMineruConfig] = useState<MineruConfig>({
    baseUrl: "https://mineru.net/api/v4",
    modelVersion: "vlm",
    formulaRenderer: "mathjax",
    hasApiKey: false,
  });
  const [latexState, setLatexState] = useState<LatexState>({
    status: "missing",
    message: "正在检测 LaTeX",
  });
  const [mineruApiKey, setMineruApiKey] = useState("");
  const [mineruBusy, setMineruBusy] = useState(false);
  const [latexBusy, setLatexBusy] = useState(false);
  useEffect(() => {
    if (selected) {
      setDraft(selected);
      setApiKey("");
      setModelOptions([]);
    } else if (!selectedId && profiles[0]) {
      setSelectedId(profiles[0].id);
    }
  }, [profiles, selected, selectedId]);
  useEffect(() => {
    void window.pdf2zh.mcp
      .getState()
      .then(setMcpState)
      .catch((error) => showError(error, notify));
  }, [notify]);
  useEffect(() => {
    void window.pdf2zh.mineru
      .getConfig()
      .then(setMineruConfig)
      .catch((error) => showError(error, notify));
    void window.pdf2zh.mineru
      .getLatexState()
      .then(setLatexState)
      .catch((error) => showError(error, notify));
  }, [notify]);
  const refreshLatex = async () => {
    setLatexBusy(true);
    try {
      setLatexState(await window.pdf2zh.mineru.getLatexState());
    } catch (error) {
      showError(error, notify);
    } finally {
      setLatexBusy(false);
    }
  };
  const installLatex = async () => {
    setLatexBusy(true);
    setLatexState({ status: "installing", message: "正在通过 winget 安装 MiKTeX" });
    try {
      const state = await window.pdf2zh.mineru.installLatex();
      setLatexState(state);
      notify({ type: state.status === "ready" ? "success" : "error", text: state.message });
    } catch (error) {
      showError(error, notify);
    } finally {
      setLatexBusy(false);
    }
  };
  const saveMineru = async () => {
    setMineruBusy(true);
    try {
      const saved = await window.pdf2zh.mineru.saveConfig({
        ...mineruConfig,
        apiKey: mineruApiKey || undefined,
      });
      setMineruConfig(saved);
      setMineruApiKey("");
      notify({ type: "success", text: "MinerU 配置已保存" });
    } catch (error) {
      showError(error, notify);
    } finally {
      setMineruBusy(false);
    }
  };
  const testMineru = async () => {
    setMineruBusy(true);
    try {
      const result = await window.pdf2zh.mineru.test({
        ...mineruConfig,
        apiKey: mineruApiKey || undefined,
      });
      notify({ type: result.ok ? "success" : "error", text: result.message });
    } catch (error) {
      showError(error, notify);
    } finally {
      setMineruBusy(false);
    }
  };
  const mcpAction = async (kind: "refresh" | "register" | "remove" | "copy") => {
    setMcpBusy(true);
    try {
      const state =
        kind === "register"
          ? await window.pdf2zh.mcp.registerCodex()
          : kind === "remove"
            ? await window.pdf2zh.mcp.removeCodex()
            : kind === "copy"
              ? await window.pdf2zh.mcp.copyManualConfig()
              : await window.pdf2zh.mcp.getState();
      setMcpState(state);
      if (kind === "register") notify({ type: "success", text: "PDF2ZH MCP 已接入 Codex" });
      if (kind === "remove") notify({ type: "info", text: "已取消 Codex MCP 接入" });
      if (kind === "copy") notify({ type: "success", text: "手动配置已复制" });
    } catch (error) {
      showError(error, notify);
    } finally {
      setMcpBusy(false);
    }
  };
  const changeProvider = (provider: ProviderId) => {
    const def = providerDefinitions[provider];
    setDraft({
      ...draft,
      provider,
      baseUrl: def.defaultUrl,
      model: def.defaultModel,
      name: def.label,
    });
    setApiKey("");
    setModelOptions([]);
  };
  const save = async () => {
    try {
      const saved = await window.pdf2zh.providers.save({
        ...draft,
        apiKey: apiKey || undefined,
        hasApiKey: draft.hasApiKey || Boolean(apiKey),
        updatedAt: new Date().toISOString(),
      });
      setSelectedId(saved.id);
      setDraft(saved);
      setApiKey("");
      await refresh();
      await saveSettings({ activeProfileId: saved.id });
      notify({ type: "success", text: "配置已保存并切换为当前翻译服务" });
    } catch (error) {
      showError(error, notify);
    }
  };
  const test = async () => {
    setTesting(true);
    try {
      const result = await window.pdf2zh.providers.test({ ...draft, apiKey: apiKey || undefined });
      notify({ type: result.ok ? "success" : "error", text: result.message });
    } catch (error) {
      showError(error, notify);
    } finally {
      setTesting(false);
    }
  };
  const loadModels = async () => {
    setLoadingModels(true);
    try {
      const result = await window.pdf2zh.providers.listModels({
        ...draft,
        apiKey: apiKey || undefined,
      });
      setModelOptions(result.models);
      if (result.ok && !draft.model && result.models[0]) {
        setDraft({ ...draft, model: result.models[0] });
      }
      notify({ type: result.ok ? "success" : "error", text: result.message });
    } catch (error) {
      showError(error, notify);
    } finally {
      setLoadingModels(false);
    }
  };
  const selectProfile = async (profile: ProviderProfile) => {
    setSelectedId(profile.id);
    setDraft(profile);
    setApiKey("");
    setModelOptions([]);
    try {
      await saveSettings({ activeProfileId: profile.id });
    } catch (error) {
      showError(error, notify);
    }
  };
  const removeProfile = async () => {
    try {
      await window.pdf2zh.providers.remove(draft.id);
      const remaining = profiles.filter((profile) => profile.id !== draft.id);
      const next = remaining[0];
      setSelectedId(next?.id || "");
      setDraft(next || newProfile("deepseek", remaining));
      setApiKey("");
      setModelOptions([]);
      await refresh();
      if (settings.activeProfileId === draft.id) {
        await saveSettings({ activeProfileId: next?.id });
      }
      notify({ type: "success", text: "配置已删除" });
    } catch (error) {
      showError(error, notify);
    }
  };
  const updateAction = async () => {
    try {
      if (updateState.status === "available") {
        await window.pdf2zh.updates.download();
      } else if (updateState.status === "downloaded") {
        if (activeTaskCount > 0) {
          notify({ type: "error", text: "请先完成或取消正在运行的翻译任务" });
          return;
        }
        await window.pdf2zh.updates.install();
      } else {
        await window.pdf2zh.updates.check();
      }
    } catch (error) {
      showError(error, notify);
    }
  };
  const updateBusy = ["checking", "downloading", "installing"].includes(updateState.status);
  const updateUnsupported = updateState.status === "unsupported";
  const updateBlocked = updateState.status === "downloaded" && activeTaskCount > 0;
  const updateLabel =
    updateState.status === "available"
      ? `下载 v${updateState.availableVersion}`
      : updateState.status === "downloaded"
        ? updateBlocked
          ? "等待任务结束"
          : "重启安装"
        : updateState.status === "checking"
          ? "正在检查"
          : updateState.status === "downloading"
            ? `下载 ${updateState.progress}%`
            : updateState.status === "installing"
              ? "正在安装"
              : updateState.status === "up-to-date"
                ? "再次检查"
                : updateState.status === "error"
                  ? "重试检查"
                  : updateUnsupported
                    ? "仅安装版支持"
                    : "检查更新";
  const updateMessage = updateBlocked
    ? "更新已下载，请先完成或取消正在运行的翻译任务"
    : updateState.message;
  return (
    <div className="page">
      <PageHeader
        title="设置"
        subtitle="管理翻译服务和应用配置"
        actions={
          <button
            className="primary-button"
            onClick={() => {
              const next = newProfile("deepseek", profiles);
              setSelectedId(next.id);
              setDraft(next);
              setApiKey("");
              setModelOptions([]);
            }}
          >
            <Plus size={16} />
            新增配置
          </button>
        }
      />
      <div className="settings-layout">
        <aside className="profile-list">
          {profiles.map((profile) => (
            <button
              key={profile.id}
              className={selectedId === profile.id ? "active" : ""}
              onClick={() => void selectProfile(profile)}
            >
              <div className="provider-icon">
                <KeyRound size={17} />
              </div>
              <div>
                <strong>{profile.name}</strong>
                <span>{providerDefinitions[profile.provider].label}</span>
              </div>
              {profile.id === settings.activeProfileId && <Check size={16} />}
            </button>
          ))}
        </aside>
        <section className="settings-form">
          <div className="form-heading">
            <div>
              <h2>{draft.name || "新配置"}</h2>
              <span>{providerDefinitions[draft.provider].label}</span>
            </div>
            {profiles.some((item) => item.id === draft.id) && (
              <button
                className="icon-button danger"
                title="删除配置"
                onClick={() => void removeProfile()}
              >
                <Trash2 size={17} />
              </button>
            )}
          </div>
          <div className="form-grid">
            <label className="field">
              <span>配置名称</span>
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="field">
              <span>服务类型</span>
              <select
                value={draft.provider}
                onChange={(e) => changeProvider(e.target.value as ProviderId)}
              >
                {Object.entries(providerDefinitions).map(([id, def]) => (
                  <option key={id} value={id}>
                    {def.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field full">
              <span>API Base URL</span>
              <input
                value={draft.baseUrl}
                disabled={
                  !providerDefinitions[draft.provider].keyRequired &&
                  draft.provider === "siliconflowfree"
                }
                placeholder="https://api.example.com/v1"
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
              />
            </label>
            <label className="field">
              <span>模型</span>
              <div className="model-picker">
                <div className="model-inputs">
                  {modelOptions.length > 0 && (
                    <select
                      aria-label="可用模型列表"
                      value={modelOptions.includes(draft.model) ? draft.model : ""}
                      onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                    >
                      <option value="">选择已获取的模型（{modelOptions.length}）</option>
                      {modelOptions.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                  )}
                  <input
                    aria-label="模型"
                    value={draft.model}
                    disabled={draft.provider === "siliconflowfree"}
                    placeholder="输入模型名称或获取模型列表"
                    onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                  />
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={draft.provider === "siliconflowfree" || loadingModels}
                  onClick={() => void loadModels()}
                >
                  {loadingModels ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <RefreshCw size={15} />
                  )}
                  获取模型
                </button>
              </div>
            </label>
            <label className="field">
              <span>API Key</span>
              <input
                type="password"
                value={apiKey}
                disabled={!providerDefinitions[draft.provider].keyRequired}
                placeholder={draft.hasApiKey ? "已安全保存，留空不修改" : "输入 API Key"}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </label>
          </div>
          <div className="security-note">
            <ShieldCheck size={18} />
            <div>
              <strong>Windows DPAPI 加密</strong>
              <span>
                API Key 已使用 Windows DPAPI 加密保存在本机。任务临时配置会在完成后自动删除。
              </span>
            </div>
          </div>
          <div className="form-actions">
            <span className="test-cost-note">测试连接会发送最小请求，可能产生少量费用</span>
            <button className="secondary-button" disabled={testing} onClick={() => void test()}>
              {testing ? <LoaderCircle className="spin" size={16} /> : <Activity size={16} />}
              测试连接
            </button>
            <button className="primary-button" onClick={() => void save()}>
              <Save size={16} />
              保存配置
            </button>
          </div>
        </section>
      </div>
      <section className="mineru-band">
        <div className="mineru-heading">
          <div className="mcp-symbol">
            <ScanSearch size={21} />
          </div>
          <div>
            <strong>MinerU 矢量公式增强</strong>
            <span>公式以真实尺寸参与 BabelDOC 排版；历史优化会从原始 PDF 重新生成新文件。</span>
          </div>
        </div>
        <div className="mineru-fields">
          <label className="field">
            <span>API 地址</span>
            <input
              value={mineruConfig.baseUrl}
              onChange={(event) =>
                setMineruConfig({ ...mineruConfig, baseUrl: event.target.value })
              }
            />
          </label>
          <label className="field">
            <span>解析模型</span>
            <select
              value={mineruConfig.modelVersion}
              onChange={(event) =>
                setMineruConfig({
                  ...mineruConfig,
                  modelVersion: event.target.value as MineruConfig["modelVersion"],
                })
              }
            >
              <option value="vlm">VLM 高精度</option>
              <option value="pipeline">Pipeline</option>
            </select>
          </label>
          <label className="field">
            <span>公式渲染器</span>
            <select
              value={mineruConfig.formulaRenderer}
              onChange={(event) =>
                setMineruConfig({
                  ...mineruConfig,
                  formulaRenderer: event.target.value as MineruConfig["formulaRenderer"],
                })
              }
            >
              <option value="mathjax">内置 MathJax（推荐）</option>
              <option value="latex">本机 LaTeX</option>
            </select>
          </label>
          <label className="field">
            <span>API Token</span>
            <input
              type="password"
              value={mineruApiKey}
              placeholder={mineruConfig.hasApiKey ? "已加密保存，留空不修改" : "输入 MinerU Token"}
              onChange={(event) => setMineruApiKey(event.target.value)}
            />
          </label>
        </div>
        <div className="mineru-actions">
          <div className={`latex-status ${latexState.status}`}>
            <span>{latexState.message}</span>
            <button
              className="icon-button"
              title="重新检测 LaTeX"
              disabled={latexBusy}
              onClick={() => void refreshLatex()}
            >
              <RefreshCw className={latexBusy ? "spin" : ""} size={15} />
            </button>
            {latexState.status !== "ready" && (
              <button
                className="secondary-button"
                disabled={latexBusy}
                onClick={() => void installLatex()}
              >
                <Download size={15} />
                安装 LaTeX
              </button>
            )}
          </div>
          <button
            className="secondary-button"
            disabled={mineruBusy}
            onClick={() => void testMineru()}
          >
            {mineruBusy ? <LoaderCircle className="spin" size={15} /> : <Activity size={15} />}
            测试连接
          </button>
          <button
            className="primary-button"
            disabled={mineruBusy}
            onClick={() => void saveMineru()}
          >
            <Save size={15} />
            保存 MinerU
          </button>
        </div>
      </section>
      <section className="mcp-band">
        <div className={`mcp-symbol ${mcpState.registered ? "connected" : ""}`}>
          <Bot size={22} />
        </div>
        <div className="mcp-summary">
          <strong>Codex MCP</strong>
          <span>{mcpState.message}</span>
        </div>
        <div className="mcp-actions">
          <button
            className="icon-button"
            title="重新检测"
            disabled={mcpBusy}
            onClick={() => void mcpAction("refresh")}
          >
            <RefreshCw className={mcpBusy ? "spin" : ""} size={16} />
          </button>
          <button
            className="secondary-button"
            disabled={mcpBusy || !mcpState.available}
            onClick={() => void mcpAction("copy")}
          >
            <Copy size={15} />
            复制配置
          </button>
          {mcpState.registered ? (
            <button
              className="secondary-button danger-text"
              disabled={mcpBusy || !mcpState.codexAvailable}
              onClick={() => void mcpAction("remove")}
            >
              <Unplug size={15} />
              取消接入
            </button>
          ) : (
            <button
              className="primary-button"
              disabled={mcpBusy || !mcpState.available || !mcpState.codexAvailable}
              onClick={() => void mcpAction("register")}
            >
              <Link size={15} />
              接入 Codex
            </button>
          )}
        </div>
      </section>
      <section className="about-band">
        <div>
          <strong>PDF2ZH Desktop {version}</strong>
          <span>{updateMessage}</span>
        </div>
        <div className="about-actions">
          <button
            className="secondary-button"
            disabled={updateBusy || updateUnsupported || updateBlocked}
            title={updateMessage}
            onClick={() => void updateAction()}
          >
            {updateState.status === "available" ? (
              <Download size={15} />
            ) : updateBusy ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <RefreshCw size={15} />
            )}
            {updateLabel}
          </button>
          <button className="text-button" onClick={() => void window.pdf2zh.app.openLicense()}>
            开源许可证
          </button>
          <button className="text-button" onClick={() => void window.pdf2zh.app.openSource()}>
            查看源码
          </button>
        </div>
      </section>
    </div>
  );
}

function RuntimeView({
  runtime,
  settings,
  saveSettings,
  notify,
}: {
  runtime: RuntimeState;
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
  notify: (notice: Notice) => void;
}) {
  const [mirror, setMirror] = useState(settings.runtimeMirrorUrl);
  const action = async (kind: "ensure" | "check" | "update" | "rollback") => {
    try {
      if (kind === "ensure") await window.pdf2zh.runtime.ensure();
      if (kind === "check") {
        const state = await window.pdf2zh.runtime.checkUpdate();
        notify({
          type: "info",
          text: state.updateAvailable ? `发现运行时 ${state.version}` : "当前已是已验证版本",
        });
      }
      if (kind === "update") await window.pdf2zh.runtime.update();
      if (kind === "rollback") await window.pdf2zh.runtime.rollback();
    } catch (error) {
      showError(error, notify);
    }
  };
  const active = ["downloading", "verifying", "extracting"].includes(runtime.status);
  return (
    <div className="page">
      <PageHeader
        title="PDF2ZH 运行时"
        subtitle="管理翻译引擎、模型和字体资源"
        actions={<RuntimePill runtime={runtime} />}
      />
      <section className="runtime-hero">
        <div className={`runtime-symbol ${runtime.status}`}>
          {active ? (
            <LoaderCircle className="spin" size={32} />
          ) : runtime.status === "ready" ? (
            <Check size={32} />
          ) : (
            <Download size={32} />
          )}
        </div>
        <div className="runtime-summary">
          <span>PDFMathTranslate-next</span>
          <h2>{runtime.installedVersion ? `v${runtime.installedVersion}` : "尚未安装"}</h2>
          <p>
            {runtime.status === "ready"
              ? "运行时完整，可以开始翻译"
              : runtime.status === "error"
                ? runtime.error
                : runtime.status === "downloading"
                  ? "正在下载运行时资源"
                  : runtime.status === "extracting"
                    ? "正在解压运行时"
                    : runtime.status === "verifying"
                      ? "正在校验下载文件"
                      : "首次使用需要下载约 630 MB 资源"}
          </p>
        </div>
        <div className="runtime-actions">
          {runtime.status !== "ready" && (
            <button
              className="primary-button"
              disabled={active}
              onClick={() => void action("ensure")}
            >
              <Download size={17} />
              安装运行时
            </button>
          )}
          <button
            className="secondary-button"
            disabled={active}
            onClick={() => void action("check")}
          >
            <RefreshCw size={16} />
            检查更新
          </button>
          {runtime.updateAvailable && (
            <button className="primary-button" onClick={() => void action("update")}>
              <Download size={16} />
              更新
            </button>
          )}
        </div>
      </section>
      {active && (
        <section className="download-panel">
          <div>
            <strong>
              {runtime.status === "downloading"
                ? "下载中"
                : runtime.status === "verifying"
                  ? "校验中"
                  : "解压中"}
            </strong>
            <span>
              {formatBytes(runtime.downloadedBytes)} / {formatBytes(runtime.totalBytes)}
            </span>
          </div>
          <div className="progress-line large">
            <div style={{ width: `${runtime.progress}%` }} />
          </div>
          <b>{runtime.progress}%</b>
        </section>
      )}
      <div className="runtime-grid">
        <section className="plain-section">
          <div className="section-title">
            <div>
              <h2>版本策略</h2>
              <span>固定已验证版本</span>
            </div>
            <ShieldCheck size={18} />
          </div>
          <dl>
            <div>
              <dt>目标版本</dt>
              <dd>v{runtime.version}</dd>
            </div>
            <div>
              <dt>已安装版本</dt>
              <dd>{runtime.installedVersion ? `v${runtime.installedVersion}` : "-"}</dd>
            </div>
            <div>
              <dt>上一版本</dt>
              <dd>{runtime.previousVersion ? `v${runtime.previousVersion}` : "-"}</dd>
            </div>
          </dl>
          {runtime.previousVersion && (
            <button className="secondary-button" onClick={() => void action("rollback")}>
              <RotateCcw size={16} />
              回滚上一版本
            </button>
          )}
        </section>
        <section className="plain-section">
          <div className="section-title">
            <div>
              <h2>下载镜像</h2>
              <span>留空使用 GitHub Release</span>
            </div>
            <Gauge size={18} />
          </div>
          <label className="field">
            <span>完整 ZIP 地址</span>
            <input
              value={mirror}
              placeholder="https://.../with-assets-win64.zip"
              onChange={(e) => setMirror(e.target.value)}
            />
          </label>
          <button
            className="secondary-button"
            onClick={async () => {
              await saveSettings({ runtimeMirrorUrl: mirror });
              notify({ type: "success", text: "下载地址已保存" });
            }}
          >
            <Save size={16} />
            保存地址
          </button>
        </section>
      </div>
    </div>
  );
}

function RuntimePill({ runtime }: { runtime: RuntimeState }) {
  const ready = runtime.status === "ready";
  return (
    <div className={`runtime-pill ${ready ? "ready" : runtime.status}`}>
      <span />
      {ready
        ? `运行时 v${runtime.installedVersion}`
        : runtime.status === "downloading"
          ? `下载 ${runtime.progress}%`
          : runtime.status === "error"
            ? "运行时错误"
            : "运行时未就绪"}
    </div>
  );
}
function CheckBox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="check-control">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <Check size={13} />
      </span>
      {label}
    </label>
  );
}
function EmptyState({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof Clock3;
  title: string;
  text: string;
}) {
  return (
    <div className="empty-state">
      <Icon size={30} />
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}

const languageOptions = [
  { value: "en", label: "英语" },
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁体中文" },
  { value: "ja", label: "日语" },
  { value: "ko", label: "韩语" },
  { value: "fr", label: "法语" },
  { value: "de", label: "德语" },
  { value: "es", label: "西班牙语" },
  { value: "ru", label: "俄语" },
];
function newProfile(provider: ProviderId, profiles: ProviderProfile[] = []): ProviderProfile {
  const now = new Date().toISOString();
  const def = providerDefinitions[provider];
  const names = new Set(profiles.map((profile) => profile.name));
  let name = def.label;
  let suffix = 2;
  while (names.has(name)) name = `${def.label} ${suffix++}`;
  return {
    id: crypto.randomUUID(),
    name,
    provider,
    baseUrl: def.defaultUrl,
    model: def.defaultModel,
    hasApiKey: false,
    extra: {},
    createdAt: now,
    updatedAt: now,
  };
}
function fileName(path: string) {
  return path.split(/[\\/]/).at(-1) || path;
}
function moveItem<T>(items: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= items.length) return items;
  const copy = [...items];
  [copy[index], copy[target]] = [copy[target], copy[index]];
  return copy;
}
function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}
function duration(task: TaskRecord) {
  if (!task.startedAt || !task.finishedAt) return "-";
  const seconds = Math.max(
    0,
    Math.round((new Date(task.finishedAt).getTime() - new Date(task.startedAt).getTime()) / 1000),
  );
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
function formatBytes(value: number) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** unit).toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}
function showError(error: unknown, notify: (notice: Notice) => void) {
  notify({ type: "error", text: error instanceof Error ? error.message : String(error) });
}
