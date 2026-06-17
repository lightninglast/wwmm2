import os from "node:os";
import path from "node:path";
import type { WWMM2App } from "@main/index";
import {
    convertModToGlb,
    convertModToGlbBuffer,
    type ConvertModToGlbResult,
    clearModTextureCache,
    convertModToVariantArtifacts,
    type ConvertModVariantArtifactsResult,
    precacheModTextures,
    resolveVariantStateArtifact,
    type StaticGlbTextureFormat,
    type StaticGlbVariantManifest,
    type VariableStateMap,
    type WwmiComponentTextureInfo,
} from "@main/lib/mod-static-glb";
import { createStateKey } from "@main/lib/mod-static-glb/shared";
import {
    cleanupModelViewerMemorySession,
    createModelViewerMemorySession,
    writeModelViewerMemoryBuffer,
} from "@main/services/protocol/model-viewer-memory";
import {
    checkConflicts,
    getKnownBaseColorHashes,
    loadSidecarOverrides,
    savePicks,
    type WwmiTextureConflict,
    type WwmiTextureConflictResolution,
    type WwmiTexturePick,
} from "@main/services/mod-tools/texture-roles";
import { app } from "electron";
import fse from "fs-extra";

const ASSET_PATH_SETTING_KEY = "mod_static_glb_asset_path";
const TEXTURE_FORMAT_SETTING_KEY = "mod_static_glb_texture_format";
const JPEG_QUALITY_SETTING_KEY = "mod_static_glb_jpeg_quality";
const MODEL_VIEWER_TEMP_PREFIX = "wwmm2-model-viewer-";
const DEFAULT_TEXTURE_FORMAT: StaticGlbTextureFormat = "jpeg-safe";
const DEFAULT_JPEG_QUALITY = 85;
const TEXTURE_CACHE_DIR_NAME = "static-glb-texture-cache";
const TEXTURE_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
// Cap embedded texture resolution for the viewer — 4K textures are pointless for
// preview and dominate frontend decode/GPU-upload time. 2048 keeps quality high.
const VIEWER_TEXTURE_MAX_DIMENSION = 2048;

export type StaticGlbConvertInput = {
    modPath: string;
    assetPath?: string;
    outputPath: string;
    textureFormat?: StaticGlbTextureFormat;
    jpegQuality?: number;
    includeTangents?: boolean;
    debug?: boolean;
};

export type StaticGlbTextureSettings = {
    textureFormat: StaticGlbTextureFormat;
    jpegQuality: number;
};

export type StaticGlbSingleResult = {
    mode: "single";
    iniPath: string;
    glbPath: string;
    memorySessionId?: string;
    meshCount: number;
    warningCount: number;
    name: string;
    modPath?: string;
    wwmiComponents?: WwmiComponentTextureInfo[];
};

export type StaticGlbVariantResult = {
    mode: "variant-set";
    iniPath: string;
    artifactRoot: string;
    manifestPath: string;
    manifest: StaticGlbVariantManifest;
    memorySessionId?: string;
    defaultGlbPath: string;
    activeGlbPath: string;
    meshCount: number;
    warningCount: number;
    name: string;
    modPath?: string;
    wwmiComponents?: WwmiComponentTextureInfo[];
};

export type StaticGlbViewerResult =
    | (ConvertModToGlbResult & {
          mode: "single";
          glbPath: string;
          name: string;
      })
    | (ConvertModVariantArtifactsResult & {
          mode: "variant-set";
          glbPath: string;
          name: string;
      });

export type StaticGlbPreviewResult = StaticGlbSingleResult | StaticGlbVariantResult;

export type StaticGlbViewerInput =
    | string
    | {
          modPath?: string;
          artifactRoot?: string;
          manifestPath?: string;
          memorySessionId?: string;
          state?: VariableStateMap;
          wwmiTextureOverrides?: Record<string, string>;
      };

type ViewerMemorySession = {
    manifest?: StaticGlbVariantManifest;
    manifestPath?: string;
    modPath: string;
};

export class StaticGlb {
    private readonly viewerMemorySessions = new Map<string, ViewerMemorySession>();

