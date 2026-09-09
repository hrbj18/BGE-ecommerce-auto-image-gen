import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Copy,
  Download,
  Eye,
  FileText,
  FolderOpen,
  ImagePlus,
  Images,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  UploadCloud,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { cachePromptSnapshot, promptSnapshotFromTask, readCachedPromptSnapshot } from "./prompt-cache.js";
import { captchaImageSource } from "./portal-captcha.js";
import { planReferenceFileAddition, referenceUploadFeedback } from "./reference-upload.js";
import { loadReferenceDraft, referenceDraftScope, restoreReferenceDraft, saveReferenceDraft } from "./reference-draft.js";
import { taskImageCounts } from "./task-progress.js";

const briefPlaceholder = "请输入卖点";

const statusCopy = {
  idle: "等待素材",
  ready: "准备生成",
  receiving: "接收素材",
  submitting: "正在提交",
  queued: "已提交",
  running: "生成中",
  canceling: "取消中",
  cancelled: "已取消",
  interrupted: "已中断",
  partial: "部分完成",
  done: "生成完成",
  failed: "生成失败",
};

const referenceImageLimit = 5;
const referenceImageRoles = ["主参考图", "细节图", "结构图", "场景参考"];
const defaultGenerationProfileId = "standard-5-8";
const defaultImageAspectRatioProfileId = "ecommerce-standard";
const defaultImageResolutionId = "2k";
const fallbackGenerationProfiles = [
  { id: "standard-5-8", label: "标准套图", summary: "5 主图 + 8 详情页", suiteRatio: "主图 1:1 / 详情页 9:16", mainImageCount: 5, detailImageCount: 8 },
  { id: "compact-1-2", label: "极速验证套图", summary: "1 主图 + 2 详情页", suiteRatio: "主图 1:1 / 详情页 9:16", mainImageCount: 1, detailImageCount: 2 },
  { id: "compact-2-3", label: "轻量套图", summary: "2 主图 + 3 详情页", suiteRatio: "主图 1:1 / 详情页 9:16", mainImageCount: 2, detailImageCount: 3 },
  { id: "compact-3-4", label: "核心卖点套图", summary: "3 主图 + 4 详情页", suiteRatio: "主图 1:1 / 详情页 9:16", mainImageCount: 3, detailImageCount: 4 },
];
const fallbackImageResolutionProfiles = [
  { id: "720p", label: "720P 预览", summary: "720P 预览", description: "1K 生成后缩小，生图耗时接近 1K", providerResolution: "1k" },
  { id: "1k", label: "1K 快速", summary: "1K 快速", description: "供应商原生 1K，适合快速验证", providerResolution: "1k" },
  { id: "2k", label: "2K 标准", summary: "2K 标准", description: "当前标准交付清晰度", providerResolution: "2k" },
];
const fallbackImageAspectRatioProfiles = [
  { id: "ecommerce-standard", label: "电商标准", summary: "主图 1:1 / 详情页 9:16", description: "方形主图，竖版详情页" },
  { id: "portrait-main", label: "竖版主图", summary: "主图 3:4 / 详情页 9:16", description: "竖版主图，竖版详情页" },
];
const defaultProductForm = {
  productName: "",
  targetPlatform: "国内通用",
  outputLanguage: "简体中文",
  generationProfileId: defaultGenerationProfileId,
  imageAspectRatioProfileId: defaultImageAspectRatioProfileId,
  imageResolutionId: defaultImageResolutionId,
};
const platformOptions = [
  { value: "国内通用", label: "国内通用", summary: "丰富多元素" },
  { value: "淘宝/天猫", label: "淘宝/天猫", summary: "货架转化" },
  { value: "Amazon", label: "Amazon", summary: "简洁可信" },
];
const languageOptions = [
  { value: "简体中文", label: "简体中文" },
  { value: "English", label: "English" },
];
const historyFilterOptions = [
  { value: "all", label: "全部" },
  { value: "active", label: "生成中" },
  { value: "done", label: "已完成" },
  { value: "partial", label: "部分失败" },
  { value: "failed", label: "生成失败" },
  { value: "deleted", label: "已删除" },
];
function formatReferenceSummary(images) {
  if (!images.length) return "未选择图片";
  const primary = images.find((image) => image.role === "主参考图") ?? images[0];
  return `已选 ${images.length} / ${referenceImageLimit} 张 · 主图：${primary.originalName}`;
}

