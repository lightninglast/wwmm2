import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { Button } from "@renderer/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Label } from "@renderer/components/ui/label";
import { Switch } from "@renderer/components/ui/switch";
import { getSetting, setSetting } from "@renderer/lib/settings";
import { cn } from "@renderer/lib/utils";
import { ChevronLeftIcon, ChevronRightIcon, Loader2Icon, SaveIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  formatOrientation,
  type ModelViewerCameraState,
  type ModelViewerHandle,
  type ModelViewerThreeEnvironment,
  type ModelViewerThreeToneMapping,
  parseOrientation,
} from "./model-viewer-contract";
import type {
  ModelViewerDialogSource,
  ModelViewerVariantManifest,
  ModelViewerWwmiComponent,
  VariableStateValue,
  WwmiConflictResolution,
  WwmiTextureConflict,
} from "./model-viewer-dialog-types";
import { DEFAULT_MODEL_ORIENTATION, DEFAULT_THREE_EXPOSURE } from "./model-viewer-dialog-types";
import {
  clampThreeExposure,
  createStateKey,
  getSourceSessionKey,
  normalizeRealtimeShapeKeyState,
  normalizeThreeEnvironment,
  normalizeThreeToneMapping,
  stripRealtimeShapeKeyState,
  withCacheBuster,
} from "./model-viewer-dialog-utils";
import { VariantSlider, VariantTile } from "./model-viewer-dialog-variants";
import { ModelViewerMenuBar } from "./model-viewer-menu-bar";
import { cleanupModelViewerUrl, modelViewerSourceToUrl } from "./model-viewer-session";
import { ThreeModelViewer } from "./three-model-viewer";

export type { ModelViewerDialogSource } from "./model-viewer-dialog-types";