    constructor(private readonly desktop: WWMM2App) {
        this.desktop.service.startupCleanup.register({
            name: "mod-tools:static-glb-viewer",
            run: () => this.cleanupStaleViewerTempDirs(),
        });
        this.desktop.service.startupCleanup.register({
            name: "mod-tools:static-glb-texture-cache",
            run: () => this.trimTextureCache(),
        });
    }

    private getTextureCacheDir(): string {
        return path.join(app.getPath("userData"), TEXTURE_CACHE_DIR_NAME);
    }

    public async getAssetPath(): Promise<string> {
        return (await this.getSettingValue(ASSET_PATH_SETTING_KEY)) || "";
    }

    public async setAssetPath(assetPath: string): Promise<string> {
        const normalized = path.resolve(assetPath.trim());
        const stat = await fse.stat(normalized);
        if (!stat.isDirectory()) {
            throw new Error("Asset path must be a directory.");
        }

        await this.desktop.lib.db.settings.upsert(ASSET_PATH_SETTING_KEY, normalized);

        return normalized;
    }

    public async getTextureFormat(): Promise<StaticGlbTextureFormat> {
        return normalizeTextureFormat(await this.getSettingValue(TEXTURE_FORMAT_SETTING_KEY));
    }

    public async setTextureFormat(
        textureFormat: StaticGlbTextureFormat,
    ): Promise<StaticGlbTextureFormat> {
        const normalized = normalizeTextureFormat(textureFormat);
        await this.saveSettingValue(TEXTURE_FORMAT_SETTING_KEY, normalized);
        return normalized;
    }

    public async getJpegQuality(): Promise<number> {
        return normalizeJpegQuality(await this.getSettingValue(JPEG_QUALITY_SETTING_KEY));
    }

    public async setJpegQuality(jpegQuality: number): Promise<number> {
        const normalized = normalizeJpegQuality(jpegQuality);
        await this.saveSettingValue(JPEG_QUALITY_SETTING_KEY, String(normalized));
        return normalized;
    }

    public async getTextureSettings(): Promise<StaticGlbTextureSettings> {
        const [textureFormat, jpegQuality] = await Promise.all([
            this.getTextureFormat(),
            this.getJpegQuality(),
        ]);
        return {
            textureFormat,
            jpegQuality,
        };
    }

    public async convert(input: StaticGlbConvertInput): Promise<StaticGlbViewerResult> {
        const assetPath = input.assetPath?.trim() || (await this.getAssetPath());
        if (!assetPath) {
            throw new Error("Set the static GLB asset path in Mod Tools first.");
        }

        const savedTextureSettings = await this.getTextureSettings();
        const textureFormat = normalizeTextureFormat(
            input.textureFormat ?? savedTextureSettings.textureFormat,
        );
        const jpegQuality = normalizeJpegQuality(
            input.jpegQuality ?? savedTextureSettings.jpegQuality,
        );

        await this.setAssetPath(assetPath);
        await Promise.all([this.setTextureFormat(textureFormat), this.setJpegQuality(jpegQuality)]);

        const outputPath = ensureGlbExtension(path.resolve(input.outputPath));
        const warnings: string[] = [];
        const artifactRoot = path.resolve(stripGlbExtension(outputPath));
        const variantResult = await convertModToVariantArtifacts({
            modPath: input.modPath,
            assetPath,
            artifactRoot,
            includeTangents: input.includeTangents,
            textureFormat,
            jpegQuality,
            debug: input.debug,
            logger: this.desktop.logger,
            onWarning: (message) => {
                warnings.push(message);
                this.desktop.logger.warn(message, "StaticGlb.convert");
            },
        });

        if (variantResult) {
            if (warnings.length > 0) {
                this.desktop.window.main.window?.webContents.send(
                    "fn:toast",
                    "Static GLB conversion completed with warnings",
                    { description: warnings.slice(0, 3).join("\n") },
                );
            }

            return {
                ...variantResult,
                mode: "variant-set",
                glbPath: variantResult.defaultGlbPath,
                name: path.basename(variantResult.artifactRoot),
            };
        }

        const result = await convertModToGlb({
            modPath: input.modPath,
            assetPath,
            outputPath,
            includeTangents: input.includeTangents,
            textureFormat,
            jpegQuality,
            debug: input.debug,
            logger: this.desktop.logger,
            onWarning: (message) => {
                warnings.push(message);
                this.desktop.logger.warn(message, "StaticGlb.convert");
            },
        });

        if (warnings.length > 0) {
            this.desktop.window.main.window?.webContents.send(
                "fn:toast",
                "Static GLB conversion completed with warnings",
                { description: warnings.slice(0, 3).join("\n") },
            );
        }

        return {
            ...result,
            mode: "single",
            glbPath: result.outputPath,
            name: path.basename(result.outputPath, ".glb"),
        };
    }