function createReferenceImage(file, index) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}-${index}`,
    file,
    previewUrl: URL.createObjectURL(file),
    originalName: file.name || `参考图${index + 1}`,
    role: index === 0 ? "主参考图" : "细节图",
    useForExpansion: true,
  };
}

function numberedReferenceFilename(image, index) {
  const name = image?.originalName || `图片${index + 1}.png`;
  const role = image?.role || "参考图";
  return `参考图${index + 1}-${role}-${name}`;
}

export function App() {
  const [route, setRoute] = useHashRoute();
  const [outputs, setOutputs] = useState([]);
  const [selectedOutput, setSelectedOutput] = useState(null);
  const portalMode = isPortalMode();
  const [portalUser, setPortalUser] = useState(null);
  const [portalReady, setPortalReady] = useState(!portalMode);

  useEffect(() => {
    if (!portalMode) return undefined;
    let mounted = true;
    const restore = async () => {
      const token = readPortalAccessToken();
      if (!token) {
        if (mounted) setPortalReady(true);
        return;
      }
      try {
        const response = await portalAuthJson("/portal-auth/me");
        if (mounted) setPortalUser(response.data ?? response.user ?? null);
      } catch {
        clearPortalAccessToken();
      } finally {
        if (mounted) setPortalReady(true);
      }
    };
    const expired = () => {
      clearPortalAccessToken();
      if (mounted) setPortalUser(null);
    };
    window.addEventListener("bge-portal-session-expired", expired);
    restore();
    return () => {
      mounted = false;
      window.removeEventListener("bge-portal-session-expired", expired);
    };
  }, [portalMode]);

  async function refreshOutputs(outputId) {
    if (outputId) {
      const output = await fetchJson(`/api/outputs/${encodeURIComponent(outputId)}`);
      setSelectedOutput(output);
      return output;
    }
    const data = await fetchJson("/api/outputs");
    setOutputs(data.outputs ?? []);
    return data.outputs ?? [];
  }

  async function deleteOutput(outputId) {
    await fetchJson(`/api/outputs/${encodeURIComponent(outputId)}`, { method: "DELETE" });
    setOutputs((items) => items.filter((item) => outputKey(item) !== outputId));
    if (selectedOutput && outputKey(selectedOutput) === outputId) setSelectedOutput(null);
  }

  async function deleteTask(taskId) {
    await fetchJson(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
  }

  useEffect(() => {
    if (route.page === "output" && route.outputId) {
      refreshOutputs(route.outputId).catch(() => setSelectedOutput(null));
    }
  }, [route.page, route.outputId]);

  if (portalMode && !portalReady) {
    return <PortalLoading />;
  }

  if (portalMode && !portalUser) {
    return <PortalAccessPage onAuthenticated={setPortalUser} />;
  }

  const signOut = async () => {
    try {
      await portalAuthJson("/portal-auth/logout", { method: "POST" });
    } catch {
      // The local Redis entry might already have expired. The browser session
      // must still be cleared so the next visit cannot reuse a stale token.
    } finally {
      clearPortalAccessToken();
      setPortalUser(null);
      setOutputs([]);
      setSelectedOutput(null);
      setRoute({ page: "home" });
    }
  };

  if (route.page === "output") {
    return (
      <GalleryPage
        output={selectedOutput}
        onBack={() => setRoute({ page: "home" })}
        onRefresh={() => refreshOutputs(route.outputId)}
        onDelete={async (outputId) => {
          await deleteOutput(outputId);
          setRoute({ page: "home" });
          await refreshOutputs();
        }}
        portalUser={portalUser}
        onPortalLogout={portalMode ? signOut : undefined}
      />
    );
  }

  return (
    <WorkbenchPage
      outputs={outputs}
      onRefreshOutputs={() => refreshOutputs()}
      onDeleteOutput={deleteOutput}
      onDeleteTask={deleteTask}
      onViewOutput={(outputId) => setRoute({ page: "output", outputId })}
      portalUser={portalUser}
      onPortalLogout={portalMode ? signOut : undefined}
    />
  );
}

function WorkbenchPage({ outputs, onRefreshOutputs, onDeleteOutput, onDeleteTask, onViewOutput, portalUser, onPortalLogout }) {
  const [referenceImages, setReferenceImages] = useState([]);
  const referenceImagesRef = useRef([]);
  const [referenceDraftReady, setReferenceDraftReady] = useState(false);
  const [referenceModalOpen, setReferenceModalOpen] = useState(false);
  const [productForm, setProductForm] = useState(defaultProductForm);
  const [briefText, setBriefText] = useState("");
  const [briefSource, setBriefSource] = useState("manual");
  const [runState, setRunState] = useState("idle");
  const [job, setJob] = useState(null);
  const [liveOutput, setLiveOutput] = useState(null);
  const [error, setError] = useState("");
  const [refreshingOutputs, setRefreshingOutputs] = useState(false);
  const [outputsMessage, setOutputsMessage] = useState("");
  const [tasks, setTasks] = useState([]);
  const [tasksMessage, setTasksMessage] = useState("");
  const [refreshingTasks, setRefreshingTasks] = useState(false);
  const [deletingProduct, setDeletingProduct] = useState("");
  const [examples, setExamples] = useState([]);
  const [examplesMessage, setExamplesMessage] = useState("");
  const [toastMessage, setToastMessage] = useState("");
  const [expansionModalOpen, setExpansionModalOpen] = useState(false);
  const [expansionSnapshot, setExpansionSnapshot] = useState(null);
  const [expansionJob, setExpansionJob] = useState(null);
  const [expandedDraft, setExpandedDraft] = useState("");
  const [expansionError, setExpansionError] = useState("");
  const [accessTokenValue, setAccessTokenValue] = useState(() => readInternalAccessToken());
  const [accessMode, setAccessMode] = useState("off");
  const [generationProfiles, setGenerationProfiles] = useState(fallbackGenerationProfiles);
  const [imageAspectRatioProfiles, setImageAspectRatioProfiles] = useState(fallbackImageAspectRatioProfiles);
  const [imageResolutionProfiles, setImageResolutionProfiles] = useState(fallbackImageResolutionProfiles);
  const pendingIdempotencyKey = useRef("");
  const draftScope = referenceDraftScope(portalUser);
  const selectedGenerationProfile = generationProfiles.find((profile) => profile.id === productForm.generationProfileId)
    ?? generationProfiles.find((profile) => profile.id === defaultGenerationProfileId)
    ?? fallbackGenerationProfiles[0];
  const selectedImageResolution = imageResolutionProfiles.find((profile) => profile.id === productForm.imageResolutionId)
    ?? imageResolutionProfiles.find((profile) => profile.id === defaultImageResolutionId)
    ?? fallbackImageResolutionProfiles[2];
  const selectedImageAspectRatio = imageAspectRatioProfiles.find((profile) => profile.id === productForm.imageAspectRatioProfileId)
    ?? imageAspectRatioProfiles.find((profile) => profile.id === defaultImageAspectRatioProfileId)
    ?? fallbackImageAspectRatioProfiles[0];

  const hasProductName = Boolean(productForm.productName.trim());
  const hasBriefInput = Boolean(briefText.trim() || hasProductName);
  const isBusy = ["receiving", "submitting", "queued", "running", "canceling"].includes(runState);
  const canGenerate = referenceImages.length > 0 && hasProductName && !isBusy;
  const currentStatus = runState === "idle" && referenceImages.length > 0 && hasBriefInput ? "ready" : runState;
  const isExpandingBrief = ["queued", "running"].includes(expansionJob?.status);
  const expansionButtonLabel =
    isExpandingBrief
      ? "正在扩写中"
      : expansionJob?.status === "done"
        ? expansionJob?.diagnostics?.usedFallback
          ? "查看本地模板"
          : "查看扩写结果"
        : expansionJob?.status === "failed"
          ? "扩写失败，重试"
          : "AI扩写";

  const selectedSummary = useMemo(() => {
    const parts = [];
    if (productForm.productName.trim()) parts.push(productForm.productName.trim());
    else parts.push("请先填写产品名称");
    parts.push(`${productForm.targetPlatform} / ${productForm.outputLanguage}`);
    if (referenceImages.length) parts.push(`${referenceImages.length} 张参考图`);
    if (briefText.trim()) parts.push("重点需求已填写");
    if (briefSource === "ai-expanded") parts.push("AI扩写模板");
    if (selectedGenerationProfile?.summary) parts.push(selectedGenerationProfile.summary);
    if (selectedImageAspectRatio?.summary) parts.push(selectedImageAspectRatio.summary);
    if (selectedImageResolution?.summary) parts.push(selectedImageResolution.summary);
    return parts.length ? parts.join(" / ") : "上传素材后开始";
  }, [referenceImages, briefText, briefSource, productForm, selectedGenerationProfile, selectedImageAspectRatio, selectedImageResolution]);

  useEffect(() => {
    referenceImagesRef.current = referenceImages;
  }, [referenceImages]);

  useEffect(() => {
    let cancelled = false;
    setReferenceDraftReady(false);
    loadReferenceDraft(draftScope)
      .then((items) => {
        if (cancelled || referenceImagesRef.current.length) return;
        const restored = restoreReferenceDraft(items);
        referenceImagesRef.current = restored;
        setReferenceImages(restored);
        if (restored.length) setToastMessage(`已恢复 ${restored.length} 张未提交参考图。`);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setReferenceDraftReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [draftScope]);

  useEffect(() => {
    if (!referenceDraftReady) return undefined;
    const timer = window.setTimeout(() => {
      saveReferenceDraft(draftScope, referenceImages).catch(() => undefined);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [draftScope, referenceDraftReady, referenceImages]);

  useEffect(() => () => {
    referenceImagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl));
  }, []);

  useEffect(() => {
    handleRefreshOutputs();
    handleRefreshExamples();
    handleRefreshTasks();
    fetchJson("/health")
      .then((health) => {
        setAccessMode(health.accessMode === "token" ? "token" : "off");
        if (Array.isArray(health.generationProfiles) && health.generationProfiles.length) {
          setGenerationProfiles(health.generationProfiles);
        }
        if (Array.isArray(health.imageAspectRatioProfiles) && health.imageAspectRatioProfiles.length) {
          setImageAspectRatioProfiles(health.imageAspectRatioProfiles);
        }
        if (Array.isArray(health.imageResolutionProfiles) && health.imageResolutionProfiles.length) {
          setImageResolutionProfiles(health.imageResolutionProfiles);
        }
      })
      .catch(() => setAccessMode("off"));
  }, []);

  useEffect(() => {
    if (!toastMessage) return undefined;
    const timer = window.setTimeout(() => setToastMessage(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toastMessage]);

  useEffect(() => {
    if (!job?.id || !["receiving", "submitting", "queued", "running", "canceling"].includes(runState)) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const nextJob = await fetchJson(`/api/jobs/${encodeURIComponent(job.id)}`);
        cachePromptSnapshot(nextJob);
        setJob(nextJob);
        setRunState(nextJob.status);
        const nextOutputId = nextJob.output?.id || nextJob.outputId || nextJob.outputFolderName || nextJob.productName;
        if (nextOutputId) {
          fetchJson(`/api/outputs/${encodeURIComponent(nextOutputId)}`)
            .then(setLiveOutput)
            .catch(() => undefined);
        }
        handleRefreshTasks({ silent: true });
        if (["done", "partial"].includes(nextJob.status)) {
          window.clearInterval(timer);
          if (nextJob.output) setLiveOutput(nextJob.output);
          await handleRefreshOutputs("作品已生成，可以在已完成作品里查看。");
          await handleRefreshTasks({ silent: true });
        }
        if (["failed", "cancelled", "interrupted"].includes(nextJob.status)) window.clearInterval(timer);
      } catch (pollError) {
        setError(pollError.message);
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [job?.id, runState]);

  useEffect(() => {
    if (!expansionJob?.id || !["queued", "running"].includes(expansionJob.status)) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const nextJob = await fetchJson(`/api/brief-expansions/${encodeURIComponent(expansionJob.id)}`);
        setExpansionJob(nextJob);
        if (nextJob.status === "done") {
          setExpandedDraft(nextJob.resultText || "");
          window.clearInterval(timer);
        }
        if (nextJob.status === "failed") {
          setExpansionError(nextJob.error || nextJob.message || "AI 扩写失败。");
          window.clearInterval(timer);
        }
      } catch (pollError) {
        setExpansionError(pollError.message);
      }
    }, 1600);
    return () => window.clearInterval(timer);
  }, [expansionJob?.id, expansionJob?.status]);

  async function handleRefreshOutputs(successMessage) {
    setRefreshingOutputs(true);
    setOutputsMessage("");
    try {
      const list = await onRefreshOutputs();
      setOutputsMessage(successMessage || `已刷新 ${list.length} 个独立任务成品。`);
    } catch (refreshError) {
      setOutputsMessage(`刷新失败：${refreshError.message}`);
    } finally {
      setRefreshingOutputs(false);
    }
  }

  async function handleRefreshExamples() {
    try {
      const data = await fetchJson("/api/examples");
      setExamples(data.examples ?? []);
      setExamplesMessage("");
    } catch (examplesError) {
      setExamples([]);
      setExamplesMessage(`优秀案例读取失败：${examplesError.message}`);
    }
  }

  async function handleRefreshTasks(options = {}) {
    if (!options.silent) {
      setRefreshingTasks(true);
      setTasksMessage("");
    }
    try {
      const data = await fetchJson("/api/tasks");
      const nextTasks = data.tasks ?? [];
      setTasks(nextTasks);
      syncCurrentJobFromTaskList(nextTasks, data.activeJobId);
      if (!options.silent) setTasksMessage(`已读取 ${data.tasks?.length ?? 0} 条本地任务记录。`);
    } catch (taskError) {
      if (!options.silent) setTasksMessage(`任务记录读取失败：${taskError.message}`);
    } finally {
      if (!options.silent) setRefreshingTasks(false);
    }
  }

  function syncCurrentJobFromTaskList(nextTasks, activeJobId) {
    if (!nextTasks.length) return;
    const trackedJobId = job?.id || activeJobId || "";
    const matchedTask = trackedJobId
      ? nextTasks.find((task) => task.id === trackedJobId || task.taskId === trackedJobId)
      : null;

    if (!matchedTask) {
      if (!job && activeJobId) {
        fetchJson(`/api/jobs/${encodeURIComponent(activeJobId)}`)
          .then((activeJob) => {
            cachePromptSnapshot(activeJob);
            setJob(activeJob);
            setRunState(activeJob.status || "running");
          })
          .catch(() => undefined);
      }
      return;
    }

    const normalizedStatus = matchedTask.status || "unknown";
    setJob((current) => ({
      ...(current || {}),
      ...matchedTask,
      id: current?.id || matchedTask.id,
      output: current?.output || matchedTask.output || null,
    }));
    setRunState(normalizedStatus);

    if (["done", "partial"].includes(normalizedStatus)) {
      const outputId = matchedTask.output?.id || matchedTask.outputId || matchedTask.outputFolderName || matchedTask.productName;
      if (outputId) {
        fetchJson(`/api/outputs/${encodeURIComponent(outputId)}`)
          .then((output) => {
            setLiveOutput(output);
            handleRefreshOutputs();
          })
          .catch(() => undefined);
      }
    }
  }

  function handleApplyExample(example) {
    const nextBrief = buildSameStyleBrief(example, briefText);
    setBriefText(nextBrief);
    setBriefSource("manual");
    setRunState("idle");
    setJob(null);
    setLiveOutput(null);
    setError("");
    window.setTimeout(() => {
      document.querySelector(".brief-card textarea")?.focus();
    }, 0);
  }

  async function handleImportTaskPrompt(task) {
    const cached = readCachedPromptSnapshot(task.id);
    let detail = null;
    try {
      detail = await fetchJson(`/api/tasks/${encodeURIComponent(task.id)}`);
      cachePromptSnapshot(detail);
    } catch (taskError) {
      if (!cached?.complete || !cached?.promptText) {
        setTasksMessage(`导入失败：${taskError.message}`);
        return;
      }
    }
    const detailSnapshot = promptSnapshotFromTask(detail);
    const snapshot = detailSnapshot.complete ? detailSnapshot : cached;
    if (!snapshot.promptText.trim()) {
      setTasksMessage("这条历史记录还没有可导入的提示词。");
      return;
    }
    setBriefText(snapshot.promptText.trim());
    setProductForm((current) => ({
      ...current,
      productName: detail?.originalProductName || cached?.originalProductName || detail?.productName || snapshot.productName || task.productName || current.productName,
      targetPlatform: normalizeUiPlatform(detail?.targetPlatform || cached?.targetPlatform || task.targetPlatform || current.targetPlatform),
      outputLanguage: normalizeUiLanguage(detail?.outputLanguage || cached?.outputLanguage || task.outputLanguage || current.outputLanguage),
      generationProfileId: detail?.generationProfileId || cached?.generationProfileId || task.generationProfileId || current.generationProfileId || defaultGenerationProfileId,
      imageAspectRatioProfileId: detail?.imageAspectRatioProfileId || cached?.imageAspectRatioProfileId || task.imageAspectRatioProfileId || current.imageAspectRatioProfileId || defaultImageAspectRatioProfileId,
      imageResolutionId: normalizeUiImageResolution(detail?.imageResolutionId || cached?.imageResolutionId || task.imageResolutionId || current.imageResolutionId),
    }));
    setBriefSource("history");
    setRunState("idle");
    setJob(null);
    setLiveOutput(null);
    setError("");
    setExpansionJob(null);
    setExpandedDraft("");
    setExpansionError("");
    setExpansionSnapshot(null);
    setToastMessage(`已导入「${snapshot.productName || task.productName || "历史任务"}」的提示词。`);
    window.setTimeout(() => {
      document.querySelector(".brief-card textarea")?.focus();
    }, 0);
  }

  function resetMaterialDependentState() {
    setBriefSource("manual");
    setRunState("idle");
    setJob(null);
    setLiveOutput(null);
    setError("");
    setExpansionJob(null);
    setExpandedDraft("");
    setExpansionError("");
    setExpansionSnapshot(null);
  }

  function updateProductForm(patch) {
    setProductForm((current) => ({ ...current, ...patch }));
    resetMaterialDependentState();
  }

  function addReferenceFiles(files) {
    const incoming = Array.from(files ?? []);
    const current = referenceImagesRef.current;
    const plan = planReferenceFileAddition(current, incoming, referenceImageLimit);
    setToastMessage(referenceUploadFeedback(plan));
    if (!plan.accepted.length) return;

    const created = plan.accepted.map((file, index) => createReferenceImage(file, current.length + index));
    const next = [...current, ...created];
    referenceImagesRef.current = next;
    setReferenceImages(next);
    resetMaterialDependentState();
  }

  function removeReferenceImage(id) {
    setReferenceImages((current) => {
      const removed = current.find((image) => image.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      const next = current.filter((image) => image.id !== id);
      if (next.length && !next.some((image) => image.role === "主参考图")) {
        return next.map((image, index) => index === 0 ? { ...image, role: "主参考图" } : image);
      }
      return next;
    });
    resetMaterialDependentState();
  }

  function updateReferenceImage(id, patch) {
    setReferenceImages((current) => {
      const next = current.map((image) => image.id === id ? { ...image, ...patch } : image);
      if (patch.role === "主参考图") {
        return next.map((image) => image.id === id ? image : image.role === "主参考图" ? { ...image, role: "细节图" } : image);
      }
      if (!next.some((image) => image.role === "主参考图") && next.length) {
        return next.map((image, index) => index === 0 ? { ...image, role: "主参考图" } : image);
      }
      return next;
    });
    resetMaterialDependentState();
  }

  function moveReferenceImage(id, direction) {
    setReferenceImages((current) => {
      const index = current.findIndex((image) => image.id === id);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
    resetMaterialDependentState();
  }

  function expansionReferenceImagesFromCurrent() {
    const selected = referenceImages.filter((image) => image.useForExpansion);
    if (selected.length) return selected;
    const primary = referenceImages.find((image) => image.role === "主参考图");
    return primary ? [{ ...primary, useForExpansion: true }] : referenceImages.map((image) => ({ ...image, useForExpansion: true }));
  }

  function updateExpansionSnapshotImage(id, patch) {
    setExpansionSnapshot((snapshot) => {
      if (!snapshot) return snapshot;
      return {
        ...snapshot,
        referenceImages: snapshot.referenceImages.map((image) => image.id === id ? { ...image, ...patch } : image),
      };
    });
    setExpansionJob(null);
    setExpandedDraft("");
    setExpansionError("");
  }

  function openBriefExpansionModal() {
    if (["queued", "running", "done", "failed"].includes(expansionJob?.status)) {
      setExpansionModalOpen(true);
      return;
    }
    if (!referenceImages.length) {
      setToastMessage("请先上传产品图片。");
      return;
    }
    if (!productForm.productName.trim()) {
      setToastMessage("请先输入产品名称。");
      return;
    }
    setExpansionSnapshot({
      productForm: { ...productForm },
      briefText,
      referenceImages: expansionReferenceImagesFromCurrent().map((image) => ({ ...image })),
      createdAt: new Date().toISOString(),
    });
    setExpandedDraft("");
    setExpansionError("");
    setExpansionJob(null);
    setExpansionModalOpen(true);
  }

  async function startBriefExpansion() {
    const snapshotImages = expansionSnapshot?.referenceImages ?? [];
    const selectedImages = snapshotImages.filter((image) => image.useForExpansion);
    const imagesForExpansion = selectedImages;
    if (!imagesForExpansion.length) {
      setExpansionError("请至少选择 1 张参考图用于 AI 扩写。");
      return;
    }
    setExpansionError("");
    setExpandedDraft("");
    try {
      const form = new FormData();
      imagesForExpansion.forEach((image, index) => form.append("referenceImages", image.file, numberedReferenceFilename(image, index)));
      if (expansionSnapshot.briefText.trim()) form.append("briefText", expansionSnapshot.briefText.trim());
      form.append("productName", expansionSnapshot.productForm?.productName?.trim() || "");
      form.append("targetPlatform", expansionSnapshot.productForm?.targetPlatform || defaultProductForm.targetPlatform);
      form.append("outputLanguage", expansionSnapshot.productForm?.outputLanguage || defaultProductForm.outputLanguage);
      form.append("generationProfileId", expansionSnapshot.productForm?.generationProfileId || defaultGenerationProfileId);
      form.append("imageAspectRatioProfileId", expansionSnapshot.productForm?.imageAspectRatioProfileId || defaultImageAspectRatioProfileId);
      form.append("imageResolutionId", expansionSnapshot.productForm?.imageResolutionId || defaultImageResolutionId);
      form.append("briefFocus", expansionSnapshot.briefText.trim());
      const created = await fetchJson("/api/brief-expansions", { method: "POST", body: form });
      setExpansionJob(created);
    } catch (expandError) {
      setExpansionError(expandError.message);
      setExpansionJob({ status: "failed", message: expandError.message });
    }
  }

  function restartBriefExpansion() {
    if (!expansionSnapshot?.referenceImages?.length && !referenceImages.length) {
      setToastMessage("请先上传产品图片。");
      return;
    }
    if (!expansionSnapshot) {
      setExpansionSnapshot({
        productForm: { ...productForm },
        briefText,
        referenceImages: expansionReferenceImagesFromCurrent().map((image) => ({ ...image })),
        createdAt: new Date().toISOString(),
      });
    }
    setExpansionJob(null);
    setExpandedDraft("");
    setExpansionError("");
  }

  function applyExpandedDraft() {
    if (!expandedDraft.trim()) return;
    setBriefText(expandedDraft.trim());
    setBriefSource("ai-expanded");
    setRunState("idle");
    setJob(null);
    setLiveOutput(null);
    setError("");
    setExpansionModalOpen(false);
    window.setTimeout(() => {
      document.querySelector(".brief-card textarea")?.focus();
    }, 0);
  }

  async function copyExpandedDraft() {
    if (!expandedDraft.trim()) return;
    try {
      await navigator.clipboard.writeText(expandedDraft.trim());
      setToastMessage("AI 扩写内容已复制。");
    } catch {
      setToastMessage("复制失败，请手动选中文本复制。");
    }
  }

  async function handleDeleteRecord(record) {
    const taskId = record?.task?.id || "";
    const outputId = record?.outputId || (record?.output ? outputKey(record.output) : "");
    const deleteKey = record?.deleteKey || taskId || outputId || record?.id || "";
    const displayName = record?.productName || (record?.output ? outputLabel(record.output) : outputId);
    const ok = window.confirm(`确定删除「${displayName}」吗？这会删除这条历史记录，并清理对应的待作图素材和已完成作品。`);
    if (!ok) return;
    setDeletingProduct(deleteKey);
    setOutputsMessage("");
    try {
      if (taskId) await onDeleteTask(taskId);
      else if (outputId) await onDeleteOutput(outputId);
      else throw new Error("这条历史记录缺少可删除的任务标识。");
      await handleRefreshOutputs(`已删除「${displayName}」的历史记录和对应文件。`);
      await handleRefreshTasks({ silent: true });
    } catch (deleteError) {
      setOutputsMessage(`删除失败：${deleteError.message}`);
    } finally {
      setDeletingProduct("");
    }
  }

  async function handleGenerate() {
    if (!canGenerate) return;
    setError("");
    setJob({
      id: "",
      status: "submitting",
      message: "正在接收素材并创建任务。",
      productName: productForm.productName.trim(),
      generationProfileId: selectedGenerationProfile.id,
      mainImageCount: selectedGenerationProfile.mainImageCount,
      detailImageCount: selectedGenerationProfile.detailImageCount,
      imageAspectRatioProfileId: selectedImageAspectRatio.id,
      imageAspectRatioProfileLabel: selectedImageAspectRatio.label,
      mainAspectRatio: selectedImageAspectRatio.mainAspectRatio,
      detailAspectRatio: selectedImageAspectRatio.detailAspectRatio,
      imageResolutionId: selectedImageResolution.id,
      progress: {
        stage: "receiving",
        message: "正在接收上传素材。",
        total: selectedGenerationProfile.mainImageCount + selectedGenerationProfile.detailImageCount,
        completed: 0,
        mainCompleted: 0,
        detailCompleted: 0,
      },
    });
    setRunState("submitting");
    setLiveOutput(null);
    try {
      const form = new FormData();
      referenceImages.forEach((image, index) => form.append("referenceImages", image.file, numberedReferenceFilename(image, index)));
      if (briefText.trim()) form.append("briefText", briefText.trim());
      form.append("productName", productForm.productName.trim());
      form.append("targetPlatform", productForm.targetPlatform);
      form.append("outputLanguage", productForm.outputLanguage);
      form.append("generationProfileId", productForm.generationProfileId);
      form.append("imageAspectRatioProfileId", productForm.imageAspectRatioProfileId);
      form.append("imageResolutionId", productForm.imageResolutionId);
      form.append("briefFocus", briefText.trim());
      form.append("expandBrief", briefSource === "ai-expanded" ? "false" : "true");
      const idempotencyKey = pendingIdempotencyKey.current || createIdempotencyKey();
      pendingIdempotencyKey.current = idempotencyKey;
      const created = await fetchJson("/api/jobs", { method: "POST", headers: { "X-Idempotency-Key": idempotencyKey }, body: form });
      pendingIdempotencyKey.current = "";
      cachePromptSnapshot(created);
      setJob(created);
      setRunState(created.status);
      await handleRefreshTasks({ silent: true });
    } catch (submitError) {
      if (submitError.statusCode && submitError.statusCode !== 0) pendingIdempotencyKey.current = "";
      setRunState("failed");
      setError(submitError.message);
      setJob((current) => current ? { ...current, status: "failed", message: submitError.message } : current);
    }
  }

  async function handleCancelJob() {
    if (!job?.id || !isBusy || runState === "canceling") return;
    if (!window.confirm("确定停止当前任务吗？已经生成的图片会保留。")) return;
    setError("");
    setRunState("canceling");
    try {
      const cancelled = await fetchJson(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, { method: "POST" });
      setJob(cancelled);
      setRunState(cancelled.status || "cancelled");
      await handleRefreshTasks({ silent: true });
      await handleRefreshOutputs("任务已停止，已完成图片仍然保留。" );
    } catch (cancelError) {
      setError(`取消失败：${cancelError.message}`);
      await handleRefreshTasks({ silent: true });
    }
  }

  function handleAccessTokenChange(value) {
    setAccessTokenValue(value);
    writeInternalAccessToken(value);
  }

  const finishedProduct = job?.output?.id || job?.outputId || job?.outputFolderName || job?.productName;
  const hasFinishedOutput = ["done", "partial"].includes(job?.status) && finishedProduct;

  return (
    <main className="app-shell">
      <section className="workspace">
        <Header currentStatus={currentStatus} portalUser={portalUser} onPortalLogout={onPortalLogout} />
        {toastMessage ? <div className="toast-banner" role="status" aria-live="polite">{toastMessage}</div> : null}

        <div className="layout-grid">
          <section className="input-column" aria-label="素材上传">
              <ReferenceUploadCard
                images={referenceImages}
                limit={referenceImageLimit}
                onOpen={() => setReferenceModalOpen(true)}
                onAddFiles={addReferenceFiles}
              />

            <section className="brief-card compact-brief-card">
              <label className="primary-name-field">
                <span>产品名称</span>
                <input
                  value={productForm.productName}
                  placeholder="输入产品名称"
                  onChange={(event) => updateProductForm({ productName: event.target.value })}
                />
              </label>

              <textarea
                value={briefText}
                placeholder={briefPlaceholder}
                onChange={(event) => {
                  setBriefText(event.target.value);
                  setBriefSource("manual");
                  setRunState("idle");
                  setJob(null);
                  setLiveOutput(null);
                  setError("");
                }}
              />
              <div className="brief-actions">
                <button
                  className={isExpandingBrief ? "rewrite-button running" : expansionJob?.status === "done" ? "rewrite-button done" : "rewrite-button"}
                  type="button"
                  onClick={openBriefExpansionModal}
                >
                  {isExpandingBrief ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
                  {expansionButtonLabel}
                </button>
              </div>
              <GenerationOptionControls
                form={productForm}
                profiles={generationProfiles}
                aspectRatioProfiles={imageAspectRatioProfiles}
                resolutionProfiles={imageResolutionProfiles}
                onChange={updateProductForm}
              />
              {briefSource === "ai-expanded" ? (
                <p className="brief-source-note">已使用 AI 扩写模板，立即生成时不会再次扩写。</p>
              ) : null}
              {briefSource === "history" ? (
                <p className="brief-source-note">已导入历史提示词，提交时会按当前内容重新生成独立任务。</p>
              ) : null}
            </section>

            <section className="run-card">
              <div>
                <p className="section-kicker">工作流</p>
                <h2>扩写需求并生成主图与详情页</h2>
                <p>{job?.message || selectedSummary}</p>
                {error ? <p className="error-text">{error}</p> : null}
              </div>
              <button className="generate-button" type="button" disabled={!canGenerate} onClick={handleGenerate}>
                {isBusy ? <Loader2 size={18} className="spin" /> : <Sparkles size={18} />}
                {isBusy ? "生成中" : "立即生成"}
                <ArrowRight size={18} />
              </button>
              {!isPortalMode() && accessMode === "token" ? (
                <label className="access-token-field">
                  <span>内部访问令牌</span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={accessTokenValue}
                    placeholder="局域网提交任务时填写"
                    onChange={(event) => handleAccessTokenChange(event.target.value)}
                  />
                  <small>仅保存在当前浏览器会话，不会写入任务或项目文件。</small>
                </label>
              ) : null}
              {isBusy ? (
                <button className="danger-button compact-cancel-button" type="button" disabled={!job?.id || runState === "canceling"} onClick={handleCancelJob}>
                  {runState === "canceling" ? <Loader2 size={18} className="spin" /> : <X size={18} />}
                  {runState === "canceling" ? "正在停止任务" : "停止当前任务"}
                </button>
              ) : null}
              <button
                className="secondary-button"
                type="button"
                disabled={!hasFinishedOutput}
                onClick={() => onViewOutput(finishedProduct)}
              >
                <Eye size={18} />
                查看已完成成品图
              </button>
            </section>

          </section>

          <ShowcasePanel
            outputs={outputs}
            tasks={tasks}
            job={job}
            liveOutput={liveOutput}
            runState={runState}
            refreshingOutputs={refreshingOutputs}
            refreshingTasks={refreshingTasks}
            outputsMessage={outputsMessage}
            tasksMessage={tasksMessage}
            deletingProduct={deletingProduct}
            examples={examples}
            examplesMessage={examplesMessage}
            onRefreshHistory={() => Promise.all([handleRefreshOutputs(), handleRefreshTasks()])}
            onDeleteRecord={handleDeleteRecord}
            onViewOutput={onViewOutput}
            onImportPrompt={handleImportTaskPrompt}
            onApplyExample={handleApplyExample}
          />
        </div>

        {expansionModalOpen ? (
          <BriefExpansionModal
            snapshot={expansionSnapshot}
            job={expansionJob}
            draft={expandedDraft}
            error={expansionError}
            onDraftChange={setExpandedDraft}
            onSnapshotImageChange={updateExpansionSnapshotImage}
            onStart={startBriefExpansion}
            onRestart={restartBriefExpansion}
            onApply={applyExpandedDraft}
            onCopy={copyExpandedDraft}
            onClose={() => setExpansionModalOpen(false)}
          />
        ) : null}
        {referenceModalOpen ? (
          <ReferenceManagerModal
            images={referenceImages}
            limit={referenceImageLimit}
            onAddFiles={addReferenceFiles}
            onRemove={removeReferenceImage}
            onUpdate={updateReferenceImage}
            onMove={moveReferenceImage}
            onClose={() => setReferenceModalOpen(false)}
          />
        ) : null}
      </section>
    </main>
  );
}

function GenerationOptionControls({ form, profiles, aspectRatioProfiles, resolutionProfiles, onChange }) {
  const selectedProfile = profiles.find((profile) => profile.id === form.generationProfileId)
    ?? profiles.find((profile) => profile.id === defaultGenerationProfileId)
    ?? fallbackGenerationProfiles[0];
  const selectedResolution = resolutionProfiles.find((profile) => profile.id === form.imageResolutionId)
    ?? resolutionProfiles.find((profile) => profile.id === defaultImageResolutionId)
    ?? fallbackImageResolutionProfiles[2];
  const selectedAspectRatio = aspectRatioProfiles.find((profile) => profile.id === form.imageAspectRatioProfileId)
    ?? aspectRatioProfiles.find((profile) => profile.id === defaultImageAspectRatioProfileId)
    ?? fallbackImageAspectRatioProfiles[0];
  return (
    <div className="generation-options" aria-label="生成参数">
      <label className="mini-select">
        <span>选择语言</span>
        <select
          value={form.outputLanguage}
          onChange={(event) => onChange({ outputLanguage: event.target.value })}
        >
          {languageOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>

      <label className="mini-select">
        <span>选择平台</span>
        <select
          value={form.targetPlatform}
          onChange={(event) => onChange({ targetPlatform: event.target.value })}
        >
          {platformOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>

      <label className="mini-select">
        <span>生图比例</span>
        <select
          value={selectedAspectRatio.id}
          onChange={(event) => onChange({ imageAspectRatioProfileId: event.target.value })}
          title={selectedAspectRatio.description}
        >
          {aspectRatioProfiles.map((profile) => (
            <option key={profile.id} value={profile.id}>{profile.summary.replaceAll(" ", "")}</option>
          ))}
        </select>
      </label>

      <label className="mini-select">
        <span>图片清晰度</span>
        <select
          value={selectedResolution.id}
          onChange={(event) => onChange({ imageResolutionId: event.target.value })}
          title={selectedResolution.description}
        >
          {resolutionProfiles.map((profile) => (
            <option key={profile.id} value={profile.id}>{profile.label}</option>
          ))}
        </select>
      </label>

      <label className="mini-select suite-count-select">
        <span>套图数量</span>
        <select
          value={selectedProfile.id}
          onChange={(event) => onChange({ generationProfileId: event.target.value })}
          title="选择交付数量；不会改变生图比例"
        >
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>{profile.summary.replaceAll(" ", "")}</option>
          ))}
        </select>
      </label>
      <p className="resolution-help">{selectedResolution.description}</p>
    </div>
  );
}

function ReferenceUploadCard({ images, limit, onOpen, onAddFiles }) {
  const primary = images.find((image) => image.role === "主参考图") ?? images[0];
  const previewImages = images.slice(0, 4);
  const { isFileDragging, dropZoneProps } = useFileDropZone(onAddFiles);

  return (
    <section
      className={`upload-card reference-upload-card ${isFileDragging ? "is-file-dragging" : ""}`}
      {...dropZoneProps}
    >
      <div className="upload-copy">
        <div className="icon-badge"><ImagePlus size={24} /></div>
        <div>
          <h2>上传参考图</h2>
          <p>商品多角度、细节图、场景参考图，最多 {limit} 张。</p>
        </div>
      </div>
      <button className="reference-manager-trigger" type="button" onClick={onOpen}>
        {images.length ? (
          <>
            <div className="reference-cover">
              <img src={primary.previewUrl} alt={primary.originalName} />
            </div>
            <div className="reference-trigger-copy">
              <strong>{formatReferenceSummary(images)}</strong>
              <span>点击管理、继续添加，或直接拖拽图片到这里</span>
            </div>
          </>
        ) : (
          <>
            <UploadCloud size={24} />
            <div className="reference-trigger-copy">
              <strong>未选择图片</strong>
              <span>点击管理，或直接拖拽图片到这里</span>
            </div>
          </>
        )}
      </button>
      {previewImages.length ? (
        <div className="reference-thumb-strip" aria-label="已上传参考图缩略图">
          {previewImages.map((image, index) => (
            <button key={image.id} type="button" onClick={onOpen} title={image.originalName}>
              <img src={image.previewUrl} alt={`参考图${index + 1}`} />
              <span>参考图{index + 1}</span>
            </button>
          ))}
          {images.length > previewImages.length ? <span className="reference-more">+{images.length - previewImages.length}</span> : null}
        </div>
      ) : null}
      {isFileDragging ? (
        <div className="reference-drop-overlay" role="status" aria-live="polite">
          <UploadCloud size={32} />
          <strong>{images.length < limit ? "松开即可添加参考图" : `已达到 ${limit} 张上限`}</strong>
          <span>{images.length < limit ? `还可添加 ${limit - images.length} 张图片` : "松开后不会覆盖已有图片"}</span>
        </div>
      ) : null}
    </section>
  );
}

function HistoryRecordsPanel({
  records,
  message,
  refreshing,
  deletingProduct,
  onRefresh,
  onOpenAll,
  onViewOutput,
  onImportPrompt,
  onDeleteRecord,
}) {
  const recentRecords = records.slice(0, 6);
  const portalMode = isPortalMode();

  return (
    <section className="history-records-card completed-strip recent-strip">
      <div className="history-records-title completed-title">
        <FolderOpen size={18} />
        <div>
          <strong>{portalMode ? "我的任务" : "历史任务"}</strong>
          <small>{portalMode ? "这里只显示当前账号提交的作图任务和成品。" : "成品、生成时间、历史提示词和生成状态集中在这里。"}</small>
        </div>
        <div className="history-title-actions">
          <button type="button" onClick={onOpenAll}>
            查看全部
          </button>
          <button type="button" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw size={15} className={refreshing ? "spin" : ""} />
            {refreshing ? "刷新中" : "刷新"}
          </button>
        </div>
      </div>
      {message ? <p className="completed-message">{message}</p> : null}
      <div className="history-records-list">
        {recentRecords.map((record) => (
          <article className="history-record-item" key={record.id}>
            <div className="history-record-main">
              <strong title={record.productName}>{record.productName}</strong>
              <span>{record.message}</span>
              <small>生成时间：{record.timeLabel || "未知"}{record.referenceCount ? ` · ${record.referenceCount} 张参考图` : ""}</small>
              {record.briefDiagnostic ? <small className="history-brief-diagnostic">{record.briefDiagnostic}</small> : null}
            </div>
            <HistoryRecordActions
              record={record}
              deletingProduct={deletingProduct}
              onViewOutput={onViewOutput}
              onImportPrompt={onImportPrompt}
              onDeleteRecord={onDeleteRecord}
            />
          </article>
        ))}
        {!recentRecords.length ? <p>{portalMode ? "还没有我的任务，提交一次生成后会自动保存。" : "还没有历史任务，提交一次生成后会自动保存。"}</p> : null}
      </div>
    </section>
  );
}

function HistoryRecordActions({ record, deletingProduct, onViewOutput, onImportPrompt, onDeleteRecord }) {
  const isActive = ["queued", "running", "submitting"].includes(record.status);
  const deleteKey = record.deleteKey || record.id;
  const canDelete = !isActive && Boolean(record.task || record.output || record.outputId);
  return (
    <div className="history-record-actions">
      <span className={`task-status-dot status-${record.status}`}>
        {isActive ? <Loader2 size={13} className="spin" /> : null}
        {record.statusLabel}
      </span>
      <button type="button" onClick={() => onImportPrompt(record.task)} disabled={!record.task || !record.promptAvailable}>
        <RotateCcw size={14} />
        导入提示词
      </button>
      {record.outputId ? (
        <button type="button" onClick={() => onViewOutput(record.outputId)}>
          <Eye size={14} />
          查看成品
        </button>
      ) : null}
      {canDelete ? (
        <button
          className="history-delete-button"
          type="button"
          disabled={deletingProduct === deleteKey}
          onClick={() => onDeleteRecord(record)}
          aria-label={`删除 ${record.productName}`}
          title="删除历史记录、待作图素材和已完成作品"
        >
          {deletingProduct === deleteKey ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
          删除
        </button>
      ) : null}
    </div>
  );
}

function HistoryRecordsModal({
  records,
  message,
  refreshing,
  deletingProduct,
  onRefresh,
  onViewOutput,
  onImportPrompt,
  onDeleteRecord,
  onClose,
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const portalMode = isPortalMode();
  const counts = useMemo(() => {
    const next = Object.fromEntries(historyFilterOptions.map((option) => [option.value, 0]));
    next.all = records.length;
    for (const record of records) {
      const bucket = historyStatusBucket(record.status);
      if (next[bucket] !== undefined) next[bucket] += 1;
    }
    return next;
  }, [records]);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredRecords = useMemo(
    () => records.filter((record) => {
      const matchesFilter = filter === "all" || historyStatusBucket(record.status) === filter;
      const matchesQuery = !normalizedQuery || historyRecordSearchText(record).includes(normalizedQuery);
      return matchesFilter && matchesQuery;
    }),
    [filter, normalizedQuery, records]
  );

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="modal-layer history-layer"
      role="dialog"
      aria-modal="true"
      aria-label={portalMode ? "我的任务管理" : "历史任务管理"}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="history-modal">
        <header className="modal-header">
          <div>
            <p className="eyebrow">{portalMode ? "当前账号" : "本地历史记录"}</p>
            <h2>{portalMode ? "我的任务" : "历史任务"}</h2>
          </div>
          <div className="preview-tools">
            <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={refreshing}>
              <RefreshCw size={17} className={refreshing ? "spin" : ""} />
              {refreshing ? "刷新中" : "刷新"}
            </button>
            <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="history-modal-toolbar">
          <label className="history-search-box">
            <Search size={17} />
            <input
              value={query}
              placeholder="搜索商品、状态、平台、失败原因"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="history-filter-tabs" role="tablist" aria-label={portalMode ? "我的任务状态筛选" : "历史任务状态筛选"}>
            {historyFilterOptions.map((option) => (
              <button
                key={option.value}
                className={filter === option.value ? "active" : ""}
                type="button"
                onClick={() => setFilter(option.value)}
              >
                {option.label}
                <span>{counts[option.value] ?? 0}</span>
              </button>
            ))}
          </div>
        </div>

        {message ? <p className="history-modal-message">{message}</p> : null}

        <div className="history-modal-list">
          {filteredRecords.map((record) => (
            <article className="history-modal-item" key={record.id}>
              <div className="history-modal-main">
                <div className="history-modal-line">
                  <strong title={record.productName}>{record.productName}</strong>
                  <span className={`task-status-dot status-${record.status}`}>
                    {["queued", "running", "submitting"].includes(record.status) ? <Loader2 size={13} className="spin" /> : null}
                    {record.statusLabel}
                  </span>
                </div>
                <div className="history-modal-meta">
                  <span>生成时间：{record.timeLabel || "未知"}</span>
                  {record.referenceCount ? <span>{record.referenceCount} 张参考图</span> : null}
                  {record.targetPlatform ? <span>平台：{record.targetPlatform}</span> : null}
                  {record.outputLanguage ? <span>语言：{record.outputLanguage}</span> : null}
                  {record.imageResolutionLabel ? <span>清晰度：{record.imageResolutionLabel}</span> : null}
                  {record.promptAvailable ? <span>提示词可导入</span> : <span>无完整提示词</span>}
                </div>
                {record.briefDiagnostic ? <p className="history-brief-diagnostic">{record.briefDiagnostic}</p> : null}
                <p className={isProblemHistoryStatus(record.status) ? "history-record-note warning" : "history-record-note"}>
                  {record.message || "暂无任务事件"}
                </p>
              </div>
              <HistoryRecordActions
                record={record}
                deletingProduct={deletingProduct}
                onViewOutput={onViewOutput}
                onImportPrompt={onImportPrompt}
                onDeleteRecord={onDeleteRecord}
              />
            </article>
          ))}
          {!filteredRecords.length ? (
            <div className="history-empty-state">
              <FolderOpen size={28} />
              <strong>{portalMode ? "没有匹配的我的任务" : "没有匹配的历史任务"}</strong>
              <span>换一个关键词或状态筛选再试试。</span>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function ReferenceManagerModal({ images, limit, onAddFiles, onRemove, onUpdate, onMove, onClose }) {
  const canAddMore = images.length < limit;
  const [previewId, setPreviewId] = useState(null);
  const previewIndex = images.findIndex((image) => image.id === previewId);
  const previewImage = previewIndex >= 0 ? images[previewIndex] : null;
  const { isFileDragging, dropZoneProps } = useFileDropZone(onAddFiles);

  useEffect(() => {
    if (previewId && previewIndex < 0) setPreviewId(null);
  }, [previewId, previewIndex]);

  return (
    <>
      <div className="modal-layer" role="dialog" aria-modal="true" aria-label="参考图管理">
        <section
          className={`reference-modal ${isFileDragging ? "is-file-dragging" : ""}`}
          {...dropZoneProps}
        >
        <header className="modal-header">
          <div>
            <p className="eyebrow">上传参考图</p>
            <h2>管理产品参考图</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="reference-modal-toolbar">
          <div>
            <strong>已上传 {images.length} / {limit} 张</strong>
            <span>建议包含主图、细节图、结构图或场景参考图；生成使用全部参考图，勾选项只控制 AI 扩写。</span>
          </div>
          <label className={`reference-add-button ${canAddMore ? "" : "disabled"}`}>
            <input
              type="file"
              accept="image/*"
              multiple
              disabled={!canAddMore}
              onChange={(event) => {
                onAddFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <ImagePlus size={17} />
            添加新图片
          </label>
        </div>

        {images.length ? (
          <div className="reference-grid">
            {images.map((image, index) => (
              <article className="reference-item" key={image.id}>
                <div className="reference-preview">
                  <button
                    className="reference-image-open"
                    type="button"
                    onClick={() => setPreviewId(image.id)}
                    aria-label={`查看参考图${index + 1}：${image.originalName}`}
                    title={`点击查看大图：${image.originalName}`}
                  >
                    <img src={image.previewUrl} alt={`${image.originalName} 预览`} />
                    <em><Eye size={15} /> 点击查看</em>
                  </button>
                  <span>参考图{index + 1}</span>
                  {image.role === "主参考图" ? <strong className="reference-role-badge">主参考图</strong> : null}
                  <button
                    className="reference-delete-floating"
                    type="button"
                    onClick={() => onRemove(image.id)}
                    aria-label={`删除参考图${index + 1}`}
                    title="删除这张图"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                <div className="reference-item-body">
                  <strong title={image.originalName}>{image.originalName}</strong>
                  <label>
                    <span>图片角色</span>
                    <select
                      value={image.role}
                      onChange={(event) => onUpdate(image.id, { role: event.target.value })}
                    >
                      {referenceImageRoles.map((role) => (
                        <option value={role} key={role}>{role}</option>
                      ))}
                    </select>
                  </label>
                  <label className="reference-check">
                    <input
                      type="checkbox"
                      checked={image.useForExpansion}
                      onChange={(event) => onUpdate(image.id, { useForExpansion: event.target.checked })}
                    />
                    <span>参与 AI 扩写</span>
                  </label>
                  <div className="reference-actions">
                    {image.role !== "主参考图" ? (
                      <button
                        className="reference-primary-action"
                        type="button"
                        onClick={() => onUpdate(image.id, { role: "主参考图" })}
                      >
                        设为主图
                      </button>
                    ) : null}
                    <button type="button" disabled={index === 0} onClick={() => onMove(image.id, -1)}>
                      <ArrowLeft size={15} />
                      前移
                    </button>
                    <button type="button" disabled={index === images.length - 1} onClick={() => onMove(image.id, 1)}>
                      后移
                      <ArrowRight size={15} />
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <label className="reference-empty-uploader">
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => {
                onAddFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <UploadCloud size={30} />
            <strong>点击或拖拽添加产品参考图</strong>
            <span>最多 {limit} 张，支持 png / jpg / webp / gif。</span>
          </label>
        )}

        {isFileDragging ? (
          <div className="reference-drop-overlay modal-drop-overlay" role="status" aria-live="polite">
            <UploadCloud size={38} />
            <strong>{canAddMore ? "松开即可添加参考图" : `已达到 ${limit} 张上限`}</strong>
            <span>{canAddMore ? `新图片将追加到现有列表，还可添加 ${limit - images.length} 张` : "松开后不会覆盖已有图片"}</span>
          </div>
        ) : null}

        <footer className="reference-modal-footer">
          <p>生成图片会使用这里的全部参考图；AI 扩写默认只使用勾选图片。</p>
          <button className="generate-button compact" type="button" onClick={onClose}>
            完成
          </button>
        </footer>
        </section>
      </div>
      {previewImage ? (
        <ReferenceImagePreviewModal
          image={previewImage}
          index={previewIndex}
          total={images.length}
          onClose={() => setPreviewId(null)}
          onPrevious={() => setPreviewId(images[(previewIndex - 1 + images.length) % images.length].id)}
          onNext={() => setPreviewId(images[(previewIndex + 1) % images.length].id)}
        />
      ) : null}
    </>
  );
}

function useFileDropZone(onFiles) {
  const [isFileDragging, setIsFileDragging] = useState(false);
  const dragDepth = useRef(0);

  function isFileDrag(event) {
    return Array.from(event.dataTransfer?.types ?? []).includes("Files");
  }

  function resetDragState() {
    dragDepth.current = 0;
    setIsFileDragging(false);
  }

  return {
    isFileDragging,
    dropZoneProps: {
      onDragEnter(event) {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        dragDepth.current += 1;
        setIsFileDragging(true);
      },
      onDragOver(event) {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      },
      onDragLeave(event) {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setIsFileDragging(false);
      },
      onDrop(event) {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        const droppedFiles = event.dataTransfer?.files;
        resetDragState();
        if (droppedFiles?.length) onFiles(droppedFiles);
      },
    },
  };
}

function ReferenceImagePreviewModal({ image, index, total, onClose, onPrevious, onNext }) {
  const [zoom, setZoom] = useState(1);
  const [dimensions, setDimensions] = useState(null);

  useEffect(() => {
    setZoom(1);
    setDimensions(null);
  }, [image.id]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft" && total > 1) onPrevious();
      if (event.key === "ArrowRight" && total > 1) onNext();
      if (["+", "="].includes(event.key)) setZoom((value) => clampZoom(value + 0.2));
      if (event.key === "-") setZoom((value) => clampZoom(value - 0.2));
      if (event.key === "0") setZoom(1);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, onPrevious, onNext, total]);

  return (
    <div
      className="modal-layer reference-lightbox-layer"
      role="dialog"
      aria-modal="true"
      aria-label={`查看参考图：${image.originalName}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="reference-lightbox">
        <header className="modal-header reference-lightbox-header">
          <div className="reference-lightbox-title">
            <p className="eyebrow">参考图 {index + 1} / {total}</p>
            <h2 title={image.originalName}>{image.originalName}</h2>
          </div>
          <div className="reference-zoom-tools" aria-label="图片缩放控制">
            <button type="button" onClick={() => setZoom((value) => clampZoom(value - 0.2))} aria-label="缩小图片"><ZoomOut size={17} /></button>
            <button type="button" onClick={() => setZoom(1)} title="适应窗口">{Math.round(zoom * 100)}%</button>
            <button type="button" onClick={() => setZoom((value) => clampZoom(value + 0.2))} aria-label="放大图片"><ZoomIn size={17} /></button>
            <button className="icon-button" type="button" onClick={onClose} aria-label="关闭预览" autoFocus><X size={18} /></button>
          </div>
        </header>
        <div
          className="reference-lightbox-stage"
          onWheel={(event) => {
            event.preventDefault();
            setZoom((value) => clampZoom(value + (event.deltaY < 0 ? 0.15 : -0.15)));
          }}
        >
          {total > 1 ? (
            <button className="preview-nav left" type="button" onClick={onPrevious} aria-label="上一张参考图"><ArrowLeft size={22} /></button>
          ) : null}
          <img
            src={image.previewUrl}
            alt={image.originalName}
            style={{ "--reference-preview-zoom": zoom }}
            onLoad={(event) => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          />
          {total > 1 ? (
            <button className="preview-nav right" type="button" onClick={onNext} aria-label="下一张参考图"><ArrowRight size={22} /></button>
          ) : null}
        </div>
        <footer className="reference-lightbox-meta">
          <div><span>完整文件名</span><strong>{image.originalName}</strong></div>
          <div><span>图片尺寸</span><strong>{dimensions ? `${dimensions.width} × ${dimensions.height} px` : "读取中…"}</strong></div>
          <div><span>文件大小</span><strong>{formatFileSize(image.file?.size)}</strong></div>
          <small>滚轮缩放 · ← → 切换 · Esc 关闭 · 数字 0 适应窗口</small>
        </footer>
      </section>
    </div>
  );
}

