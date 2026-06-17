import path from "node:path";
import fse from "fs-extra";
import { GlbBuilder } from "./builder";
import { loadFmtForIbCached, loadIndicesForIbCached } from "./fmt-loader";
import { buildPrimitive } from "./geometry";
import { loadIniBundle } from "./ini-loader";
import { buildMaterials } from "./material";
import { bestKeyForIb, keyMatchesIb, strictKeyMatchesIb } from "./mesh-key";
import * as overrideAnalysis from "./override-analysis";
import { evaluateIniCondition } from "./ini-expression";
import {
    collectMihoyoBufferGroups,
    collectResources,
    collectWwmiBufferGroups,
    collectWwmiTextureResources,
    detectStaticGlbModLayout,
} from "./resource-loader";
import { createWarningCollector, normalizeKey } from "./shared";
import type {
    BufferGroup,
    ConvertModToGlbBufferOptions,
    ConvertModToGlbBufferResult,
    FmtLayout,
    IbResource,
    IniSection,
    Resource,
    StaticGlbBuildContext,
    TextureBinding,
    TextureOverrideBinding,
    WwmiComponentTextureInfo,
    WwmiTextureResource,
} from "./types";

export async function prepareStaticGlbBuildContext(
    options: Pick<ConvertModToGlbBufferOptions, "modPath" | "assetPath">,
    warn: (message: string) => void,
): Promise<StaticGlbBuildContext> {
    const { iniPath, sections } = await loadIniBundle(options.modPath);
    const modDir = path.dirname(iniPath);
    const defaultVariables = overrideAnalysis.collectDefaultIniVariables(sections);
    const resources = collectResources(sections);
    const layout = detectStaticGlbModLayout(sections, resources);
    const sectionByFullName = new Map(
        sections.map((section) => [
            normalizeKey(overrideAnalysis.getSectionFullName(section)),
            section,
        ]),
    );
    const bufferGroups =
        layout === "wwmi"
            ? await collectWwmiBufferGroups(modDir, resources, warn)
            : await collectMihoyoBufferGroups(modDir, resources, warn);

    const drawBindings = overrideAnalysis.collectTextureOverrideDrawBindings(sections);

    return {
        iniPath,
        sections,
        modDir,
        defaultVariables,
        resources,
        layout,
        sectionByFullName,
        bufferGroups,
        drawBindings,
        drawBindingsByIbName: groupDrawBindingsByIbName(drawBindings),
        fmtByIbKey: new Map(),
        indicesByIbKey: new Map(),
    };
}