    public async convertForViewer(input: StaticGlbViewerInput): Promise<StaticGlbPreviewResult> {
        const startedAt = Date.now();
        let memorySessionId: string | undefined;
        let lastCheckpointAt = startedAt;
        const logTiming = (stage: string) => {
            const now = Date.now();
            const totalElapsedMs = now - startedAt;
            const stageElapsedMs = now - lastCheckpointAt;
            lastCheckpointAt = now;
            this.desktop.logger.info(
                `${stage} completed in ${stageElapsedMs}ms (total ${totalElapsedMs}ms)`,
                "StaticGlb.convertForViewer",
            );
        };

        this.desktop.logger.info("Starting model viewer conversion", "StaticGlb.convertForViewer");
        const assetPath = await this.getAssetPath();
        const textureSettings = await this.getTextureSettings();
        await fse.ensureDir(this.getTextureCacheDir());
        logTiming("Loaded asset path and texture settings");

        if (typeof input !== "string" && input.artifactRoot && input.state) {
            const session = input.memorySessionId
                ? this.viewerMemorySessions.get(input.memorySessionId)
                : undefined;
            if (input.memorySessionId && !session) {
                throw new Error(`Missing model viewer memory session: ${input.memorySessionId}`);
            }
            const writeMemoryBuffer = async (
                bufferId: string,
                buffer: Buffer,
                options?: { contentType?: string },
            ) => {
                if (!input.memorySessionId) {
                    throw new Error("Missing model viewer memory session.");
                }

                return writeModelViewerMemoryBuffer(
                    input.memorySessionId,
                    bufferId,
                    buffer,
                    options?.contentType,
                );
            };
            const variantModPath = session?.modPath ?? input.modPath ?? input.artifactRoot;
            const [sidecarOverrides, knownBaseColorHashes] = await Promise.all([
                loadSidecarOverrides(variantModPath),
                getKnownBaseColorHashes(),
            ]);
            const result = await resolveVariantStateArtifact({
                artifactRoot: input.artifactRoot,
                artifactBufferWriter: session ? writeMemoryBuffer : undefined,
                manifest: session?.manifest,
                manifestPath: session?.manifestPath ?? input.manifestPath,
                state: input.state,
                assetPath,
                modPath: variantModPath,
                textureFormat: textureSettings.textureFormat,
                jpegQuality: textureSettings.jpegQuality,
                textureMaxDimension: VIEWER_TEXTURE_MAX_DIMENSION,
                textureCacheDir: this.getTextureCacheDir(),
                useTextureCache: true,
                wwmiTextureOverrides: { ...sidecarOverrides, ...input.wwmiTextureOverrides },
                wwmiKnownBaseColorHashes: knownBaseColorHashes,
                logger: this.desktop.logger,
                onWarning: (message) => {
                    this.desktop.logger.warn(message, "StaticGlb.convertForViewer");
                },
            });
            logTiming("Resolved variant state artifact");
            if (session) {
                session.manifest = result.manifest;
                session.manifestPath = result.manifestPath;
            }

            return {
                mode: "variant-set",
                iniPath: result.manifest.iniPath,
                artifactRoot: input.artifactRoot,
                manifestPath: result.manifestPath,
                manifest: result.manifest,
                memorySessionId: input.memorySessionId,
                defaultGlbPath:
                    result.manifest.states.find(
                        (entry) =>
                            entry.key ===
                            createStateKey(result.manifest.defaultState as VariableStateMap),
                    )?.glbPath || result.glbPath,
                activeGlbPath: result.glbPath,
                meshCount: result.meshCount,
                warningCount: result.warningCount,
                name: result.manifest.name,
                modPath: variantModPath,
                wwmiComponents: result.wwmiComponents,
            };
        }

        const modPath = typeof input === "string" ? input : input.modPath;
        if (!modPath) {
            throw new Error("Missing mod path for static GLB viewer conversion.");
        }

        const liveOverrides =
            typeof input === "string" ? undefined : input.wwmiTextureOverrides;
        // Re-render of a WWMI mod with a user-chosen texture override: reuse the
        // existing memory session so the viewer URL swaps in place, and skip the
        // variant-set detection (these mods have no toggles).
        const reuseSessionId =
            typeof input === "string" || !input.memorySessionId
                ? undefined
                : input.memorySessionId;
        const skipVariantDetection = !!liveOverrides;

        // Saved picks (sidecar) seed the base-color choices; live in-session picks
        // take precedence. Globally-learned base-color hashes bias the heuristic.
        const [sidecarOverrides, knownBaseColorHashes] = await Promise.all([
            loadSidecarOverrides(modPath),
            getKnownBaseColorHashes(),
        ]);
        const wwmiTextureOverrides = { ...sidecarOverrides, ...liveOverrides };

        const modName = path.basename(modPath.replace(/[\\/]+$/, ""));
        memorySessionId = reuseSessionId ?? createModelViewerMemorySession();
        const warnings: string[] = [];
        const writeMemoryBuffer = async (
            bufferId: string,
            buffer: Buffer,
            options?: { contentType?: string },
        ) => {
            if (!memorySessionId) {
                throw new Error("Missing model viewer memory session.");
            }

            return writeModelViewerMemoryBuffer(
                memorySessionId,
                bufferId,
                buffer,
                options?.contentType,
            );
        };
        logTiming("Created viewer memory session");

        try {
            const variantResult = skipVariantDetection
                ? null
                : await convertModToVariantArtifacts({
                      modPath,
                      assetPath,
                      artifactRoot: memorySessionId,
                      artifactBufferWriter: writeMemoryBuffer,
                      animationBufferWriter: writeMemoryBuffer,
                      preGenerateVariableStates: false,
                      textureFormat: textureSettings.textureFormat,
                      jpegQuality: textureSettings.jpegQuality,
                      textureMaxDimension: VIEWER_TEXTURE_MAX_DIMENSION,
                      textureCacheDir: this.getTextureCacheDir(),
                      useTextureCache: true,
                      wwmiTextureOverrides,
                      wwmiKnownBaseColorHashes: knownBaseColorHashes,
                      logger: this.desktop.logger,
                      onWarning: (message) => {
                          warnings.push(message);
                          this.desktop.logger.warn(message, "StaticGlb.convertForViewer");
                      },
                  });
            logTiming("Attempted variant artifact conversion");

            if (variantResult) {
                this.viewerMemorySessions.set(memorySessionId, {
                    manifest: variantResult.manifest,
                    manifestPath: variantResult.manifestPath,
                    modPath,
                });
                this.desktop.logger.info(
                    `Completed model viewer conversion in ${Date.now() - startedAt}ms`,
                    "StaticGlb.convertForViewer",
                );
                return {
                    mode: "variant-set",
                    iniPath: variantResult.iniPath,
                    artifactRoot: memorySessionId,
                    manifestPath: variantResult.manifestPath,
                    manifest: variantResult.manifest,
                    memorySessionId,
                    defaultGlbPath: variantResult.defaultGlbPath,
                    activeGlbPath: variantResult.defaultGlbPath,
                    meshCount: variantResult.meshCount,
                    warningCount: variantResult.warningCount,
                    name: modName,
                    modPath,
                    wwmiComponents: variantResult.wwmiComponents,
                };
            }

            const result = await convertModToGlbBuffer({
                modPath,
                assetPath,
                textureFormat: textureSettings.textureFormat,
                jpegQuality: textureSettings.jpegQuality,
                textureMaxDimension: VIEWER_TEXTURE_MAX_DIMENSION,
                textureCacheDir: this.getTextureCacheDir(),
                useTextureCache: true,
                wwmiTextureOverrides,
                wwmiKnownBaseColorHashes: knownBaseColorHashes,
                logger: this.desktop.logger,
                onWarning: (message) => {
                    warnings.push(message);
                    this.desktop.logger.warn(message, "StaticGlb.convertForViewer");
                },
            });
            logTiming("Converted mod to GLB buffer");

            const glbPath = await writeMemoryBuffer(
                `${sanitizeModelViewerFileName(modName)}.glb`,
                result.glb,
                { contentType: "model/gltf-binary" },
            );
            logTiming("Stored GLB buffer");

            if (warnings.length > 0) {
                this.desktop.window.main.window?.webContents.send(
                    "fn:toast",
                    "Model viewer opened with conversion warnings",
                    { description: warnings.slice(0, 3).join("\n") },
                );
            }

            this.desktop.logger.info(
                `Completed model viewer conversion in ${Date.now() - startedAt}ms`,
                "StaticGlb.convertForViewer",
            );
            return {
                mode: "single",
                iniPath: result.iniPath,
                glbPath,
                memorySessionId,
                meshCount: result.meshCount,
                warningCount: result.warningCount,
                name: modName,
                modPath,
                wwmiComponents: result.wwmiComponents,
            };
        } catch (error) {
            cleanupModelViewerMemorySession(memorySessionId);
            if (memorySessionId) {
                this.viewerMemorySessions.delete(memorySessionId);
            }
            this.desktop.logger.error(
                `Model viewer conversion failed after ${Date.now() - startedAt}ms`,
                "StaticGlb.convertForViewer",
            );
            throw error;
        }
    }