function clampZoom(value) {
  return Math.min(3, Math.max(0.5, Math.round(value * 100) / 100));
}

function formatFileSize(bytes) {
  const value = Number(bytes || 0);
  if (!value) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 ** 2)).toFixed(2)} MB`;
}

function BriefExpansionModal({
  snapshot,
  job,
  draft,
  error,
  onDraftChange,
  onSnapshotImageChange,
  onStart,
  onRestart,
  onApply,
  onCopy,
  onClose,
}) {
  const status = job?.status || "ready";
  const isRunning = ["queued", "running"].includes(status);
  const isDone = status === "done";
  const isFailed = status === "failed";
  const referenceImages = snapshot?.referenceImages ?? [];
  const sourceText = snapshot?.briefText?.trim() || "用户未填写作图重点，系统会根据产品图片文件名和模板信息自行整理。";
  const imageAnalysis = job?.imageAnalysis || "";

  return (
    <div className="modal-layer expansion-layer" role="dialog" aria-modal="true" aria-label="AI扩写作图重点">
      <section className="expansion-modal">
        <header className="modal-header">
          <div>
            <p className="eyebrow">输入作图重点 · AI扩写</p>
            <h2>把零散重点整理成完整作图需求</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="expansion-status-bar">
          <span className={`expansion-status status-${status}`}>
            {isRunning ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}
            {job?.message || "确认左侧快照后，点击开始扩写。"}
          </span>
          <small>本次扩写只使用打开弹层时的输入快照。</small>
        </div>

        <div className="expansion-grid">
          <section className="expansion-panel">
            <div className="expansion-panel-header">
              <p className="section-kicker">左侧快照</p>
              <strong>提交前内容</strong>
            </div>
            <div className="snapshot-meta">
              {snapshot?.productForm?.productName ? <span>产品：{snapshot.productForm.productName}</span> : null}
              {snapshot?.productForm?.targetPlatform ? <span>平台：{snapshot.productForm.targetPlatform}</span> : null}
              {snapshot?.productForm?.outputLanguage ? <span>语言：{snapshot.productForm.outputLanguage}</span> : null}
              {snapshot?.productForm?.imageAspectRatioProfileId ? <span>比例：{(fallbackImageAspectRatioProfiles.find((profile) => profile.id === snapshot.productForm.imageAspectRatioProfileId)?.summary || snapshot.productForm.imageAspectRatioProfileId).replaceAll(" ", "")}</span> : null}
              {snapshot?.productForm?.imageResolutionId ? <span>清晰度：{normalizeUiImageResolution(snapshot.productForm.imageResolutionId).toUpperCase()}</span> : null}
              <span>{referenceImages.length} 张产品图</span>
              {snapshot?.createdAt ? <span>{formatSnapshotTime(snapshot.createdAt)}</span> : null}
            </div>
            <div className="snapshot-image-grid">
              {referenceImages.map((image, index) => (
                <label className={image.useForExpansion ? "snapshot-image-card selected" : "snapshot-image-card"} key={image.id}>
                  <input
                    type="checkbox"
                    checked={Boolean(image.useForExpansion)}
                    disabled={isRunning}
                    onChange={(event) => onSnapshotImageChange(image.id, { useForExpansion: event.target.checked })}
                  />
                  <img src={image.previewUrl} alt={`${image.originalName} 预览`} />
                  <span>参考图{index + 1}</span>
                  <small>{image.role}</small>
                </label>
              ))}
            </div>
            <div className="vision-summary">
              <div className="vision-summary-title">
                <p className="section-kicker">产品图识别摘要</p>
                {isRunning && !imageAnalysis ? <Loader2 size={14} className="spin" /> : null}
              </div>
              {imageAnalysis ? (
                <pre>{imageAnalysis}</pre>
              ) : (
                <p>{isRunning ? "正在识别产品图特征..." : "点击“开始扩写”后，这里会显示产品图视觉识别摘要。"}</p>
              )}
            </div>
            <textarea value={sourceText} readOnly />
          </section>

          <section className="expansion-panel output-panel">
            <div className="expansion-panel-header">
              <p className="section-kicker">右侧输出</p>
              <strong>AI扩写结果</strong>
            </div>
            {isDone ? <ExpansionDiagnostics diagnostics={job?.diagnostics} /> : null}
            {isRunning ? (
              <div className="expansion-loading">
                <Loader2 size={28} className="spin" />
                <strong>正在扩写中</strong>
                <p>可以关闭这个窗口，后台会继续处理。</p>
              </div>
            ) : (
              <textarea
                value={draft}
                placeholder={isFailed ? "扩写失败，请重试。" : "点击“开始扩写”后，结果会显示在这里。"}
                onChange={(event) => onDraftChange(event.target.value)}
              />
            )}
            {error ? <p className="error-text">{error}</p> : null}
          </section>
        </div>

        <footer className="expansion-footer">
          <button className="secondary-button" type="button" onClick={onClose}>
            关闭
          </button>
          {isDone ? (
            <button className="secondary-button" type="button" onClick={onRestart}>
              <RotateCcw size={17} />
              重新准备
            </button>
          ) : null}
          <button className="secondary-button" type="button" disabled={!draft.trim()} onClick={onCopy}>
            <Copy size={17} />
            一键复制
          </button>
          {isDone ? (
            <button className="generate-button compact" type="button" disabled={!draft.trim()} onClick={onApply}>
              <CheckCircle2 size={18} />
              使用这版
            </button>
          ) : (
            <button className="generate-button compact" type="button" disabled={isRunning} onClick={onStart}>
              {isRunning ? <Loader2 size={18} className="spin" /> : <Sparkles size={18} />}
              {isFailed ? "重新扩写" : "开始扩写"}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function ExpansionDiagnostics({ diagnostics }) {
  if (!diagnostics) return null;

  const isModelResult = diagnostics.source === "model" && !diagnostics.usedFallback;
  const duration = Number(diagnostics.durationMs || 0);
  const durationText = duration > 0 ? `${Math.max(1, Math.round(duration / 1000))} 秒` : "--";
  const attempts = Number(diagnostics.attempts || 0);
  const title = isModelResult ? "模型扩写完成" : "已使用本地智能模板";
  const detail = isModelResult
    ? `${diagnostics.model || "文本模型"} · ${attempts || 1} 次尝试 · ${durationText}`
    : diagnostics.reasonMessage || "本次未获得可用的模型结果，可编辑后直接使用或重新扩写。";

  return (
    <div className={isModelResult ? "expansion-diagnostics model" : "expansion-diagnostics fallback"}>
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function ShowcasePanel({
  outputs,
  tasks,
  job,
  liveOutput,
  runState,
  refreshingOutputs,
  refreshingTasks,
  outputsMessage,
  tasksMessage,
  deletingProduct,
  examples,
  examplesMessage,
  onRefreshHistory,
  onDeleteRecord,
  onViewOutput,
  onImportPrompt,
  onApplyExample,
}) {
  const [mode, setMode] = useState("completed");
  const [selectedOutputId, setSelectedOutputId] = useState("");
  const [assetIndex, setAssetIndex] = useState(0);
  const [previewExample, setPreviewExample] = useState(null);
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [exampleBusyId, setExampleBusyId] = useState("");
  const [exampleError, setExampleError] = useState("");
  const portalMode = isPortalMode();
  const isBusy = ["receiving", "submitting", "queued", "running", "canceling"].includes(runState);
  const isDone = ["done", "partial"].includes(runState) && Boolean(job?.productName);
  const displayMode = isBusy ? "task" : mode === "completed" && !outputs.length ? "examples" : mode;

  useEffect(() => {
    if (outputs.length && !selectedOutputId) setSelectedOutputId(outputKey(outputs[0]));
    if (selectedOutputId && outputs.length && !outputs.some((output) => outputKey(output) === selectedOutputId)) {
      setSelectedOutputId(outputKey(outputs[0]));
    }
  }, [outputs, selectedOutputId]);

  useEffect(() => {
    if (isBusy) setMode("task");
    if (isDone) {
      setMode("completed");
      setSelectedOutputId(job.output?.id || job.outputId || job.outputFolderName || job.productName);
    }
  }, [isBusy, isDone, job?.productName, job?.outputId, job?.outputFolderName]);

  useEffect(() => {
    if (!job && mode === "task") setMode("completed");
  }, [job, mode]);

  const completedOutput =
    liveOutput && outputKey(liveOutput) === selectedOutputId
      ? liveOutput
      : outputs.find((output) => outputKey(output) === selectedOutputId);
  const completedAssets = useMemo(
    () => (completedOutput ? buildGalleryAssets(completedOutput) : []),
    [completedOutput]
  );
  const historyRecords = useMemo(() => buildHistoryRecords(tasks, outputs), [tasks, outputs]);
  const currentAsset = completedAssets[assetIndex] ?? completedAssets[0];

  useEffect(() => {
    setAssetIndex(0);
  }, [selectedOutputId, displayMode]);

  useEffect(() => {
    if (assetIndex >= completedAssets.length) setAssetIndex(0);
  }, [assetIndex, completedAssets.length]);

  function moveAsset(direction) {
    if (!completedAssets.length) return;
    setAssetIndex((current) => (current + direction + completedAssets.length) % completedAssets.length);
  }

  async function loadExampleDetail(exampleId) {
    setExampleError("");
    setExampleBusyId(exampleId);
    try {
      return await fetchJson(`/api/examples/${encodeURIComponent(exampleId)}`);
    } catch (detailError) {
      setExampleError(detailError.message);
      return null;
    } finally {
      setExampleBusyId("");
    }
  }

  async function handlePreviewExample(exampleId) {
    const detail = await loadExampleDetail(exampleId);
    if (detail) setPreviewExample(detail);
  }

  async function handleApplyExample(exampleId) {
    const detail = await loadExampleDetail(exampleId);
    if (detail) onApplyExample(detail);
  }

  const title =
    displayMode === "task"
      ? job?.productName || "当前任务生成中"
      : displayMode === "completed"
        ? outputLabel(completedOutput) || "已完成成品图"
        : "优秀案例库";

  return (
    <section className="preview-column showcase-column" aria-label="展示中心">
      <div className="preview-header showcase-header">
        <div>
          <p className="section-kicker">{displayMode === "task" ? "当前任务" : displayMode === "completed" ? (portalMode ? "我的作品" : "已完成") : "优秀案例"}</p>
          <h2>{title}</h2>
        </div>
        <div className="showcase-controls">
          {!isBusy ? (
            <div className="mode-switch" role="tablist" aria-label="展示内容切换">
              <button className={displayMode === "completed" ? "active" : ""} type="button" onClick={() => setMode("completed")}>
                {portalMode ? "我的作品" : "已完成"}
              </button>
              <button className={displayMode === "examples" ? "active" : ""} type="button" onClick={() => setMode("examples")}>
                优秀案例
              </button>
            </div>
          ) : (
            <div className="task-pill">
              <Loader2 size={15} className="spin" />
              {statusCopy[runState] || "生成中"}
            </div>
          )}

          {displayMode === "completed" ? (
            <select value={selectedOutputId} onChange={(event) => setSelectedOutputId(event.target.value)} aria-label={portalMode ? "选择我的作品" : "选择已完成商品"}>
              {outputs.map((output) => (
                <option key={outputKey(output)} value={outputKey(output)}>{outputLabel(output)}</option>
              ))}
            </select>
          ) : null}
        </div>
      </div>

      {displayMode === "task" ? (
        <TaskProgressBoard job={job} liveOutput={liveOutput} onViewOutput={onViewOutput} />
      ) : displayMode === "completed" ? (
        <ShowcaseStage
          asset={currentAsset}
          emptyText="暂无已完成成品图"
          meta={currentAsset ? `${currentAsset.typeLabel} · ${assetIndex + 1} / ${completedAssets.length}` : ""}
          onPrevious={() => moveAsset(-1)}
          onNext={() => moveAsset(1)}
          onPrimary={selectedOutputId ? () => onViewOutput(selectedOutputId) : undefined}
          primaryLabel="进入详情页"
        />
      ) : (
        <ExampleGallery
          examples={examples}
          message={examplesMessage || exampleError}
          busyId={exampleBusyId}
          onPreview={handlePreviewExample}
          onApply={handleApplyExample}
        />
      )}

      <HistoryRecordsPanel
        records={historyRecords}
        message={tasksMessage || outputsMessage}
        refreshing={refreshingOutputs || refreshingTasks}
        deletingProduct={deletingProduct}
        onRefresh={onRefreshHistory}
        onOpenAll={() => setHistoryModalOpen(true)}
        onViewOutput={onViewOutput}
        onImportPrompt={onImportPrompt}
        onDeleteRecord={onDeleteRecord}
      />

      {historyModalOpen ? (
        <HistoryRecordsModal
          records={historyRecords}
          message={tasksMessage || outputsMessage}
          refreshing={refreshingOutputs || refreshingTasks}
          deletingProduct={deletingProduct}
          onRefresh={onRefreshHistory}
          onViewOutput={onViewOutput}
          onImportPrompt={onImportPrompt}
          onDeleteRecord={onDeleteRecord}
          onClose={() => setHistoryModalOpen(false)}
        />
      ) : null}

      {previewExample ? (
        <ExamplePreviewModal
          example={previewExample}
          busy={exampleBusyId === previewExample.id}
          onClose={() => setPreviewExample(null)}
          onApply={() => handleApplyExample(previewExample.id)}
        />
      ) : null}
    </section>
  );
}

function ShowcaseStage({ asset, emptyText, meta, onPrevious, onNext, onPrimary, primaryLabel }) {
  if (!asset) {
    return (
      <div className="showcase-stage empty-showcase">
        <Images size={34} />
        <strong>{emptyText}</strong>
      </div>
    );
  }

  return (
    <div className="showcase-stage">
      <button className="stage-arrow left" type="button" onClick={onPrevious} aria-label="上一张">
        <ArrowLeft size={20} />
      </button>
      <div className="showcase-image-wrap">
        <AssetImage src={asset.url} alt={asset.label} loading="lazy" />
      </div>
      <button className="stage-arrow right" type="button" onClick={onNext} aria-label="下一张">
        <ArrowRight size={20} />
      </button>
      <div className="preview-caption showcase-caption">
        <Images size={18} />
        <span>{asset.label}</span>
        {meta ? <small>{meta}</small> : null}
        {onPrimary ? <button type="button" onClick={onPrimary}>{primaryLabel}</button> : null}
      </div>
    </div>
  );
}

function ExampleGallery({ examples, message, busyId, onPreview, onApply }) {
  if (!examples.length) {
    return (
      <section className="example-gallery empty-showcase">
        <Images size={34} />
        <strong>{message || "暂无优秀案例"}</strong>
      </section>
    );
  }

  return (
    <section className="example-gallery" aria-label="优秀案例列表">
      <div className="example-grid">
        {examples.map((example) => {
          const isBusy = busyId === example.id;
          return (
            <article className="example-card" key={example.id}>
              <div className="example-cover">
                {example.cover?.url ? <AssetImage src={example.cover.url} alt={example.title} loading="lazy" /> : null}
                <div className="example-overlay">
                  <button type="button" onClick={() => onPreview(example.id)} disabled={isBusy}>
                    {isBusy ? <Loader2 size={16} className="spin" /> : <Eye size={16} />}
                    预览
                  </button>
                  <button type="button" onClick={() => onApply(example.id)} disabled={isBusy}>
                    {isBusy ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
                    做同款
                  </button>
                </div>
                <span className="example-origin">原图 {example.counts?.original ?? 0}</span>
              </div>
              <div className="example-body">
                <div>
                  <p>{example.category}</p>
                  <h3>{example.title}</h3>
                </div>
                <small>{example.summary}</small>
                <div className="example-tags">
                  {(example.tags ?? []).slice(0, 4).map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {message ? <p className="completed-message">{message}</p> : null}
    </section>
  );
}

function ExamplePreviewModal({ example, busy, onClose, onApply }) {
  return (
    <div className="modal-layer preview-layer" role="dialog" aria-modal="true" aria-label="优秀案例预览">
      <section className="preview-modal example-modal">
        <header className="modal-header">
          <div>
            <p className="eyebrow">{example.category}</p>
            <h2>{example.title}</h2>
          </div>
          <div className="preview-tools">
            <button className="secondary-button compact-button" type="button" onClick={onApply} disabled={busy}>
              {busy ? <Loader2 size={17} className="spin" /> : <Sparkles size={17} />}
              做同款
            </button>
            <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="example-modal-body">
          <section className="example-detail-panel">
            <p className="section-kicker">原图</p>
            <div className="example-image-list original-list">
              {(example.originalImages ?? []).map((image) => (
                <figure key={image.url}>
                  <AssetImage src={image.url} alt={image.name} loading="lazy" />
                  <figcaption>{image.name}</figcaption>
                </figure>
              ))}
            </div>
          </section>

          <section className="example-detail-panel">
            <p className="section-kicker">成品图</p>
            <div className="example-image-list result-list">
              {(example.resultImages ?? []).map((image) => (
                <figure key={image.url}>
                  <AssetImage src={image.url} alt={image.name} loading="lazy" />
                  <figcaption>{image.kind} · {image.name}</figcaption>
                </figure>
              ))}
            </div>
          </section>

          <section className="example-detail-panel template-panel">
            <p className="section-kicker">需求分析</p>
            <p>{example.summary}</p>
            {example.style ? <p>风格参考：{example.style}</p> : null}
            <pre>{example.templateText || "暂无需求模板"}</pre>
          </section>
        </div>
      </section>
    </div>
  );
}

function TaskProgressBoard({ job, liveOutput, onViewOutput }) {
  const main = liveOutput?.files?.main ?? [];
  const detail = liveOutput?.files?.detail ?? [];
  const progress = job?.progress || null;
  const { main: mainImageCount, detail: detailImageCount } = taskImageCounts(job);
  const mainSlots = Array.from({ length: mainImageCount }, (_, index) => ({
    key: `main-${index}`,
    label: `主图 ${index + 1}`,
    file: main[index],
  }));
  const detailSlots = Array.from({ length: detailImageCount }, (_, index) => ({
    key: `detail-${index}`,
    label: `详情页 ${index + 1}`,
    file: detail[index],
  }));
  const slots = [...mainSlots, ...detailSlots];
  const completed = Math.max(slots.filter((slot) => slot.file).length, progress?.completed || 0);
  const isComplete = completed >= slots.length || liveOutput?.status === "已完成";
  const taskStatus = job?.status || "";
  const canViewOutput = Boolean(job?.output?.id || job?.outputId || job?.outputFolderName || job?.productName)
    && (isComplete || ["done", "partial"].includes(taskStatus));
  const isTerminalFailure = ["failed", "cancelled", "interrupted"].includes(taskStatus);

  return (
    <section className="task-board">
      <div className="task-board-header">
        <div>
          <p className="section-kicker">生成进度</p>
          <h3>{completed} / {slots.length} 张</h3>
          <p className="task-progress-message">{progress?.message || job?.message || "正在准备生成任务。"}</p>
        </div>
        {canViewOutput ? (
          <button className="secondary-button" type="button" onClick={() => onViewOutput(job.output?.id || job.outputId || job.outputFolderName || job.productName)}>
            <Eye size={17} />
            进入详情页
          </button>
        ) : isTerminalFailure ? (
          <span className="task-pill">{statusCopy[taskStatus] || "任务已停止"}</span>
        ) : (
          <span className="task-pill"><Loader2 size={15} className="spin" />生成中</span>
        )}
      </div>
      {progress ? (
        <div className="task-progress-meta" aria-live="polite">
          <span>主图 {Math.min(mainImageCount, progress.mainCompleted || 0)}/{mainImageCount}</span>
          <span>详情页 {Math.min(detailImageCount, progress.detailCompleted || 0)}/{detailImageCount}</span>
          {progress.firstPreviewElapsedMs ? <span>首图 {Math.max(1, Math.round(progress.firstPreviewElapsedMs / 1000))} 秒可看</span> : null}
          {progress.concurrency ? <span>并发 {progress.concurrency}</span> : null}
          {progress.backpressureCount ? <span>已自动限流恢复 {progress.backpressureCount} 次</span> : null}
          {progress.qualityRetryTotal ? <span>质检返工 {progress.qualityRetryCompleted || 0}/{progress.qualityRetryTotal}</span> : null}
        </div>
      ) : null}
      <div className="task-slot-grid">
        {slots.map((slot, index) => (
          <article className={slot.file ? "task-slot done" : "task-slot"} key={slot.key}>
            {slot.file ? (
              <AssetImage src={slot.file.url} alt={slot.file.name} loading="lazy" />
            ) : (
              <div className="slot-placeholder">
                {index === completed ? <Loader2 size={18} className="spin" /> : null}
              </div>
            )}
            <span>{slot.file ? stripImageExtension(slot.file.name) : slot.label}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

function GalleryPage({ output, onBack, onRefresh, onDelete, portalUser, onPortalLogout }) {
  const [tab, setTab] = useState("all");
  const [deleting, setDeleting] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [selectedDownloadIds, setSelectedDownloadIds] = useState(new Set());
  const [downloadError, setDownloadError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [previewAssetId, setPreviewAssetId] = useState(null);
  const allAssets = useMemo(() => (output ? buildGalleryAssets(output) : []), [output]);
  const visibleAssets = useMemo(
    () => (tab === "all" ? allAssets : allAssets.filter((asset) => asset.group === tab)),
    [allAssets, tab]
  );
  const previewIndex = allAssets.findIndex((asset) => asset.id === previewAssetId);
  const previewAsset = previewIndex >= 0 ? allAssets[previewIndex] : null;

  useEffect(() => {
    if (!output) return;
    setSelectedDownloadIds(new Set(buildGalleryAssets(output).map((asset) => asset.id)));
    setPreviewAssetId(null);
    setDownloadError("");
  }, [output?.id]);

  async function handleDeleteCurrent() {
    const currentOutputId = outputKey(output);
    if (!currentOutputId) return;
    const ok = window.confirm(`确定删除「${outputLabel(output)}」吗？这会同时删除待作图素材文件夹和已完成作品，历史提示词仍会保留。`);
    if (!ok) return;
    setDeleting(true);
    try {
      await onDelete(currentOutputId);
    } finally {
      setDeleting(false);
    }
  }

  function updateSelected(nextIds) {
    setSelectedDownloadIds(new Set(nextIds));
    setDownloadError("");
  }

  function toggleSelected(id) {
    const next = new Set(selectedDownloadIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    updateSelected(next);
  }

  function movePreview(direction) {
    if (!allAssets.length || previewIndex < 0) return;
    const nextIndex = (previewIndex + direction + allAssets.length) % allAssets.length;
    setPreviewAssetId(allAssets[nextIndex].id);
  }

  async function handleDownloadSelected() {
    const currentOutputId = outputKey(output);
    if (!currentOutputId || !selectedDownloadIds.size) {
      setDownloadError("请至少选择一张图片。");
      return;
    }
    setDownloading(true);
    setDownloadError("");
    try {
      const headers = new Headers({ "Content-Type": "application/json" });
      const accessToken = readActiveAccessToken();
      if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
      const response = await fetch(workbenchApiUrl(`/api/outputs/${encodeURIComponent(currentOutputId)}/download`), {
        method: "POST",
        headers,
        body: JSON.stringify({ items: [...selectedDownloadIds] }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `下载失败：${response.status}`);
      }
      const blob = await response.blob();
      downloadBlob(blob, `${output.productName || "成品图"}-选中成品图.zip`);
      setDownloadOpen(false);
    } catch (error) {
      setDownloadError(error.message);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="workspace gallery-workspace">
        <header className="gallery-header">
          <button className="ghost-button" type="button" onClick={onBack}>
            <ArrowLeft size={18} />
            返回工作台
          </button>
          <div>
            <p className="eyebrow">已完成成品图</p>
            <h1>{output?.productName || "加载中"}</h1>
            {output?.submittedAtLocal ? <small className="gallery-time">提交时间：{output.submittedAtLocal}</small> : null}
          </div>
          <div className="gallery-actions">
            {portalUser ? <PortalUserBar user={portalUser} onLogout={onPortalLogout} /> : null}
            <button className="ghost-button" type="button" onClick={onRefresh}>
              <RefreshCw size={18} />
              刷新
            </button>
            <button className="ghost-button" type="button" disabled={!output} onClick={() => setDownloadOpen(true)}>
              <Download size={18} />
              选择下载
            </button>
            <button className="danger-button" type="button" disabled={!output || deleting} onClick={handleDeleteCurrent}>
              {deleting ? <Loader2 size={18} className="spin" /> : <Trash2 size={18} />}
              删除
            </button>
          </div>
        </header>

        {!output ? (
          <div className="empty-state">
            <Loader2 className="spin" />
            正在读取成品图...
          </div>
        ) : (
          <>
            <div className="gallery-tabs">
              <button className={tab === "all" ? "active" : ""} type="button" onClick={() => setTab("all")}>
                全部 {allAssets.length}
              </button>
              <button className={tab === "main" ? "active" : ""} type="button" onClick={() => setTab("main")}>
                主图 {output.files.main.length}
              </button>
              <button className={tab === "detail" ? "active" : ""} type="button" onClick={() => setTab("detail")}>
                详情页 {output.files.detail.length}
              </button>
              <button className={tab === "overview" ? "active" : ""} type="button" onClick={() => setTab("overview")}>
                拼接图 {allAssets.filter((asset) => asset.group === "overview").length}
              </button>
              {output.files.packageZip ? (
                <a href={output.files.packageZip} download>
                  <Download size={16} />
                  完整包
                </a>
              ) : null}
            </div>

            <div className="gallery-grid">
              {visibleAssets.map((asset) => (
                <article className={`image-card ${asset.layout}`} key={asset.id}>
                  <button className="image-preview-trigger" type="button" onClick={() => setPreviewAssetId(asset.id)}>
                    <AssetImage src={asset.url} alt={asset.label} loading="lazy" />
                  </button>
                  <div className="image-card-body">
                    <div>
                      <span>{asset.label}</span>
                      <small>{asset.typeLabel}</small>
                    </div>
                    <div className="image-card-actions">
                      <button type="button" onClick={() => setPreviewAssetId(asset.id)}>
                        <Eye size={15} />
                        预览
                      </button>
                      <AssetDownloadLink src={asset.url} filename={asset.filename}>
                        <Download size={15} />
                        下载
                      </AssetDownloadLink>
                    </div>
                  </div>
                </article>
              ))}
            </div>

            {downloadOpen ? (
              <DownloadPanel
                assets={allAssets}
                selectedIds={selectedDownloadIds}
                downloading={downloading}
                error={downloadError}
                onClose={() => setDownloadOpen(false)}
                onToggle={toggleSelected}
                onSelect={(filter) => {
                  if (filter === "all") updateSelected(allAssets.map((asset) => asset.id));
                  else if (filter === "none") updateSelected([]);
                  else updateSelected(allAssets.filter((asset) => asset.group === filter).map((asset) => asset.id));
                }}
                onDownload={handleDownloadSelected}
              />
            ) : null}

            {previewAsset ? (
              <ImagePreviewModal
                asset={previewAsset}
                index={previewIndex}
                total={allAssets.length}
                onClose={() => setPreviewAssetId(null)}
                onPrevious={() => movePreview(-1)}
                onNext={() => movePreview(1)}
              />
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}

function buildGalleryAssets(output) {
  const mainCount = Number(output.mainImageCount) || (output.files.main ?? []).length;
  const detailCount = Number(output.detailImageCount) || (output.files.detail ?? []).length;
  const main = (output.files.main ?? []).map((file, index) => ({
    id: `main/${file.name}`,
    group: "main",
    typeLabel: "主图",
    label: stripImageExtension(file.name) || `主图 ${index + 1}`,
    filename: file.name,
    url: portalMediaUrl(file.url),
    layout: "square",
  }));
  const detail = (output.files.detail ?? []).map((file, index) => ({
    id: `detail/${file.name}`,
    group: "detail",
    typeLabel: "详情页",
    label: stripImageExtension(file.name) || `详情页 ${index + 1}`,
    filename: file.name,
    url: portalMediaUrl(file.url),
    layout: "tall",
  }));
  const overview = [
    output.files.mainOverview && {
      id: "overview/main",
      group: "overview",
      typeLabel: "拼接图",
      label: `${mainCount}张主图总览`,
      filename: `${mainCount}张主图总览.jpg`,
      url: portalMediaUrl(output.files.mainOverview),
      layout: "overview",
    },
    output.files.detailOverview && {
      id: "overview/detail",
      group: "overview",
      typeLabel: "拼接图",
      label: `${detailCount}张详情页总览`,
      filename: `${detailCount}张详情页总览.jpg`,
      url: portalMediaUrl(output.files.detailOverview),
      layout: "overview",
    },
    output.files.longDetail && {
      id: "overview/long",
      group: "overview",
      typeLabel: "拼接长图",
      label: "详情页完整长图",
      filename: "详情页完整长图.jpg",
      url: portalMediaUrl(output.files.longDetail),
      layout: "long",
    },
  ].filter(Boolean);
  return [...main, ...detail, ...overview];
}

function DownloadPanel({ assets, selectedIds, downloading, error, onClose, onToggle, onSelect, onDownload }) {
  const selectedCount = selectedIds.size;
  const groups = [
    { id: "main", title: "主图", assets: assets.filter((asset) => asset.group === "main") },
    { id: "detail", title: "详情页", assets: assets.filter((asset) => asset.group === "detail") },
    { id: "overview", title: "拼接图", assets: assets.filter((asset) => asset.group === "overview") },
  ];

  return (
    <div className="modal-layer" role="dialog" aria-modal="true" aria-label="选择下载图片">
      <section className="download-panel">
        <header className="modal-header">
          <div>
            <p className="eyebrow">选择下载</p>
            <h2>勾选要打包的成品图</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="download-shortcuts">
          <button type="button" onClick={() => onSelect("all")}>全部</button>
          <button type="button" onClick={() => onSelect("main")}>只选主图</button>
          <button type="button" onClick={() => onSelect("detail")}>只选详情页</button>
          <button type="button" onClick={() => onSelect("overview")}>只选拼接图</button>
          <button type="button" onClick={() => onSelect("none")}>清空</button>
        </div>

        <div className="download-list">
          {groups.map((group) => (
            <section className="download-group" key={group.id}>
              <h3>{group.title} <span>{group.assets.length}</span></h3>
              {group.assets.map((asset) => (
                <label className="download-option" key={asset.id}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(asset.id)}
                    onChange={() => onToggle(asset.id)}
                  />
                  <AssetImage src={asset.url} alt="" loading="lazy" />
                  <span>{asset.label}</span>
                  <small>{asset.typeLabel}</small>
                </label>
              ))}
            </section>
          ))}
        </div>

        {error ? <p className="error-text">{error}</p> : null}
        <footer className="download-footer">
          <button className="secondary-button" type="button" onClick={onClose}>取消</button>
          <button className="generate-button compact" type="button" disabled={!selectedCount || downloading} onClick={onDownload}>
            {downloading ? <Loader2 size={18} className="spin" /> : <Download size={18} />}
            下载已选 {selectedCount} 张
          </button>
        </footer>
      </section>
    </div>
  );
}

function ImagePreviewModal({ asset, index, total, onClose, onPrevious, onNext }) {
  return (
    <div className="modal-layer preview-layer" role="dialog" aria-modal="true" aria-label="预览成品图">
      <section className="preview-modal">
        <header className="modal-header">
          <div>
            <p className="eyebrow">{asset.typeLabel} · {index + 1} / {total}</p>
            <h2>{asset.label}</h2>
          </div>
          <div className="preview-tools">
            <AssetDownloadLink src={asset.url} filename={asset.filename}>
              <Download size={17} />
              下载当前图
            </AssetDownloadLink>
            <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="preview-canvas">
          <button className="preview-nav left" type="button" onClick={onPrevious} aria-label="上一张">
            <ArrowLeft size={22} />
          </button>
          <AssetImage src={asset.url} alt={asset.label} />
          <button className="preview-nav right" type="button" onClick={onNext} aria-label="下一张">
            <ArrowRight size={22} />
          </button>
        </div>
      </section>
    </div>
  );
}

const transparentImage = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

function AssetImage({ src, alt, ...props }) {
  const portalMode = isPortalMode();
  const [blobUrl, setBlobUrl] = useState(portalMode ? "" : String(src || ""));
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    const rawUrl = String(src || "");
    if (!portalMode) {
      setBlobUrl(rawUrl);
      setLoadError("");
      return undefined;
    }

    const controller = new AbortController();
    let active = true;
    let currentBlobUrl = "";
    setBlobUrl("");
    setLoadError("");

    fetchPortalAsset(rawUrl, controller.signal)
      .then((response) => response.blob())
      .then((blob) => {
        if (!blob.type.startsWith("image/")) throw new Error("成品接口未返回图片数据。");
        currentBlobUrl = URL.createObjectURL(blob);
        if (active) setBlobUrl(currentBlobUrl);
      })
      .catch((error) => {
        if (active && error?.name !== "AbortError") {
          setLoadError("图片加载失败，请点击刷新后重试。");
        }
      });

    return () => {
      active = false;
      controller.abort();
      if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
    };
  }, [portalMode, src]);

  return (
    <img
      {...props}
      src={portalMode ? (blobUrl || transparentImage) : String(src || transparentImage)}
      alt={alt}
      aria-busy={portalMode && !blobUrl ? "true" : undefined}
      title={loadError || props.title}
    />
  );
}

function AssetDownloadLink({ src, filename, children }) {
  const portalMode = isPortalMode();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");

  const download = async (event) => {
    if (!portalMode) return;
    event.preventDefault();
    if (downloading) return;
    setDownloading(true);
    setError("");
    try {
      const response = await fetchPortalAsset(src);
      downloadBlob(await response.blob(), filename);
    } catch {
      setError("下载失败，请刷新页面后重试。");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <a
      href={src}
      download={filename}
      onClick={download}
      aria-busy={downloading || undefined}
      title={error || (downloading ? "正在准备下载…" : undefined)}
    >
      {children}
    </a>
  );
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function stripImageExtension(name) {
  return String(name || "").replace(/\.(png|jpe?g|webp|gif)$/i, "");
}

function outputKey(output) {
  return String(output?.id || output?.folderName || output?.outputId || output?.productName || "");
}

function outputLabel(output) {
  const name = String(output?.productName || output?.displayName || stripTaskFolderPrefix(outputKey(output)) || "未命名任务");
  const time = output?.submittedAtLocal || "";
  return time ? `${name} · ${time.slice(5)}` : name;
}

function buildHistoryRecords(tasks = [], outputs = []) {
  const outputMap = new Map(outputs.map((output) => [outputKey(output), output]));
  const usedOutputKeys = new Set();
  const records = [];

  for (const task of tasks) {
    const matchedOutput = findOutputForTask(task, outputMap, outputs);
    const matchedOutputKey = matchedOutput ? outputKey(matchedOutput) : "";
    if (matchedOutputKey) usedOutputKeys.add(matchedOutputKey);
    records.push(createHistoryRecord({ task, output: matchedOutput }));
  }

  for (const output of outputs) {
    const key = outputKey(output);
    if (usedOutputKeys.has(key)) continue;
    records.push(createHistoryRecord({ output }));
  }

  return records
    .filter((record) => record.productName || record.outputId || record.task)
    .sort((a, b) => String(b.sortTime || "").localeCompare(String(a.sortTime || "")));
}

function findOutputForTask(task, outputMap, outputs) {
  const candidates = [
    task?.outputId,
    task?.outputFolderName,
    task?.output?.id,
    task?.outputProductName,
    task?.productName,
  ].map((item) => String(item || "")).filter(Boolean);
  for (const candidate of candidates) {
    const output = outputMap.get(candidate);
    if (output) return output;
  }
  const taskName = stripTaskFolderPrefix(task?.productName);
  const nameMatches = outputs.filter((output) => stripTaskFolderPrefix(output?.productName) === taskName);
  return nameMatches.length === 1 ? nameMatches[0] : null;
}

function createHistoryRecord({ task = null, output = null }) {
  const outputId = output ? outputKey(output) : String(task?.outputId || task?.outputFolderName || "");
  const productName = String(
    task?.productName ||
      output?.productName ||
      output?.displayName ||
      stripTaskFolderPrefix(outputId) ||
      "未命名任务"
  );
  const sortTime = task?.updatedAt || output?.updatedAt || task?.createdAt || "";
  const timeLabel =
    task?.submittedAtLocal ||
    output?.submittedAtLocal ||
    formatSnapshotTime(task?.createdAt || output?.updatedAt);
  const status = historyStatus(task, output);
  const latestMessage = task?.latestEvent?.message || task?.message || output?.status || "暂无任务事件";
  return {
    id: task?.id ? `task-${task.id}` : `output-${outputId || productName}`,
    task,
    output,
    outputId: output ? outputId : "",
    deleteKey: task?.id ? `task-${task.id}` : outputId || `output-${productName}`,
    productName,
    status,
    statusLabel: historyStatusLabel(status, output),
    message: latestMessage,
    sortTime,
    timeLabel,
    referenceCount: task?.referenceCount || 0,
    promptAvailable: Boolean(task?.promptAvailable),
    promptLength: task?.promptLength || 0,
    targetPlatform: task?.targetPlatform || output?.targetPlatform ? normalizeUiPlatform(task?.targetPlatform || output?.targetPlatform) : "",
    outputLanguage: task?.outputLanguage || output?.outputLanguage ? normalizeUiLanguage(task?.outputLanguage || output?.outputLanguage) : "",
    imageResolutionId: task?.imageResolutionId || output?.imageResolutionId || "",
    imageResolutionLabel: task?.imageResolutionLabel || output?.imageResolutionLabel || "",
    generationRuleName: task?.generationRuleName || output?.generationRuleName || "",
    briefDiagnostic: formatBriefDiagnostic(task?.briefDiagnostics, task?.briefFallbackReason),
  };
}

function formatBriefDiagnostic(diagnostics, fallbackReason) {
  if (!diagnostics || typeof diagnostics !== "object") return "";
  if (diagnostics.usedFallback) {
    const reason = String(diagnostics.reasonMessage || fallbackReason || "模型结果不可用").trim();
    return `扩写：本地智能模板 · ${reason}`;
  }
  if (diagnostics.source === "model") {
    const milliseconds = Number(diagnostics.durationMs || 0);
    const duration = milliseconds > 0 ? ` · ${Math.max(1, Math.round(milliseconds / 1000))} 秒` : "";
    return `扩写：模型完成${duration}`;
  }
  if (diagnostics.source === "user-confirmed") return "扩写：使用用户确认的提示词";
  return "";
}

function historyStatus(task, output) {
  if (task?.filesDeletedAt && !output) return "deleted";
  if (["receiving", "submitting", "queued", "running", "canceling"].includes(task?.status)) return task.status;
  if (["failed", "cancelled", "interrupted"].includes(task?.status)) return task.status;
  const outputStatus = String(output?.status || task?.output?.status || "");
  if (outputStatus === "部分失败") return "partial";
  if (outputStatus === "已完成") return "done";
  if (task?.status === "done") return "done";
  return task?.status || "unknown";
}

function historyStatusLabel(status, output) {
  if (status === "partial") return "部分失败";
  if (status === "deleted") return "已删除";
  if (status === "unknown") return output?.status || "未知";
  return statusCopy[status] || status;
}

function historyStatusBucket(status) {
  if (["receiving", "submitting", "queued", "running", "canceling"].includes(status)) return "active";
  if (status === "done") return "done";
  if (status === "partial") return "partial";
  if (["failed", "cancelled", "interrupted"].includes(status)) return "failed";
  if (status === "deleted") return "deleted";
  return "failed";
}

function isProblemHistoryStatus(status) {
  return ["failed", "cancelled", "interrupted", "partial", "deleted", "unknown"].includes(status);
}

function historyRecordSearchText(record) {
  return [
    record.productName,
    record.statusLabel,
    record.message,
    record.timeLabel,
    record.targetPlatform,
    record.outputLanguage,
    record.generationRuleName,
    record.briefDiagnostic,
  ].filter(Boolean).join(" ").toLowerCase();
}

function stripTaskFolderPrefix(value) {
  return String(value || "").replace(/^\d{8}-\d{6}-[a-f0-9]{6}_/i, "");
}

function formatSnapshotTime(value) {
  const raw = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(raw)) return raw.slice(5);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function buildSameStyleBrief(example, currentBrief) {
  const userInput = currentBrief.trim();
  const sanitizedTemplate = sanitizeCaseTemplate(example.templateText || "");
  const tags = (example.tags ?? []).join("、") || "多场景卖点";
  return [
    `# 做同款参考：${example.title}`,
    "",
    "本次用户重点（优先级最高）：",
    userInput || "请结合本次上传的产品图自行判断产品名称、类目、人群和核心卖点。",
    "",
    "做同款目标：",
    `参考优秀案例「${example.title}」的结构、场景拆分、卖点表达和画面节奏，但必须以本次上传的产品为主体，不复制案例产品。`,
    `案例标签：${tags}`,
    example.style ? `案例风格参考：${example.style}` : "",
    "",
    "本次生成硬要求：",
    "1. 保持本次上传产品的主体特征不变，颜色、结构、比例、材质识别点要稳定。",
    "2. 每张图片都是独立场景、独立卖点，允许加入人物、手部、道具、环境元素来证明卖点。",
    "3. 辅助元素必须服务卖点，不能抢走产品主体；不要只把同一个产品换背景。",
    "4. 可见文案只写消费者能看懂的卖点，不写“核心主张、用户顾虑、场景代入”等内部词。",
    "5. 不虚构具体数值、认证、品牌授权、价格、销量、医疗功效或绝对化承诺。",
    "",
    "参考案例需求结构（只学习写法，不作为本次产品参数）：",
    sanitizedTemplate || "暂无案例模板。",
  ].filter(Boolean).join("\n");
}