export async function buildModGlb(
    options: ConvertModToGlbBufferOptions,
): Promise<ConvertModToGlbBufferResult> {
    const warning = createWarningCollector(options.onWarning);
    const context = await prepareStaticGlbBuildContext(options, warning.warn);

    if (context.layout === "wwmi") {
        const wwmiResult = await buildWwmiComponentGlb(context, options, warning);
        if (wwmiResult) {
            return wwmiResult;
        }
    }

    const resolvedVariables = overrideAnalysis.mergeVariableState(
        context.defaultVariables,
        options.variableState,
    );
    const textureBindings = overrideAnalysis.collectTextureBindings(
        context.sections,
        context.sectionByFullName,
        resolvedVariables,
    );
    const ibResources = collectIbResources(
        context.sections,
        context.resources,
        context.bufferGroups,
        context.sectionByFullName,
        resolvedVariables,
        textureBindings,
        context.drawBindings,
    );

    options.logger?.debug(
        `Detected ${context.layout} layout with ${context.resources.length} resources, ${context.bufferGroups.length} buffer groups, ${ibResources.length} IB resources, ${textureBindings.length} texture bindings`,
        "StaticGLB",
    );

    if (ibResources.length === 0) {
        throw new Error(`No index buffer Resource sections were found in ${context.iniPath}`);
    }

    const builder = new GlbBuilder();
    const materialBindings = await buildMaterials(
        builder,
        options,
        context.modDir,
        options.textureCacheDir,
        context.resources,
        textureBindings,
        warning.warn,
    );

    for (const ib of ibResources) {
        const group =
            context.bufferGroups.find((candidate) => strictKeyMatchesIb(candidate.key, ib.key)) ||
            context.bufferGroups.find((candidate) => keyMatchesIb(candidate.key, ib.key));
        if (!group) {
            warning.warn(`No matching vertex buffer found for ${ib.filename}`);
            continue;
        }

        let fmt: FmtLayout;
        try {
            fmt = await loadFmtForIbCached(context, options.assetPath, ib, group.stride, group);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            warning.warn(`Skipping ${ib.filename}: ${message}`);
            continue;
        }
        const ibPath = path.resolve(context.modDir, ib.filename);
        if (!(await fse.pathExists(ibPath))) {
            warning.warn(`Missing IB file: ${ibPath}`);
            continue;
        }

        const indices = await loadIndicesForIbCached(context, ib, ib.format || fmt.indexFormat);
        if (indices.length === 0) {
            warning.warn(`Empty IB file: ${ibPath}`);
            continue;
        }
        const activeIndices = overrideAnalysis.buildIndicesForState(
            getDrawBindingsForIb(context, ib.name),
            indices,
            resolvedVariables,
            warning.warn,
        );

        const material = materialBindings.get(normalizeKey(ib.name));
        const primitive = buildPrimitive(
            builder,
            group.vbBytes,
            group.stride,
            fmt,
            activeIndices,
            {
                includeTangents: !!options.includeTangents,
                includeVertexColors: !material,
            },
            warning.warn,
        );
        if (!primitive) {
            warning.warn(`Could not build primitive for ${ib.filename}`);
            continue;
        }

        if (material) {
            primitive.material = material.materialIndex;
        }

        builder.addMesh(path.basename(ib.filename, path.extname(ib.filename)), primitive);
    }

    if (builder.meshCount() === 0) {
        throw new Error(
            "No mesh primitives were written. Check that mod resources match asset layout files.",
        );
    }

    return {
        iniPath: context.iniPath,
        glb: builder.toGlb(),
        meshCount: builder.meshCount(),
        warningCount: warning.count,
    };
}