export function ModelViewerDialog({
  open,
  onOpenChange,
  source,
  existingPreviewPath,
  onPreviewSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: ModelViewerDialogSource | null;
  existingPreviewPath?: string;
  onPreviewSaved?: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [activeState, setActiveState] = useState<Record<string, VariableStateValue>>({});
  const [manifest, setManifest] = useState<ModelViewerVariantManifest | null>(null);
  const [activeAnimationId, setActiveAnimationId] = useState<string | null>(null);
  const [animationFrameIndex, setAnimationFrameIndex] = useState(0);
  const [animationPlaying, setAnimationPlaying] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [viewerUrls, setViewerUrls] = useState<[string, string]>(["", ""]);
  const [activeViewerIndex, setActiveViewerIndex] = useState<0 | 1>(0);
  const [loadingViewerIndex, setLoadingViewerIndex] = useState<0 | 1 | null>(null);
  const [modelOrientation, setModelOrientation] = useState(DEFAULT_MODEL_ORIENTATION);
  const [doubleSidedEnabled, setDoubleSidedEnabled] = useState(true);
  const [wwmiComponents, setWwmiComponents] = useState<ModelViewerWwmiComponent[]>([]);
  const [wwmiOverrides, setWwmiOverrides] = useState<Record<string, string>>({});
  const [isApplyingTexture, setIsApplyingTexture] = useState(false);
  const [wwmiGlobalSave, setWwmiGlobalSave] = useState(true);
  const [wwmiPartGlobal, setWwmiPartGlobal] = useState<Record<string, boolean>>({});
  const [isSavingPicks, setIsSavingPicks] = useState(false);
  const [precacheProgress, setPrecacheProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [toggleViewerCollapsed, setToggleViewerCollapsed] = useState(false);
  const [wwmiPanelCollapsed, setWwmiPanelCollapsed] = useState(false);
  const [wwmiConflicts, setWwmiConflicts] = useState<WwmiTextureConflict[]>([]);
  const [wwmiResolutions, setWwmiResolutions] = useState<Record<string, WwmiConflictResolution>>(
    {},
  );
  const [showConflictDialog, setShowConflictDialog] = useState(false);
  const [threeToneMapping, setThreeToneMapping] = useState<ModelViewerThreeToneMapping>("neutral");
  const [threeEnvironment, setThreeEnvironment] = useState<ModelViewerThreeEnvironment>("studio");
  const [threeExposure, setThreeExposure] = useState(DEFAULT_THREE_EXPOSURE);
  const [isViewerReady, setIsViewerReady] = useState(false);
  const [isSavingPreview, setIsSavingPreview] = useState(false);
  const [showOverwritePreviewDialog, setShowOverwritePreviewDialog] = useState(false);
  const viewerRefs = useRef<[ModelViewerHandle | null, ModelViewerHandle | null]>([null, null]);
  const doubleSidedEnabledRef = useRef(true);
  const viewerUrlsRef = useRef<[string, string]>(["", ""]);
  const activeViewerIndexRef = useRef<0 | 1>(0);
  const loadingViewerIndexRef = useRef<0 | 1 | null>(null);
  const pendingCameraStateRef = useRef<ModelViewerCameraState | null>(null);
  const initialCameraStateRef = useRef<ModelViewerCameraState | null>(null);
  const openRef = useRef(open);
  const sourceRef = useRef(source);
  const sourceSessionKeyRef = useRef<string | null>(getSourceSessionKey(source));
  const pendingVariantRequestRef = useRef<{
    source: ModelViewerDialogSource;
    viewerIndex: 0 | 1;
    stateKey: string;
  } | null>(null);

  function setViewerUrl(index: 0 | 1, sourcePath: string) {
    const nextUrl = sourcePath ? withCacheBuster(modelViewerSourceToUrl(sourcePath)) : "";
    const prevUrl = viewerUrlsRef.current[index];
    if (prevUrl && prevUrl !== nextUrl) {
      cleanupModelViewerUrl(prevUrl);
    }

    viewerUrlsRef.current = viewerUrlsRef.current.map((url, currentIndex) =>
      currentIndex === index ? nextUrl : url,
    ) as [string, string];
    setViewerUrls(viewerUrlsRef.current);
  }

  useEffect(() => {
    return () => {
      for (const url of viewerUrlsRef.current) {
        cleanupModelViewerUrl(url);
      }
    };
  }, []);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    if (open) {
      return;
    }

    resetViewerSession({ resetOrientation: true });
    setShowOverwritePreviewDialog(false);
    setIsSavingPreview(false);
  }, [open]);

  useEffect(() => {
    sourceRef.current = source;
    if (!source || source.mode !== "variant-set") {
      pendingVariantRequestRef.current = null;
    }
  }, [source]);

  useEffect(() => {
    doubleSidedEnabledRef.current = doubleSidedEnabled;
  }, [doubleSidedEnabled]);

  useEffect(() => {
    void Promise.allSettled(
      viewerRefs.current.map(async (viewer) => viewer?.setDoubleSided(doubleSidedEnabled)),
    );
  }, [doubleSidedEnabled]);

  useEffect(() => {
    const modPath = source?.modPath;
    if (!modPath) {
      return;
    }
    const unsubscribe = window.api.on("tools:wwmiPrecacheProgress", (data) => {
      if (data.modPath === modPath) {
        setPrecacheProgress({ done: data.done, total: data.total });
      }
    });
    return () => unsubscribe();
  }, [source?.modPath]);

  useEffect(() => {
    let cancelled = false;

    void Promise.all([
      getSetting("modelViewer.toneMapping"),
      getSetting("modelViewer.environment"),
      getSetting("modelViewer.exposure"),
    ])
      .then(([toneMapping, environment, exposure]) => {
        if (cancelled) {
          return;
        }

        setThreeToneMapping(normalizeThreeToneMapping(toneMapping));
        setThreeEnvironment(normalizeThreeEnvironment(environment));
        setThreeExposure(clampThreeExposure(exposure));
      })
      .catch((error) => {
        console.error("Failed to load model viewer rendering settings", error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const nextSourceSessionKey = getSourceSessionKey(source);
    const shouldResetOrientation = sourceSessionKeyRef.current !== nextSourceSessionKey;
    sourceSessionKeyRef.current = nextSourceSessionKey;

    if (!source) {
      resetViewerSession({ resetOrientation: shouldResetOrientation });
      setActiveState({});
      setManifest(null);
      setActiveAnimationId(null);
      setAnimationFrameIndex(0);
      setAnimationPlaying(false);
      setViewerUrl(0, "");
      setViewerUrl(1, "");
      return;
    }

    if (source.mode === "single") {
      resetViewerSession({ resetOrientation: shouldResetOrientation });
      setActiveState({});
      setManifest(null);
      setActiveAnimationId(null);
      setAnimationFrameIndex(0);
      setAnimationPlaying(false);
      setWwmiComponents(source.wwmiComponents ?? []);
      setWwmiOverrides({});
      setWwmiPartGlobal({});
      setViewerUrl(0, source.glbPath);
      setViewerUrl(1, "");
      return;
    }

    setWwmiComponents(source.wwmiComponents ?? []);
    setWwmiOverrides({});
    setWwmiPartGlobal({});
    resetViewerSession({ resetOrientation: shouldResetOrientation });
    setActiveState(source.manifest.defaultState);
    setManifest(source.manifest);
    setActiveAnimationId(source.manifest.animations?.[0]?.id ?? null);
    setAnimationFrameIndex(0);
    setAnimationPlaying(false);
    setViewerUrl(0, source.activeGlbPath || source.defaultGlbPath);
    setViewerUrl(1, "");
  }, [source]);

  const activeAnimation =
    manifest?.animations?.find((animation) => animation.id === activeAnimationId) ??
    manifest?.animations?.[0] ??
    null;
  const activeAnimationFrame = activeAnimation?.frames[animationFrameIndex] ?? null;
  const animationVariableIds = new Set(activeAnimation?.variableIds ?? []);

  useEffect(() => {
    if (!activeAnimation) {
      setAnimationFrameIndex(0);
      setAnimationPlaying(false);
      return;
    }

    setAnimationFrameIndex(0);
    setAnimationPlaying(activeAnimation.frames.length > 1);
  }, [activeAnimation]);

  useEffect(() => {
    if (!activeAnimation || !animationPlaying || activeAnimation.frames.length <= 1) {
      return;
    }

    const intervalMs = 1000 / Math.max(activeAnimation.fps, 1);
    const timer = window.setInterval(() => {
      setAnimationFrameIndex((current) => {
        const next = current + 1;
        if (next < activeAnimation.frames.length) {
          return next;
        }
        return activeAnimation.loop ? 0 : current;
      });
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [activeAnimation, animationPlaying]);

  const updateThreeToneMapping = (value: ModelViewerThreeToneMapping) => {
    setThreeToneMapping(value);
    void setSetting("modelViewer.toneMapping", value).catch((error) => {
      console.error("Failed to persist model viewer tone mapping", error);
      toast.error("Failed to save tone mapping setting.");
    });
  };

  const updateThreeEnvironment = (value: ModelViewerThreeEnvironment) => {
    setThreeEnvironment(value);
    void setSetting("modelViewer.environment", value).catch((error) => {
      console.error("Failed to persist model viewer environment", error);
      toast.error("Failed to save environment setting.");
    });
  };

  const updateThreeExposure = (value: number) => {
    const nextValue = clampThreeExposure(value);
    setThreeExposure(nextValue);
    void setSetting("modelViewer.exposure", nextValue).catch((error) => {
      console.error("Failed to persist model viewer exposure", error);
      toast.error("Failed to save exposure setting.");
    });
  };

  const rotateModel = (delta: [number, number, number]) => {
    setModelOrientation((currentOrientation) => {
      const [roll, pitch, yaw] = parseOrientation(currentOrientation);
      return formatOrientation([roll + delta[0], pitch + delta[1], yaw + delta[2]]);
    });
  };

  const handleResetView = () => {
    setModelOrientation(DEFAULT_MODEL_ORIENTATION);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        viewerRefs.current[activeViewerIndexRef.current]?.restoreCameraState(
          initialCameraStateRef.current,
        );
      });
    });
  };

  // WWMI base-color override: the diffuse slot can't be recovered from an
  // exported mod, so the user can re-pick a component's texture. Re-converts the
  // single GLB with the chosen override and swaps it into the inactive viewer,
  // preserving the current camera (same double-buffer path as variant swaps).
  const handleWwmiTextureOverride = async (componentIndex: number, hash: string) => {
    if (!source || !source.modPath || isApplyingTexture || loadingViewerIndex !== null) {
      return;
    }
    if (source.mode !== "single" && source.mode !== "variant-set") {
      return;
    }

    const nextOverrides = { ...wwmiOverrides, [String(componentIndex)]: hash };
    const nextViewerIndex: 0 | 1 = activeViewerIndex === 0 ? 1 : 0;
    pendingCameraStateRef.current =
      viewerRefs.current[activeViewerIndex]?.captureCameraState() ?? null;

    setIsApplyingTexture(true);
    try {
      const input =
        source.mode === "single"
          ? {
              modPath: source.modPath,
              memorySessionId: source.memorySessionId,
              wwmiTextureOverrides: nextOverrides,
            }
          : {
              artifactRoot: source.artifactRoot,
              manifestPath: source.manifestPath,
              memorySessionId: source.memorySessionId,
              modPath: source.modPath,
              state: stripRealtimeShapeKeyState(activeState, manifest?.shapeKeys),
              wwmiTextureOverrides: nextOverrides,
            };
      const result = await window.api.invoke("tools:convertStaticGlbForViewer", input);
      if (!openRef.current || sourceRef.current !== source) {
        return;
      }
      const glbPath =
        result.mode === "single"
          ? result.glbPath
          : result.mode === "variant-set"
            ? result.activeGlbPath
            : null;
      if (!glbPath) {
        return;
      }

      setWwmiOverrides(nextOverrides);
      if (result.wwmiComponents) {
        setWwmiComponents(result.wwmiComponents);
      }
      loadingViewerIndexRef.current = nextViewerIndex;
      setLoadingViewerIndex(nextViewerIndex);
      setViewerUrl(nextViewerIndex, glbPath);
    } catch (error) {
      pendingCameraStateRef.current = null;
      toast.error("Failed to apply texture", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsApplyingTexture(false);
    }
  };

  // Build the full per-part pick set from current selections (saved/override hash
  // falls back to the auto-picked hash), so saving captures the whole correct set.
  const buildWwmiPicks = () =>
    wwmiComponents.flatMap((component) => {
      const override = wwmiOverrides[String(component.index)];
      const hash = override ?? component.selectedHash;
      if (!hash) {
        return [];
      }
      return [
        {
          componentIndex: component.index,
          hash,
          candidateHashes: component.candidates
            .map((candidate) => candidate.hash)
            .filter((value): value is string => !!value),
          vertexCount: component.vertexCount,
          // Only explicit user picks teach the global table; auto-picks are
          // sidecar-only so the shared data stays trustworthy.
          confirmed: override !== undefined,
          // Per-part opt-in, defaulting to the panel-wide toggle.
          global: wwmiPartGlobal[String(component.index)] ?? wwmiGlobalSave,
        },
      ];
    });

  const persistWwmiPicks = async (
    picks: ReturnType<typeof buildWwmiPicks>,
    resolutions?: Record<string, WwmiConflictResolution>,
  ) => {
    if (!source?.modPath) {
      return;
    }
    await window.api.invoke("tools:saveWwmiTexturePicks", {
      modPath: source.modPath,
      picks,
      global: wwmiGlobalSave,
      resolutions,
    });
    toast.success("Texture picks saved");
  };

  const handleSaveWwmiPicks = async () => {
    if (!source?.modPath || isSavingPicks) {
      return;
    }
    const picks = buildWwmiPicks();
    if (picks.length === 0) {
      return;
    }
    setIsSavingPicks(true);
    try {
      if (wwmiGlobalSave) {
        const conflicts = await window.api.invoke("tools:checkWwmiTextureConflicts", picks);
        if (conflicts.length > 0) {
          setWwmiConflicts(conflicts);
          setWwmiResolutions(
            Object.fromEntries(
              conflicts.map((conflict) => [String(conflict.componentIndex), "use-new"]),
            ),
          );
          setShowConflictDialog(true);
          return;
        }
      }
      await persistWwmiPicks(picks);
    } catch (error) {
      toast.error("Failed to save texture picks", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsSavingPicks(false);
    }
  };

  const handlePrecacheTextures = async () => {
    if (!source?.modPath || precacheProgress) {
      return;
    }
    setPrecacheProgress({ done: 0, total: 0 });
    try {
      const result = await window.api.invoke("tools:precacheWwmiTextures", source.modPath);
      toast.success(`Pre-cached ${result.prepared}/${result.total} textures`);
    } catch (error) {
      toast.error("Failed to pre-cache textures", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPrecacheProgress(null);
    }
  };

  const handleClearTextureCache = async () => {
    if (!source?.modPath) {
      return;
    }
    try {
      const removed = await window.api.invoke("tools:clearWwmiTextureCache", source.modPath);
      toast.success(`Cleared ${removed} cached texture file(s) for this mod`);
    } catch (error) {
      toast.error("Failed to clear texture cache", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleConfirmConflicts = async () => {
    setShowConflictDialog(false);
    setIsSavingPicks(true);
    try {
      await persistWwmiPicks(buildWwmiPicks(), wwmiResolutions);
    } catch (error) {
      toast.error("Failed to save texture picks", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsSavingPicks(false);
    }
  };

  const handleResetToggles = async () => {
    if (!source || source.mode !== "variant-set" || isResolving || loadingViewerIndex !== null) {
      return;
    }

    const nextState = manifest?.defaultState ?? source.manifest.defaultState;
    const artifactState = stripRealtimeShapeKeyState(nextState, manifest?.shapeKeys);

    if (
      createStateKey(stripRealtimeShapeKeyState(activeState, manifest?.shapeKeys)) ===
      createStateKey(artifactState)
    ) {
      setActiveState(nextState);
      return;
    }

    const nextViewerIndex: 0 | 1 = activeViewerIndex === 0 ? 1 : 0;
    pendingCameraStateRef.current =
      viewerRefs.current[activeViewerIndex]?.captureCameraState() ?? null;

    // Cached state GLBs are built without live texture overrides, so only reuse
    // them when there are no in-session picks to preserve.
    const hasLiveTextureOverrides = Object.keys(wwmiOverrides).length > 0;
    const nextStateKey = createStateKey(artifactState);
    const existingStateArtifact = manifest?.states.find((entry) => entry.key === nextStateKey);
    if (!hasLiveTextureOverrides && existingStateArtifact?.glbPath) {
      setActiveState(nextState);
      loadingViewerIndexRef.current = nextViewerIndex;
      setLoadingViewerIndex(nextViewerIndex);
      setViewerUrl(nextViewerIndex, existingStateArtifact.glbPath);
      return;
    }

    setIsResolving(true);
    const expectedSource = source;
    const expectedViewerIndex = nextViewerIndex;
    const expectedStateKey = nextStateKey;
    pendingVariantRequestRef.current = {
      source: expectedSource,
      viewerIndex: expectedViewerIndex,
      stateKey: expectedStateKey,
    };
    try {
      const result = await window.api.invoke("tools:convertStaticGlbForViewer", {
        artifactRoot: source.artifactRoot,
        manifestPath: source.manifestPath,
        memorySessionId: source.memorySessionId,
        modPath: source.modPath,
        state: artifactState,
        wwmiTextureOverrides: wwmiOverrides,
      });
      if (result.mode !== "variant-set") {
        return;
      }
      if (
        !openRef.current ||
        sourceRef.current !== expectedSource ||
        pendingVariantRequestRef.current?.source !== expectedSource ||
        pendingVariantRequestRef.current.viewerIndex !== expectedViewerIndex ||
        pendingVariantRequestRef.current.stateKey !== expectedStateKey
      ) {
        return;
      }

      setManifest(result.manifest);
      setActiveState(nextState);
      if (result.wwmiComponents) {
        setWwmiComponents(result.wwmiComponents);
      }
      loadingViewerIndexRef.current = nextViewerIndex;
      setLoadingViewerIndex(nextViewerIndex);
      setViewerUrl(nextViewerIndex, result.activeGlbPath);
    } catch (error) {
      pendingCameraStateRef.current = null;
      loadingViewerIndexRef.current = null;
      setLoadingViewerIndex(null);
      toast.error("Failed to reset model variant", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (
        pendingVariantRequestRef.current?.source === expectedSource &&
        pendingVariantRequestRef.current.viewerIndex === expectedViewerIndex &&
        pendingVariantRequestRef.current.stateKey === expectedStateKey
      ) {
        pendingVariantRequestRef.current = null;
      }
      setIsResolving(false);
    }
  };

  const handleSaveTogglesToIni = async () => {
    if (!source || source.mode !== "variant-set" || isResolving || loadingViewerIndex !== null) {
      return;
    }

    const iniPath = manifest?.iniPath ?? source.manifest.iniPath;
    if (!iniPath) {
      toast.error(t("page.tools.model_viewer.toast.save_to_ini_error"));
      return;
    }

    try {
      const result = await window.api.invoke(
        "tools:persistModelViewerToggleState",
        iniPath,
        activeState,
      );

      if (result.updatedVariables.length > 0) {
        toast.success(t("page.tools.model_viewer.toast.save_to_ini_success"));
        return;
      }

      toast.warning(t("page.tools.model_viewer.toast.save_to_ini_no_changes"));
    } catch (error) {
      toast.error(t("page.tools.model_viewer.toast.save_to_ini_error"), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleSelectValue = async (variableId: string, value: VariableStateValue) => {
    if (!source || source.mode !== "variant-set" || isResolving || loadingViewerIndex !== null) {
      return;
    }

    const nextState = {
      ...activeState,
      [variableId]: value,
    };
    const hasRealtimeShapeKey = Boolean(
      manifest?.shapeKeys?.some((shapeKey) =>
        shapeKey.dimensions.some((dimension) => dimension.variableId === variableId),
      ),
    );
    if (hasRealtimeShapeKey) {
      setActiveState(nextState);
      return;
    }
    const artifactState = stripRealtimeShapeKeyState(nextState, manifest?.shapeKeys);

    const nextViewerIndex: 0 | 1 = activeViewerIndex === 0 ? 1 : 0;
    pendingCameraStateRef.current =
      viewerRefs.current[activeViewerIndex]?.captureCameraState() ?? null;

    // Cached state GLBs are built without live texture overrides, so only reuse
    // them when there are no in-session picks to preserve.
    const hasLiveTextureOverrides = Object.keys(wwmiOverrides).length > 0;
    const nextStateKey = createStateKey(artifactState);
    const existingStateArtifact = manifest?.states.find((entry) => entry.key === nextStateKey);
    if (!hasLiveTextureOverrides && existingStateArtifact?.glbPath) {
      setActiveState(nextState);
      loadingViewerIndexRef.current = nextViewerIndex;
      setLoadingViewerIndex(nextViewerIndex);
      setViewerUrl(nextViewerIndex, existingStateArtifact.glbPath);
      return;
    }

    setIsResolving(true);
    const expectedSource = source;
    const expectedViewerIndex = nextViewerIndex;
    const expectedStateKey = nextStateKey;
    pendingVariantRequestRef.current = {
      source: expectedSource,
      viewerIndex: expectedViewerIndex,
      stateKey: expectedStateKey,
    };
    try {
      const result = await window.api.invoke("tools:convertStaticGlbForViewer", {
        artifactRoot: source.artifactRoot,
        manifestPath: source.manifestPath,
        memorySessionId: source.memorySessionId,
        modPath: source.modPath,
        state: artifactState,
        wwmiTextureOverrides: wwmiOverrides,
      });
      if (result.mode !== "variant-set") {
        return;
      }
      if (
        !openRef.current ||
        sourceRef.current !== expectedSource ||
        pendingVariantRequestRef.current?.source !== expectedSource ||
        pendingVariantRequestRef.current.viewerIndex !== expectedViewerIndex ||
        pendingVariantRequestRef.current.stateKey !== expectedStateKey
      ) {
        return;
      }

      setManifest(result.manifest);
      setActiveState(nextState);
      if (result.wwmiComponents) {
        setWwmiComponents(result.wwmiComponents);
      }
      loadingViewerIndexRef.current = nextViewerIndex;
      setLoadingViewerIndex(nextViewerIndex);
      setViewerUrl(nextViewerIndex, result.activeGlbPath);
    } catch (error) {
      pendingCameraStateRef.current = null;
      loadingViewerIndexRef.current = null;
      setLoadingViewerIndex(null);
      toast.error("Failed to update model variant", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (
        pendingVariantRequestRef.current?.source === expectedSource &&
        pendingVariantRequestRef.current.viewerIndex === expectedViewerIndex &&
        pendingVariantRequestRef.current.stateKey === expectedStateKey
      ) {
        pendingVariantRequestRef.current = null;
      }
      setIsResolving(false);
    }
  };

  const handleAnimationTogglePlayback = () => {
    if (!activeAnimation || activeAnimation.frames.length <= 1) {
      return;
    }

    setAnimationPlaying((current) => !current);
  };

  const handleAnimationReset = () => {
    setAnimationFrameIndex(0);
    setAnimationPlaying(false);
  };

  const variables = manifest?.variables ?? [];
  const uiAssets = manifest?.uiAssets;
  const visibleVariables = variables.filter(
    (variable) => variable.values.length > 0 && !animationVariableIds.has(variable.id),
  );
  const tileVariables = visibleVariables.filter((variable) => variable.controlType !== "slider");
  const sliderVariables = visibleVariables.filter((variable) => variable.controlType === "slider");
  const tileBackgroundPath = uiAssets?.backgroundPath;
  const slotPath = uiAssets?.slotPath;
  const slotHoverPath = uiAssets?.slotHoverPath;
  const slotActivePath = uiAssets?.slotActivePath;
  const shapeKeys = manifest?.shapeKeys;
  const viewerState = {
    ...activeState,
    ...(activeAnimationFrame?.values ?? {}),
  };
  const viewerVariantState = normalizeRealtimeShapeKeyState(viewerState, variables, shapeKeys);
  const hasVariantTileUi = Boolean(tileBackgroundPath) && tileVariables.length > 0;
  const hasVariantToggleUi = visibleVariables.length > 0;
  const showToggleViewer = Boolean(
    source?.mode === "variant-set" && manifest && (hasVariantTileUi || hasVariantToggleUi),
  );
  const showWwmiPanel =
    (source?.mode === "single" || source?.mode === "variant-set") && wwmiComponents.length > 0;
  const isViewerBusy = isResolving || loadingViewerIndex !== null;
  const canSaveCapturedPreview =
    Boolean(source?.modPath) && isViewerReady && !isViewerBusy && !isSavingPreview;

  function resetViewerSession(options?: { resetOrientation?: boolean }) {
    const currentIndex = activeViewerIndexRef.current;
    const currentUrl = viewerUrlsRef.current[currentIndex];
    const inactiveIndex: 0 | 1 = currentIndex === 0 ? 1 : 0;
    const inactiveUrl = viewerUrlsRef.current[inactiveIndex];

    if (inactiveUrl && inactiveUrl !== currentUrl) {
      cleanupModelViewerUrl(inactiveUrl);
    }

    viewerUrlsRef.current = [currentUrl, ""];
    setViewerUrls(viewerUrlsRef.current);
    if (options?.resetOrientation !== false) {
      setModelOrientation(DEFAULT_MODEL_ORIENTATION);
    }
    activeViewerIndexRef.current = 0;
    loadingViewerIndexRef.current = null;
    setActiveViewerIndex(0);
    setLoadingViewerIndex(null);
    pendingCameraStateRef.current = null;
    initialCameraStateRef.current = null;
    setIsViewerReady(false);
  }

  const handleViewerLoad = (index: 0 | 1) => {
    void (async () => {
      const viewer = viewerRefs.current[index];
      if (!viewer) {
        return;
      }

      await viewer.setDoubleSided(doubleSidedEnabledRef.current);
      const isPendingViewerSwap = loadingViewerIndexRef.current === index;
      const isInitialActiveViewerLoad =
        loadingViewerIndexRef.current === null && activeViewerIndexRef.current === index;
      const shouldRestorePendingCamera =
        isPendingViewerSwap && pendingCameraStateRef.current !== null;
      if (!shouldRestorePendingCamera) {
        await viewer.updateFraming();
      }

      requestAnimationFrame(() => {
        if (initialCameraStateRef.current) {
          return;
        }

        initialCameraStateRef.current = viewerRefs.current[index]?.captureCameraState() ?? null;
      });

      if (!isPendingViewerSwap && !isInitialActiveViewerLoad) {
        return;
      }

      if (shouldRestorePendingCamera) {
        viewer.restoreCameraState(pendingCameraStateRef.current, {
          includeFieldOfView: false,
        });
      }
      pendingCameraStateRef.current = null;
      // Swap as soon as the freshly loaded viewer has rendered one frame. A
      // single rAF avoids a blank flash without the extra latency of the old
      // double-rAF + crossfade.
      requestAnimationFrame(() => {
        activeViewerIndexRef.current = index;
        if (isPendingViewerSwap) {
          loadingViewerIndexRef.current = null;
        }
        setActiveViewerIndex(index);
        setLoadingViewerIndex(null);
        setIsViewerReady(true);
      });
    })();
  };

  const handleViewerError = (index: 0 | 1, error: unknown) => {
    if (loadingViewerIndexRef.current !== index) {
      return;
    }

    const activeIndex = activeViewerIndexRef.current;
    pendingCameraStateRef.current = null;
    loadingViewerIndexRef.current = null;
    setActiveViewerIndex(activeIndex);
    setLoadingViewerIndex(null);
    setIsViewerReady(false);
    console.error("Failed to load model viewer source", error);
  };

  const captureAndSavePreview = async () => {
    if (!source?.modPath) {
      return;
    }

    const dataUrl =
      (await viewerRefs.current[activeViewerIndexRef.current]?.captureSquarePngDataUrl()) ?? null;
    if (!dataUrl) {
      throw new Error(t("page.tools.model_viewer.toast.capture_preview_error"));
    }

    await window.api.invoke(
      "mod:pastePreview",
      source.modPath,
      dataUrl,
      "base64",
      existingPreviewPath,
    );
    await onPreviewSaved?.();
  };

  const handleCapturePreviewClick = () => {
    if (!source?.modPath || !canSaveCapturedPreview) {
      return;
    }

    if (existingPreviewPath) {
      setShowOverwritePreviewDialog(true);
      return;
    }

    void handleConfirmCapturePreview();
  };

  const handleConfirmCapturePreview = async () => {
    setShowOverwritePreviewDialog(false);
    setIsSavingPreview(true);
    try {
      await captureAndSavePreview();
      toast.success(t("page.tools.model_viewer.toast.capture_preview_success"));
    } catch (error) {
      toast.error(t("page.tools.model_viewer.toast.capture_preview_error"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsSavingPreview(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="flex min-w-[95vw] max-h-[92vh] h-full flex-col gap-3 p-3 focus:outline-none focus-visible:outline-none"
          onClick={(e) => e.stopPropagation()}
        >
          <DialogHeader className="pr-10">
            <DialogTitle className="truncate" title={source?.name}>
              {source?.name || t("page.tools.model_viewer.title")}
            </DialogTitle>
          </DialogHeader>

          <ModelViewerMenuBar
            rotateModel={rotateModel}
            onResetView={handleResetView}
            doubleSidedEnabled={doubleSidedEnabled}
            onDoubleSidedChange={(v) => setDoubleSidedEnabled(v)}
            toneMapping={threeToneMapping}
            onToneMappingChange={updateThreeToneMapping}
            environment={threeEnvironment}
            onEnvironmentChange={updateThreeEnvironment}
            exposure={threeExposure}
            onExposureDraftChange={(v) => setThreeExposure(v)}
            onExposureCommit={updateThreeExposure}
            showToggleViewer={showToggleViewer}
            isViewerBusy={isViewerBusy}
            onSaveTogglesToIni={handleSaveTogglesToIni}
            onResetToggles={handleResetToggles}
            canSaveCapturedPreview={canSaveCapturedPreview}
            onCapturePreviewClick={handleCapturePreviewClick}
            canClearTextureCache={Boolean(source?.modPath)}
            onClearTextureCache={handleClearTextureCache}
          />

          <div className="flex min-h-0 flex-1 gap-3">
            <div className="relative min-h-80 min-w-0 flex-1 overflow-hidden rounded-md border bg-muted/30">
              {viewerUrls.some((url) => Boolean(url)) ? (
                <>
                  {([0, 1] as const).map((index) => (
                    <ThreeModelViewer
                      key={index}
                      ref={(viewer) => {
                        viewerRefs.current[index] = viewer;
                      }}
                      className={cn(
                        "absolute inset-0 h-full w-full",
                        activeViewerIndex === index
                          ? "z-10 opacity-100"
                          : "pointer-events-none z-0 opacity-0",
                      )}
                      src={viewerUrls[index]}
                      orientation={modelOrientation}
                      variantState={viewerVariantState}
                      shapeKeys={shapeKeys}
                      animationClip={activeAnimation ?? undefined}
                      animationFrame={animationFrameIndex}
                      threeToneMapping={threeToneMapping}
                      threeEnvironment={threeEnvironment}
                      threeExposure={threeExposure}
                      onLoad={() => handleViewerLoad(index)}
                      onError={(error) => handleViewerError(index, error)}
                    />
                  ))}
                  <div
                    className={cn(
                      "absolute inset-0 z-20 flex items-center justify-center bg-black/20",
                      isViewerBusy
                        ? "cursor-progress opacity-100"
                        : "pointer-events-none opacity-0",
                    )}
                  >
                    <div
                      className={cn(
                        "inline-flex items-center gap-2 rounded-md border bg-background/90 px-3 py-2 text-sm text-foreground shadow-sm",
                        isViewerBusy ? "opacity-100" : "opacity-0",
                      )}
                    >
                      <Loader2Icon className="size-4 animate-spin" />
                      {t("page.tools.model_viewer.generating_selected_state")}
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                  {t("page.tools.model_viewer.model_data_unavailable")}
                </div>
              )}
            </div>

            {showToggleViewer && toggleViewerCollapsed ? (
              <button
                type="button"
                onClick={() => setToggleViewerCollapsed(false)}
                className="flex w-9 shrink-0 flex-col items-center gap-2 rounded-md border bg-card/20 py-3 text-xs text-muted-foreground hover:bg-card/40"
              >
                <ChevronLeftIcon className="size-4" />
                <span className="[writing-mode:vertical-rl] rotate-180">
                  {t("page.tools.model_viewer.toggle_viewer")}
                </span>
              </button>
            ) : null}

            {showToggleViewer && !toggleViewerCollapsed ? (
              <div
                className={cn(
                  "flex w-[300px] min-h-0 shrink-0 flex-col overflow-hidden rounded-md border bg-card/20 transition-opacity",
                  isViewerBusy && "pointer-events-none opacity-60",
                )}
                aria-busy={isViewerBusy}
              >
                <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
                  <div className="text-sm font-medium">
                    {t("page.tools.model_viewer.toggle_viewer")}
                  </div>
                  <button
                    type="button"
                    onClick={() => setToggleViewerCollapsed(true)}
                    className="text-muted-foreground hover:text-foreground"
                    title="Collapse"
                  >
                    <ChevronRightIcon className="size-4" />
                  </button>
                </div>
                <ScrollArea className="min-h-0 flex-1">
                  <div className="p-4">
                    {hasVariantTileUi ? (
                      <div
                        className="mb-4 overflow-hidden rounded-md border bg-cover bg-center"
                        style={{
                          backgroundImage: tileBackgroundPath
                            ? `url(${modelViewerSourceToUrl(tileBackgroundPath)})`
                            : undefined,
                        }}
                      >
                        <div className="grid grid-cols-3 gap-3 p-4">
                          {tileVariables.map((variable) => (
                            <VariantTile
                              key={variable.id}
                              variable={variable}
                              activeValue={activeState[variable.id]}
                              slotPath={slotPath}
                              slotHoverPath={slotHoverPath}
                              slotActivePath={slotActivePath}
                              disabled={isViewerBusy}
                              onSelect={handleSelectValue}
                            />
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div className="space-y-3">
                      {tileVariables.map((variable) => (
                        <div key={variable.id} className="rounded-md border bg-background/50 p-3">
                          <div className="mb-2 text-sm font-medium">{variable.label}</div>
                          <div className="flex flex-wrap gap-2">
                            {variable.values.map((entry) => {
                              const active =
                                String(activeState[variable.id]) === String(entry.value);
                              return (
                                <Button
                                  key={`${variable.id}-${String(entry.value)}`}
                                  type="button"
                                  size="sm"
                                  variant={active ? "default" : "outline"}
                                  disabled={isViewerBusy}
                                  onClick={() => handleSelectValue(variable.id, entry.value)}
                                >
                                  {entry.label}
                                </Button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                      {sliderVariables.map((variable) => (
                        <VariantSlider
                          key={variable.id}
                          variable={variable}
                          activeValue={activeState[variable.id]}
                          disabled={isViewerBusy}
                          realtime={Boolean(
                            shapeKeys?.some((shapeKey) =>
                              shapeKey.dimensions.some(
                                (dimension) => dimension.variableId === variable.id,
                              ),
                            ),
                          )}
                          onSelect={handleSelectValue}
                        />
                      ))}
                    </div>
                  </div>
                </ScrollArea>
              </div>
            ) : null}

            {showWwmiPanel && wwmiPanelCollapsed ? (
              <button
                type="button"
                onClick={() => setWwmiPanelCollapsed(false)}
                className="flex w-9 shrink-0 flex-col items-center gap-2 rounded-md border bg-card/20 py-3 text-xs text-muted-foreground hover:bg-card/40"
              >
                <ChevronLeftIcon className="size-4" />
                <span className="[writing-mode:vertical-rl] rotate-180">Textures</span>
              </button>
            ) : null}

            {showWwmiPanel && !wwmiPanelCollapsed ? (
              <div
                className={cn(
                  "flex w-[300px] min-h-0 shrink-0 flex-col overflow-hidden rounded-md border bg-card/20 transition-opacity",
                  isApplyingTexture && "pointer-events-none opacity-60",
                )}
                aria-busy={isApplyingTexture}
              >
                <div className="border-b px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium">Textures</div>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7"
                        disabled={!!precacheProgress}
                        onClick={handlePrecacheTextures}
                        title="Decode & cache every texture option up front so switching is instant"
                      >
                        {precacheProgress
                          ? `Caching ${precacheProgress.done}/${precacheProgress.total || "…"}`
                          : "Pre-cache"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="h-7"
                        disabled={isApplyingTexture || isSavingPicks}
                        onClick={handleSaveWwmiPicks}
                      >
                        <SaveIcon className="size-3.5" />
                        Save
                      </Button>
                      <button
                        type="button"
                        onClick={() => setWwmiPanelCollapsed(true)}
                        className="text-muted-foreground hover:text-foreground"
                        title="Collapse"
                      >
                        <ChevronRightIcon className="size-4" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Base color per part — auto-picked, override if wrong.
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <Switch
                      id="wwmi-global-save"
                      checked={wwmiGlobalSave}
                      onCheckedChange={setWwmiGlobalSave}
                    />
                    <Label htmlFor="wwmi-global-save" className="text-xs text-muted-foreground">
                      Save globally (default; per-part below)
                    </Label>
                  </div>
                </div>
                <ScrollArea className="min-h-0 flex-1">
                  <div className="space-y-3 p-4">
                    {wwmiComponents.map((component) => {
                      const selected =
                        wwmiOverrides[String(component.index)] ?? component.selectedHash ?? "";
                      return (
                        <div
                          key={component.index}
                          className="rounded-md border bg-background/50 p-3"
                        >
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <div className="text-sm font-medium">Part {component.index}</div>
                            <div className="flex items-center gap-1.5">
                              <Switch
                                id={`wwmi-part-global-${component.index}`}
                                checked={
                                  wwmiPartGlobal[String(component.index)] ?? wwmiGlobalSave
                                }
                                onCheckedChange={(checked) =>
                                  setWwmiPartGlobal((prev) => ({
                                    ...prev,
                                    [String(component.index)]: checked,
                                  }))
                                }
                              />
                              <Label
                                htmlFor={`wwmi-part-global-${component.index}`}
                                className="text-[11px] text-muted-foreground"
                              >
                                Global
                              </Label>
                            </div>
                          </div>
                          <Select
                            value={selected}
                            disabled={isApplyingTexture}
                            onValueChange={(value) =>
                              handleWwmiTextureOverride(component.index, value)
                            }
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Select texture" />
                            </SelectTrigger>
                            <SelectContent>
                              {component.candidates
                                .filter((candidate) => candidate.hash)
                                .map((candidate) => (
                                  <SelectItem
                                    key={candidate.resourceName}
                                    value={candidate.hash as string}
                                  >
                                    {candidate.filename}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              </div>
            ) : null}
          </div>

          {activeAnimation ? (
            <div className="flex items-center gap-2 px-2">
              <div className="min-w-0 w-36">
                <div className="text-sm font-medium">{activeAnimation.label}</div>
                <div className="whitespace-nowrap text-xs text-muted-foreground">
                  {activeAnimation.fps} FPS · Frame{" "}
                  {activeAnimationFrame?.index ?? activeAnimation.frameStart} /{" "}
                  {activeAnimation.frameEnd}
                </div>
              </div>

              <div className="flex min-w-0 flex-1 items-center gap-3">
                <span className="text-xs tabular-nums text-muted-foreground">
                  {activeAnimation.frameStart}
                </span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(activeAnimation.frames.length - 1, 0)}
                  step={1}
                  value={animationFrameIndex}
                  className="w-full accent-primary"
                  onChange={(event) => {
                    setAnimationPlaying(false);
                    setAnimationFrameIndex(Number(event.currentTarget.value));
                  }}
                />
                <span className="text-right text-xs tabular-nums text-muted-foreground">
                  {activeAnimation.frameEnd}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleAnimationTogglePlayback}
                  disabled={activeAnimation.frames.length <= 1}
                >
                  {animationPlaying ? "Pause" : "Play"}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={handleAnimationReset}>
                  Reset
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog open={showOverwritePreviewDialog} onOpenChange={setShowOverwritePreviewDialog}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("page.tools.model_viewer.dialog.overwrite_preview.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("page.tools.model_viewer.dialog.overwrite_preview.description", {
                name: source?.name ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("g.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleConfirmCapturePreview()}>
              {t("page.tools.model_viewer.dialog.overwrite_preview.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showConflictDialog} onOpenChange={setShowConflictDialog}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>Texture conflicts with saved globals</AlertDialogTitle>
            <AlertDialogDescription>
              Some picks differ from a texture already saved globally as a base color. Choose how to
              resolve each before saving.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-80 space-y-3 overflow-y-auto">
            {wwmiConflicts.map((conflict) => (
              <div key={conflict.componentIndex} className="rounded-md border p-3 text-sm">
                <div className="font-medium">Part {conflict.componentIndex}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  <div>
                    Your pick: <span className="font-mono">{conflict.chosenHash}</span> (
                    {conflict.newSize} verts)
                  </div>
                  <div>
                    Already global: <span className="font-mono">{conflict.existingHash}</span> from “
                    {conflict.sourceMod}”
                    {conflict.sourceSize ? ` (${conflict.sourceSize} verts)` : ""}
                  </div>
                </div>
                <Select
                  value={wwmiResolutions[String(conflict.componentIndex)] ?? "use-new"}
                  onValueChange={(value) =>
                    setWwmiResolutions((prev) => ({
                      ...prev,
                      [String(conflict.componentIndex)]: value as WwmiConflictResolution,
                    }))
                  }
                >
                  <SelectTrigger className="mt-2 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="use-new">Use my new pick globally</SelectItem>
                    <SelectItem value="keep-old">Keep old global (save mine to this mod only)</SelectItem>
                    <SelectItem value="keep-both">Keep both global</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("g.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleConfirmConflicts()}>Save</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