    public async checkWwmiTextureConflicts(
        picks: WwmiTexturePick[],
    ): Promise<WwmiTextureConflict[]> {
        return checkConflicts(picks);
    }

    public async saveWwmiTexturePicks(input: {
        modPath: string;
        picks: WwmiTexturePick[];
        global: boolean;
        resolutions?: Record<string, WwmiTextureConflictResolution>;
    }): Promise<void> {
        const sourceMod = path.basename(input.modPath.replace(/[\\/]+$/, ""));
        await savePicks({ ...input, sourceMod });
    }

    public async precacheModTextures(
        modPath: string,
    ): Promise<{ prepared: number; total: number }> {
        const cacheDir = this.getTextureCacheDir();
        await fse.ensureDir(cacheDir);
        const settings = await this.getTextureSettings();
        const result = await precacheModTextures({
            modPath,
            textureCacheDir: cacheDir,
            textureFormat: settings.textureFormat,
            jpegQuality: settings.jpegQuality,
            textureMaxDimension: VIEWER_TEXTURE_MAX_DIMENSION,
            concurrency: Math.max(1, os.availableParallelism()),
            logger: this.desktop.logger,
            onProgress: (done, total) => {
                this.desktop.window.main.window?.webContents.send("tools:wwmiPrecacheProgress", {
                    modPath,
                    done,
                    total,
                });
            },
        });
        await this.trimTextureCache();
        return result;
    }