// WWMI mods draw a single shared vertex/index buffer as a series of components,
// binding each component's textures at runtime via `CheckTextureOverride`. That
// runtime dispatch can't be resolved statically, so instead we split the index
// buffer into one primitive per component (by its `drawindexed` range) and map
// each component to its textures through the `Components-{list} t={hash}` file
// naming. The diffuse for each component is chosen by the content-based texture
// scorer in buildMaterials. Returns null to fall back to the generic path.
async function buildWwmiComponentGlb(
    context: StaticGlbBuildContext,
    options: ConvertModToGlbBufferOptions,
    warning: ReturnType<typeof createWarningCollector>,
): Promise<ConvertModToGlbBufferResult | null> {
    const components = resolveWwmiComponents(context, options);
    if (components.length === 0) {
        return null;
    }

    const group = context.bufferGroups[0];
    if (!group) {
        warning.warn("No WWMI vertex buffer group found");
        return null;
    }

    const ibResource = context.resources.find(
        (resource) => resource.filename && /IndexBuffer$/i.test(resource.name),
    );
    if (!ibResource?.filename || !ibResource.format) {
        warning.warn("No WWMI index buffer resource found");
        return null;
    }

    const ib: IbResource = {
        name: ibResource.name,
        filename: ibResource.filename,
        format: ibResource.format,
        key: group.key,
    };

    let fmt: FmtLayout;
    try {
        fmt = await loadFmtForIbCached(context, options.assetPath, ib, group.stride, group);
    } catch (error) {
        warning.warn(
            `Could not resolve WWMI vertex format: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        return null;
    }

    const allIndices = await loadIndicesForIbCached(context, ib, ib.format || fmt.indexFormat);
    if (allIndices.length === 0) {
        warning.warn(`Empty WWMI index buffer: ${ibResource.filename}`);
        return null;
    }

    const textureResources = collectWwmiTextureResources(context.resources);
    const overrides = options.wwmiTextureOverrides ?? {};
    const knownBaseColorHashes = new Set(
        (options.wwmiKnownBaseColorHashes ?? []).map((hash) => hash.toLowerCase()),
    );
    const hashByResourceName = new Map(
        textureResources.flatMap((texture) =>
            texture.hash ? [[texture.resourceName, texture.hash] as const] : [],
        ),
    );
    const textureBindings = buildWwmiComponentTextureBindings(
        components.map((component) => component.index),
        textureResources,
        overrides,
        knownBaseColorHashes,
    );

    const builder = new GlbBuilder();
    const materialByComponent = await buildMaterials(
        builder,
        options,
        context.modDir,
        options.textureCacheDir,
        context.resources,
        textureBindings,
        warning.warn,
    );

    const wwmiComponents: WwmiComponentTextureInfo[] = [];

    for (const component of components) {
        // A component is one or more sub-draws (merged objects / toggled parts);
        // concatenate the index ranges that are active in the current state.
        const indices = concatWwmiDrawRanges(allIndices, component.draws);
        if (indices.length === 0) {
            continue;
        }

        const material = materialByComponent.get(normalizeKey(`Component${component.index}`));
        const primitive = buildPrimitive(
            builder,
            group.vbBytes,
            group.stride,
            fmt,
            indices,
            {
                includeTangents: !!options.includeTangents,
                includeVertexColors: false,
                compactVertices: true,
            },
            warning.warn,
        );
        if (!primitive) {
            warning.warn(`Could not build primitive for WWMI Component${component.index}`);
            continue;
        }
        if (material) {
            primitive.material = material.materialIndex;
        }
        const meshName = `Component${component.index}`;
        builder.addMesh(meshName, primitive);

        wwmiComponents.push({
            index: component.index,
            meshName,
            vertexCount: new Set(indices).size,
            selectedResourceName: material?.textureResourceName,
            selectedHash: material?.textureResourceName
                ? hashByResourceName.get(material.textureResourceName)
                : undefined,
            candidates: textureResources
                .filter((texture) => texture.components.includes(component.index))
                .map((texture) => ({
                    resourceName: texture.resourceName,
                    filename: path.basename(texture.filename),
                    hash: texture.hash,
                })),
        });
    }

    if (builder.meshCount() === 0) {
        return null;
    }

    options.logger?.debug(
        `WWMI component build: ${builder.meshCount()} components rendered, ${materialByComponent.size} materials, ${textureResources.length} texture resources`,
        "StaticGLB",
    );

    return {
        iniPath: context.iniPath,
        glb: builder.toGlb(),
        meshCount: builder.meshCount(),
        warningCount: warning.count,
        wwmiComponents,
    };
}

type ResolvedWwmiComponent = {
    index: number;
    draws: Array<{ indexCount: number; startIndex: number; baseVertex: number }>;
};

// Resolves which sub-draws of each WWMI component are visible in the current
// state. The runtime gates (`$mod_enabled`, `ResourceMergedSkeleton !== null`)
// only become true in-game, so we force them true for the viewer; per-object
// `$draw_*` toggles are derived from the swap vars by running the mod's
// CommandListProcessToggles, then each draw's condition chain is evaluated.
function resolveWwmiComponents(
    context: StaticGlbBuildContext,
    options: ConvertModToGlbBufferOptions,
): ResolvedWwmiComponent[] {
    const variables = overrideAnalysis.mergeVariableState(
        context.defaultVariables,
        options.variableState,
    );
    const runtimeValues: Record<string, number> = {
        [normalizeKey("$mod_enabled")]: 1,
        [normalizeKey("$object_detected")]: 1,
        [normalizeKey("ResourceMergedSkeleton")]: 1,
        [normalizeKey("ResourceExtraMergedSkeleton")]: 1,
    };
    applyWwmiToggleLogic(context.sectionByFullName, variables, runtimeValues);

    const components: ResolvedWwmiComponent[] = [];
    for (const section of context.sections) {
        if (section.header !== "TextureOverride") continue;
        const match = section.name.match(/^Component(\d+)$/i);
        if (!match) continue;

        const draws = overrideAnalysis
            .collectSectionDrawInstructions(section, variables, context.sectionByFullName)
            .filter(
                (draw) =>
                    !draw.condition ||
                    draw.condition.every(
                        (clause) =>
                            evaluateIniCondition(
                                clause.expression,
                                variables,
                                normalizeKey,
                                runtimeValues,
                            ) === clause.expected,
                    ),
            )
            .filter((draw) => draw.indexCount > 0)
            .map((draw) => ({
                indexCount: draw.indexCount,
                startIndex: draw.startIndex,
                baseVertex: draw.baseVertex,
            }));

        if (draws.length > 0) {
            components.push({ index: Number(match[1]), draws });
        }
    }

    return components.sort((left, right) => left.index - right.index);
}

// Executes a WWMI toggle command list (`$draw_* = (<swapvar expr>)`) so the
// derived per-object visibility vars reflect the active swap-var state.
function applyWwmiToggleLogic(
    sectionByFullName: Map<string, IniSection>,
    variables: Map<string, number | string>,
    runtimeValues: Record<string, number | string>,
): void {
    const section = sectionByFullName.get(normalizeKey("CommandListProcessToggles"));
    if (!section) return;
    for (const line of section.lines) {
        const match = line.trim().match(/^(\$[\w\\.]+)\s*=\s*(.+)$/);
        if (!match) continue;
        variables.set(
            normalizeKey(match[1]),
            evaluateIniCondition(match[2], variables, normalizeKey, runtimeValues) ? 1 : 0,
        );
    }
}

function concatWwmiDrawRanges(
    allIndices: Uint32Array,
    draws: ResolvedWwmiComponent["draws"],
): Uint32Array {
    const total = draws.reduce(
        (sum, draw) =>
            sum + Math.max(0, Math.min(draw.startIndex + draw.indexCount, allIndices.length) - draw.startIndex),
        0,
    );
    const indices = new Uint32Array(total);
    let offset = 0;
    for (const draw of draws) {
        const end = Math.min(draw.startIndex + draw.indexCount, allIndices.length);
        for (let i = draw.startIndex; i < end; i++) {
            indices[offset++] = allIndices[i] + draw.baseVertex;
        }
    }
    return offset === total ? indices : indices.subarray(0, offset);
}

function buildWwmiComponentTextureBindings(
    componentIndices: number[],
    textureResources: WwmiTextureResource[],
    overrides: Record<string, string>,
    knownBaseColorHashes: Set<string>,
): TextureBinding[] {
    return componentIndices.map((index) => {
        const ibResourceName = `Component${index}`;
        const matching = textureResources.filter((texture) => texture.components.includes(index));
        if (matching.length === 0) {
            return { ibResourceName, textureResourceNames: [] };
        }

        // (1) A saved/user pick (by texture hash) hard-forces the base color.
        const overrideHash = overrides[String(index)]?.toLowerCase();
        const overridden = overrideHash
            ? matching.find((texture) => texture.hash?.toLowerCase() === overrideHash)
            : undefined;
        if (overridden) {
            return { ibResourceName, textureResourceNames: [overridden.resourceName] };
        }

        // (2) Soft prior: if exactly one candidate is globally known to be a base
        // color, trust it. Ambiguity (zero or several) falls through to heuristic.
        const knownGood = matching.filter(
            (texture) => texture.hash && knownBaseColorHashes.has(texture.hash.toLowerCase()),
        );
        if (knownGood.length === 1) {
            return { ibResourceName, textureResourceNames: [knownGood[0].resourceName] };
        }

        // (3) Heuristic: let the content-based scorer (sRGB + opaque coverage)
        // choose among ALL candidates — a part's diffuse is often a shared atlas,
        // so we must not pre-exclude shared textures. Component-specificity is
        // only a tiebreak (most-specific first) for otherwise-equal scores.
        return {
            ibResourceName,
            textureResourceNames: [...matching]
                .sort((left, right) => left.components.length - right.components.length)
                .map((texture) => texture.resourceName),
        };
    });
}

export function collectIbResources(
    sections: IniSection[],
    resources: Resource[],
    bufferGroups: BufferGroup[],
    sectionByFullName: Map<string, IniSection>,
    resolvedVariables: Map<string, number | string>,
    textureBindings: TextureBinding[],
    drawBindings: TextureOverrideBinding[],
): IbResource[] {
    const bufferKeys = bufferGroups.map((group) => group.key);
    const bindingsByIbName = new Map<string, TextureBinding[]>();
    for (const binding of textureBindings) {
        const key = normalizeKey(binding.ibResourceName);
        const group = bindingsByIbName.get(key) ?? [];
        group.push(binding);
        bindingsByIbName.set(key, group);
    }
    const drawBindingsByIbName = new Map<string, TextureOverrideBinding[]>();
    for (const binding of drawBindings) {
        const key = normalizeKey(binding.ibResourceName);
        const group = drawBindingsByIbName.get(key) ?? [];
        group.push(binding);
        drawBindingsByIbName.set(key, group);
    }
    const referencedIbNames = new Set([
        ...bindingsByIbName.keys(),
        ...drawBindings.map((binding) => normalizeKey(binding.ibResourceName)),
    ]);
    const activeIbNames = new Set(
        sections
            .filter((section) => section.header === "TextureOverride")
            .map((section) =>
                overrideAnalysis
                    .resolveAssignmentFromSection(
                        section,
                        ["ib"],
                        sectionByFullName,
                        resolvedVariables,
                    )
                    .get("ib"),
            )
            .filter((value): value is string => !!value)
            .map(overrideAnalysis.trimResourcePrefix)
            .map(normalizeKey),
    );

    return resources
        .filter((resource) => {
            if (!resource.filename || !resource.format) return false;

            const lowerFilename = resource.filename.toLowerCase();
            if (lowerFilename.endsWith(".ib")) {
                return activeIbNames.size === 0 || activeIbNames.has(normalizeKey(resource.name));
            }

            return referencedIbNames.has(normalizeKey(resource.name));
        })
        .map((resource) => {
            const stem = path.basename(resource.filename!, path.extname(resource.filename!));
            const key = bestKeyForIb(stem, resource.name, bufferKeys);
            const bindings = bindingsByIbName.get(normalizeKey(resource.name)) ?? [];
            const linkedDrawBindings = drawBindingsByIbName.get(normalizeKey(resource.name)) ?? [];
            const overrideHashes = Array.from(
                new Set(
                    [...bindings, ...linkedDrawBindings]
                        .map((binding) => binding.overrideHash?.trim())
                        .filter((value): value is string => !!value),
                ),
            );
            return {
                name: resource.name,
                filename: resource.filename!,
                format: resource.format!,
                key,
                overrideHash: overrideHashes[0],
                overrideHashes,
            };
        });
}

export function groupDrawBindingsByIbName(
    bindings: TextureOverrideBinding[],
): Map<string, TextureOverrideBinding[]> {
    const output = new Map<string, TextureOverrideBinding[]>();
    for (const binding of bindings) {
        const key = normalizeKey(binding.ibResourceName);
        const existing = output.get(key);
        if (existing) {
            existing.push(binding);
        } else {
            output.set(key, [binding]);
        }
    }
    return output;
}

export function getDrawBindingsForIb(
    context: StaticGlbBuildContext,
    ibName: string,
): TextureOverrideBinding[] {
    return context.drawBindingsByIbName.get(normalizeKey(ibName)) ?? [];
}