function sanitizeCaseTemplate(templateText) {
  return String(templateText || "")
    .replace(/^(\s*)产品名称\s*[：:]/gm, "$1案例产品名（仅参考）：")
    .replace(/^(\s*)商品名称\s*[：:]/gm, "$1案例商品名（仅参考）：")
    .replace(/^(\s*)产品名称\s*$/gm, "$1案例产品名（仅参考）")
    .replace(/^(\s*)商品名称\s*$/gm, "$1案例商品名（仅参考）")
    .trim();
}

function PortalLoading() {
  return (
    <main className="portal-access-shell">
      <section className="portal-access-card portal-loading-card">
        <Loader2 className="spin" size={28} />
        <strong>正在检查本次登录状态…</strong>
      </section>
    </main>
  );
}

function PortalAccessPage({ onAuthenticated }) {
  const [mode, setMode] = useState("login");
  const [captcha, setCaptcha] = useState({ enabled: false, uuid: "", img: "" });
  const [form, setForm] = useState({ username: "", nickName: "", password: "", confirmPassword: "", code: "" });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const refreshCaptcha = async () => {
    try {
      const response = await fetch("/captchaImage", { cache: "no-store" });
      const data = await response.json();
      setCaptcha({
        enabled: Boolean(data.captchaEnabled),
        uuid: data.uuid || "",
        img: captchaImageSource(data.img),
      });
    } catch {
      setError("验证码服务暂时不可用，请确认本机服务已启动。");
    }
  };

  useEffect(() => {
    refreshCaptcha();
  }, []);

  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const switchMode = (nextMode) => {
    setMode(nextMode);
    setMessage("");
    setError("");
    setForm((current) => ({ ...current, code: "", confirmPassword: nextMode === "login" ? "" : current.confirmPassword }));
    refreshCaptcha();
  };

  const submit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setMessage("");
    setError("");
    try {
      if (mode === "register") {
        await portalAuthJson("/portal-auth/register", {
          method: "POST",
          body: JSON.stringify({ ...form, uuid: captcha.uuid }),
        });
        setMessage("账号已创建。请使用刚设置的用户名和密码登录。");
        setMode("login");
        setForm((current) => ({ ...current, password: "", confirmPassword: "", code: "" }));
        await refreshCaptcha();
        return;
      }
      const response = await portalAuthJson("/portal-auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: form.username,
          password: form.password,
          code: form.code,
          uuid: captcha.uuid,
        }),
      });
      const token = response.token || "";
      if (!token) throw new Error("登录服务未返回有效会话，请重试。");
      writePortalAccessToken(token);
      onAuthenticated(response.user ?? response.data ?? null);
    } catch (requestError) {
      setError(requestError.message || "操作未完成，请重试。");
      setForm((current) => ({ ...current, code: "" }));
      await refreshCaptcha();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="portal-access-shell">
      <section className="portal-access-card">
        <div className="portal-access-brand">
          <div className="brand-mark"><Sparkles size={22} strokeWidth={2.4} /></div>
          <div>
            <p className="eyebrow">自动化电商图</p>
            <h1>用户作图门户</h1>
          </div>
        </div>
        <p className="portal-access-copy">注册后可创建作图任务、查看自己的作品，并浏览项目精选案例。其他账号的任务和素材不会显示给你。</p>
        <div className="portal-mode-switch" role="tablist" aria-label="登录或注册">
          <button className={mode === "login" ? "active" : ""} type="button" onClick={() => switchMode("login")}>登录</button>
          <button className={mode === "register" ? "active" : ""} type="button" onClick={() => switchMode("register")}>注册账号</button>
        </div>
        <form className="portal-access-form" onSubmit={submit}>
          <label>
            <span>用户名</span>
            <input value={form.username} autoComplete="username" placeholder="4 至 20 位字母、数字或下划线" onChange={(event) => update("username", event.target.value)} required />
          </label>
          {mode === "register" ? (
            <label>
              <span>显示昵称</span>
              <input value={form.nickName} autoComplete="nickname" placeholder="用于工作台右上角显示" onChange={(event) => update("nickName", event.target.value)} required />
            </label>
          ) : null}
          <label>
            <span>密码</span>
            <input type="password" value={form.password} autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder="6 至 32 位" onChange={(event) => update("password", event.target.value)} required />
          </label>
          {mode === "register" ? (
            <label>
              <span>确认密码</span>
              <input type="password" value={form.confirmPassword} autoComplete="new-password" placeholder="再次输入密码" onChange={(event) => update("confirmPassword", event.target.value)} required />
            </label>
          ) : null}
          {captcha.enabled ? (
            <label className="portal-captcha-field">
              <span>验证码</span>
              <div>
                <input value={form.code} autoComplete="off" placeholder="输入图片中的字符" onChange={(event) => update("code", event.target.value)} required />
                <button type="button" className="captcha-image-button" onClick={refreshCaptcha} title="点击更换验证码">
                  {captcha.img ? <img src={captcha.img} alt="验证码，点击更换" /> : "换一张"}
                </button>
              </div>
            </label>
          ) : null}
          {error ? <p className="error-text">{error}</p> : null}
          {message ? <p className="portal-access-message">{message}</p> : null}
          <button className="generate-button portal-submit" type="submit" disabled={submitting}>
            {submitting ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
            {submitting ? "正在处理" : mode === "login" ? "进入作图工作台" : "创建账号"}
          </button>
        </form>
        <p className="portal-access-note">这是本机内测账号体系，不提供短信、邮箱或密码找回。请妥善保存你的密码。</p>
      </section>
    </main>
  );
}