    public async clearModTextureCache(modPath: string): Promise<number> {
        return clearModTextureCache({ modPath, textureCacheDir: this.getTextureCacheDir() });
    }

    private async trimTextureCache(maxBytes = TEXTURE_CACHE_MAX_BYTES): Promise<void> {
        const cacheDir = this.getTextureCacheDir();
        const entries = await fse.readdir(cacheDir, { withFileTypes: true }).catch(() => []);
        const files = (
            await Promise.all(
                entries
                    .filter((entry) => entry.isFile())
                    .map(async (entry) => {
                        const filePath = path.join(cacheDir, entry.name);
                        const stat = await fse.stat(filePath).catch(() => null);
                        return stat ? { filePath, size: stat.size, mtimeMs: stat.mtimeMs } : null;
                    }),
            )
        ).filter((file): file is { filePath: string; size: number; mtimeMs: number } => file !== null);

        let total = files.reduce((sum, file) => sum + file.size, 0);
        if (total <= maxBytes) {
            return;
        }

        files.sort((left, right) => left.mtimeMs - right.mtimeMs); // evict oldest first
        for (const file of files) {
            if (total <= maxBytes) {
                break;
            }
            await fse.remove(file.filePath).catch(() => {});
            total -= file.size;
        }
    }

    public async cleanupViewerFile(targetPath: string, memorySessionId?: string): Promise<void> {
        cleanupModelViewerMemorySession(memorySessionId);
        if (memorySessionId) {
            this.viewerMemorySessions.delete(memorySessionId);
        }
        if (!targetPath) {
            return;
        }

        if (targetPath.startsWith("model-viewer-memory://") || targetPath === memorySessionId) {
            return;
        }

        const resolvedPath = path.resolve(targetPath);
        const tempRoot = path.resolve(app.getPath("temp"));

        if (!resolvedPath.startsWith(tempRoot + path.sep)) {
            this.desktop.logger.warn(
                `Skipped cleanup for non-temp model viewer artifact: ${resolvedPath}`,
                "StaticGlb.cleanupViewerFile",
            );
            return;
        }

        const viewerTempDir = (await fse.stat(resolvedPath).catch(() => null))?.isDirectory()
            ? resolvedPath
            : path.dirname(resolvedPath);
        const viewerTempDirName = path.basename(viewerTempDir);

        if (!viewerTempDirName.startsWith(MODEL_VIEWER_TEMP_PREFIX)) {
            this.desktop.logger.warn(
                `Skipped cleanup for unexpected model viewer temp directory: ${viewerTempDir}`,
                "StaticGlb.cleanupViewerFile",
            );
            return;
        }

        await fse.remove(viewerTempDir).catch((error) => {
            this.desktop.logger.warn(
                `Failed to remove model viewer temp directory: ${
                    error instanceof Error ? error.message : String(error)
                }`,
                "StaticGlb.cleanupViewerFile",
            );
        });
    }

    private async cleanupStaleViewerTempDirs(): Promise<void> {
        const tempRoot = path.resolve(app.getPath("temp"));
        const tempEntries = await fse.readdir(tempRoot, { withFileTypes: true }).catch((error) => {
            this.desktop.logger.warn(
                `Failed to read temp directory for model viewer cleanup: ${
                    error instanceof Error ? error.message : String(error)
                }`,
                "StaticGlb.cleanupStaleViewerTempDirs",
            );
            return [];
        });

        await Promise.all(
            tempEntries
                .filter(
                    (entry) =>
                        entry.isDirectory() && entry.name.startsWith(MODEL_VIEWER_TEMP_PREFIX),
                )
                .map((entry) =>
                    this.cleanupViewerFile(path.join(tempRoot, entry.name, "stale.glb")),
                ),
        );
    }

    private async getSettingValue(key: string): Promise<string | null> {
        return await this.desktop.lib.db.settings.getValue(key);
    }

    private async saveSettingValue(key: string, value: string): Promise<void> {
        await this.desktop.lib.db.settings.upsert(key, value);
    }
}

function ensureGlbExtension(filePath: string): string {
    if (path.extname(filePath).toLowerCase() === ".glb") {
        return filePath;
    }

    return `${filePath}.glb`;
}

function stripGlbExtension(filePath: string): string {
    return path.extname(filePath).toLowerCase() === ".glb"
        ? filePath.slice(0, -path.extname(filePath).length)
        : filePath;
}

function sanitizeModelViewerFileName(name: string): string {
    const sanitized = Array.from(name, (char) => {
        const codePoint = char.codePointAt(0) ?? 0;
        const isControlCharacter = codePoint <= 0x1f;
        const isReservedCharacter = '<>:"/\\|?*'.includes(char);
        return isControlCharacter || isReservedCharacter ? "_" : char;
    })
        .join("")
        .trim();

    return sanitized || "model-viewer";
}

function normalizeTextureFormat(value?: string | null): StaticGlbTextureFormat {
    if (value === "png" || value === "jpeg-safe" || value === "jpeg-force") {
        return value;
    }

    return DEFAULT_TEXTURE_FORMAT;
}

function normalizeJpegQuality(value?: string | number | null): number {
    const parsed =
        typeof value === "number"
            ? value
            : typeof value === "string"
              ? Number.parseInt(value, 10)
              : Number.NaN;

    if (!Number.isFinite(parsed)) {
        return DEFAULT_JPEG_QUALITY;
    }

    return Math.max(1, Math.min(100, Math.round(parsed)));
}