function PortalUserBar({ user, onLogout }) {
  if (!user) return null;
  return (
    <div className="portal-user-bar">
      <span title={user.username}>{user.nickName || user.username}</span>
      <button type="button" onClick={onLogout}>退出</button>
    </div>
  );
}

function Header({ currentStatus, portalUser, onPortalLogout }) {
  return (
    <header className="topbar">
      <div className="brand-mark">
        <Sparkles size={22} strokeWidth={2.4} />
      </div>
      <div>
        <p className="eyebrow">自动化电商图</p>
        <h1>本地商品图工作台</h1>
      </div>
      <div className="header-actions">
        {portalUser ? <PortalUserBar user={portalUser} onLogout={onPortalLogout} /> : null}
        <div className={`status-pill status-${currentStatus}`}>
          {["receiving", "submitting", "queued", "running", "canceling"].includes(currentStatus) ? <Loader2 size={16} className="spin" /> : <CheckCircle2 size={16} />}
          {statusCopy[currentStatus] || currentStatus}
        </div>
      </div>
    </header>
  );
}

function useHashRoute() {
  const parse = () => {
    const hash = window.location.hash.replace(/^#/, "");
    if (hash.startsWith("/outputs/")) {
      return { page: "output", outputId: decodeURIComponent(hash.replace("/outputs/", "")) };
    }
    return { page: "home" };
  };
  const [route, setRouteState] = useState(parse);
  useEffect(() => {
    const listener = () => setRouteState(parse());
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, []);
  const setRoute = (next) => {
    if (next.page === "output") window.location.hash = `/outputs/${encodeURIComponent(next.outputId)}`;
    else window.location.hash = "/";
  };
  return [route, setRoute];
}

function normalizeUiPlatform(value) {
  const clean = String(value || "").trim();
  if (/amazon|亚马逊/i.test(clean)) return "Amazon";
  if (/淘宝|天猫|tmall|taobao/i.test(clean)) return "淘宝/天猫";
  if (/国内|通用/i.test(clean)) return "国内通用";
  return platformOptions.some((option) => option.value === clean) ? clean : defaultProductForm.targetPlatform;
}

function normalizeUiLanguage(value) {
  const clean = String(value || "").trim();
  if (/english|英文|英语/i.test(clean)) return "English";
  if (/中文|简体|chinese|zh/i.test(clean)) return "简体中文";
  return languageOptions.some((option) => option.value === clean) ? clean : defaultProductForm.outputLanguage;
}

function normalizeUiImageResolution(value) {
  const clean = String(value || "").trim().toLowerCase();
  return fallbackImageResolutionProfiles.some((option) => option.id === clean) ? clean : defaultImageResolutionId;
}

async function fetchJson(url, options) {
  let response;
  const requestOptions = { ...(options || {}) };
  const headers = new Headers(requestOptions.headers);
  const accessToken = readActiveAccessToken();
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  requestOptions.headers = headers;
  try {
    response = await fetch(workbenchApiUrl(url), requestOptions);
  } catch (error) {
    const networkError = new Error("本地作图服务未连接。请重新启动项目后再试。", { cause: error });
    networkError.statusCode = 0;
    throw networkError;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (isPortalMode() && response.status === 401) {
      clearPortalAccessToken();
      window.dispatchEvent(new Event("bge-portal-session-expired"));
    }
    const apiError = new Error(data.error || data.msg || `请求失败：${response.status}`);
    apiError.statusCode = response.status;
    apiError.code = data.code || "";
    apiError.activeJobId = data.activeJobId || "";
    apiError.activePhase = data.activePhase || "";
    throw apiError;
  }
  return data;
}

const internalAccessTokenKey = "bge-local-web-access-token";
const portalAccessTokenKey = "bge-portal-access-token";

function isPortalMode() {
  return typeof window !== "undefined" && window.location.pathname.startsWith("/portal");
}

function workbenchApiUrl(url) {
  return isPortalMode() ? `/portal-api${url}` : url;
}

function portalMediaUrl(url) {
  const value = String(url || "");
  if (!isPortalMode()) return value;
  if (value.startsWith("/portal-api/outputs/")) {
    return value.replace("/portal-api/outputs/", "/portal-media/o/");
  }
  if (value.startsWith("/portal-api/example-assets/")) {
    return value.replace("/portal-api/example-assets/", "/portal-media/e/");
  }
  return value;
}

async function fetchPortalAsset(url, signal) {
  const target = portalMediaUrl(url);
  if (!target) throw new Error("没有可读取的图片地址。");
  const headers = new Headers();
  const token = readActiveAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(target, {
    headers,
    signal,
    cache: "no-store",
    credentials: "same-origin",
  });
  const mediaType = String(response.headers.get("content-type") || "").split(";", 1)[0].toLowerCase();
  if (!response.ok || !mediaType.startsWith("image/")) {
    throw new Error("成品图片请求失败。");
  }
  return response;
}

function readActiveAccessToken() {
  return isPortalMode() ? readPortalAccessToken() : readInternalAccessToken();
}

async function portalAuthJson(path, options) {
  const requestOptions = { ...(options || {}) };
  const headers = new Headers(requestOptions.headers);
  if (requestOptions.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const token = readPortalAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  requestOptions.headers = headers;
  let response;
  try {
    response = await fetch(path, requestOptions);
  } catch (error) {
    throw new Error("本机认证服务未连接，请确认项目已经启动。", { cause: error });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || (data.code != null && Number(data.code) !== 200)) {
    throw new Error(data.msg || data.error || `请求失败：${response.status}`);
  }
  return data;
}

function readInternalAccessToken() {
  try {
    return window.sessionStorage.getItem(internalAccessTokenKey) || "";
  } catch {
    return "";
  }
}

function writeInternalAccessToken(value) {
  try {
    const clean = String(value || "").trim();
    if (clean) window.sessionStorage.setItem(internalAccessTokenKey, clean);
    else window.sessionStorage.removeItem(internalAccessTokenKey);
  } catch {}
}

function readPortalAccessToken() {
  try {
    return window.sessionStorage.getItem(portalAccessTokenKey) || "";
  } catch {
    return "";
  }
}

function writePortalAccessToken(value) {
  try {
    const clean = String(value || "").trim();
    if (clean) window.sessionStorage.setItem(portalAccessTokenKey, clean);
    else window.sessionStorage.removeItem(portalAccessTokenKey);
  } catch {}
}

function clearPortalAccessToken() {
  writePortalAccessToken("");
}

function createIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}
