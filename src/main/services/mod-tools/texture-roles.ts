import path from "node:path";
import { app } from "electron";
import fse from "fs-extra";
import writeFileAtomic from "write-file-atomic";

// Persistence for WWMI base-color texture picks. The diffuse slot can't be
// recovered from an exported mod, so picks are stored two ways, both keyed by the
// stable game texture hash (`t=<hash>` in the filename):
//   - a per-mod sidecar (wwmm2.json in the mod folder) for this mod's exact picks
//   - a global table (userData/wwmi-texture-roles.json) that records which hashes
//     are base colors, used as a soft prior to improve auto-pick over time.
// Both are human-readable JSON written atomically.

const SIDECAR_FILE_NAME = "wwmm2.json";
const GLOBAL_FILE_NAME = "wwmi-texture-roles.json";
const SCHEMA_VERSION = 1;

export type WwmiTexturePick = {
    componentIndex: number;
    hash: string;
    candidateHashes: string[];
    vertexCount: number;
    // True only for picks the user explicitly chose. The sidecar records every
    // part, but the global table learns only from confirmed picks so heuristic
    // guesses never pollute the shared data.
    confirmed?: boolean;
    // Per-part opt-in for the global table. Defaults to the save-wide `global`
    // flag when undefined, letting the user keep specific parts local.
    global?: boolean;
};

export type WwmiTextureConflictResolution = "use-new" | "keep-old" | "keep-both";

export type WwmiTextureConflict = {
    componentIndex: number;
    chosenHash: string;
    existingHash: string;
    sourceMod: string;
    sourceSize?: number;
    newSize: number;
};

type GlobalRoleEntry = {
    role: "baseColor";
    sourceMod: string;
    date: string;
    sourceSize?: number;
};

type GlobalRoleFile = {
    version: number;
    roles: Record<string, GlobalRoleEntry>;
};

type SidecarFile = {
    version: number;
    textureOverrides: Record<string, string>;
};

let globalCache: GlobalRoleFile | null = null;

function normalizeHash(hash: string): string {
    return hash.trim().toLowerCase();
}

function globalFilePath(): string {
    return path.join(app.getPath("userData"), GLOBAL_FILE_NAME);
}

function sidecarPath(modPath: string): string {
    return path.join(modPath, SIDECAR_FILE_NAME);
}

async function loadGlobal(): Promise<GlobalRoleFile> {
    if (globalCache) {
        return globalCache;
    }
    try {
        const parsed = (await fse.readJson(globalFilePath())) as Partial<GlobalRoleFile>;
        globalCache = { version: SCHEMA_VERSION, roles: parsed.roles ?? {} };
    } catch {
        globalCache = { version: SCHEMA_VERSION, roles: {} };
    }
    return globalCache;
}

async function saveGlobal(file: GlobalRoleFile): Promise<void> {
    globalCache = file;
    await writeFileAtomic(globalFilePath(), `${JSON.stringify(file, null, 2)}\n`);
}

export async function getKnownBaseColorHashes(): Promise<string[]> {
    const file = await loadGlobal();
    return Object.entries(file.roles)
        .filter(([, entry]) => entry.role === "baseColor")
        .map(([hash]) => hash);
}

export async function loadSidecarOverrides(modPath: string): Promise<Record<string, string>> {
    try {
        const parsed = (await fse.readJson(sidecarPath(modPath))) as Partial<SidecarFile>;
        const overrides = parsed.textureOverrides ?? {};
        return Object.fromEntries(
            Object.entries(overrides).map(([index, hash]) => [index, normalizeHash(String(hash))]),
        );
    } catch {
        return {};
    }
}

async function saveSidecarOverrides(
    modPath: string,
    picks: WwmiTexturePick[],
): Promise<void> {
    const textureOverrides: Record<string, string> = {};
    for (const pick of picks) {
        textureOverrides[String(pick.componentIndex)] = normalizeHash(pick.hash);
    }
    const file: SidecarFile = { version: SCHEMA_VERSION, textureOverrides };
    await writeFileAtomic(sidecarPath(modPath), `${JSON.stringify(file, null, 2)}\n`);
}

// A conflict is a part where the user's chosen hash differs from a *different*
// candidate hash that is already globally marked as a base color — saving would
// leave two base-color claims that collide on future mods sharing both textures.
export async function checkConflicts(picks: WwmiTexturePick[]): Promise<WwmiTextureConflict[]> {
    const file = await loadGlobal();
    const conflicts: WwmiTextureConflict[] = [];
    for (const pick of picks) {
        if (!pick.confirmed || pick.global === false) {
            continue; // only confirmed, global-bound picks reach the table, so only they can conflict
        }
        const chosen = normalizeHash(pick.hash);
        const existing = pick.candidateHashes
            .map(normalizeHash)
            .find((hash) => hash !== chosen && file.roles[hash]?.role === "baseColor");
        if (!existing) {
            continue;
        }
        const entry = file.roles[existing];
        conflicts.push({
            componentIndex: pick.componentIndex,
            chosenHash: chosen,
            existingHash: existing,
            sourceMod: entry.sourceMod,
            sourceSize: entry.sourceSize,
            newSize: pick.vertexCount,
        });
    }
    return conflicts;
}

// Always writes the sidecar. Writes the global table only for picks that opt in
// (global=true), honoring per-conflict resolutions keyed by component index.
export async function savePicks(input: {
    modPath: string;
    sourceMod: string;
    picks: WwmiTexturePick[];
    global: boolean;
    resolutions?: Record<string, WwmiTextureConflictResolution>;
}): Promise<void> {
    await saveSidecarOverrides(input.modPath, input.picks);

    // A pick is global-bound when its own flag opts in, falling back to the
    // save-wide master flag when the pick doesn't specify one.
    const isGlobalPick = (pick: WwmiTexturePick) =>
        pick.confirmed === true && (pick.global ?? input.global);
    if (!input.picks.some(isGlobalPick)) {
        return;
    }

    const file = await loadGlobal();
    const roles = { ...file.roles };
    const conflicts = await checkConflicts(input.picks);
    const conflictByIndex = new Map(conflicts.map((conflict) => [conflict.componentIndex, conflict]));
    const resolutions = input.resolutions ?? {};

    for (const pick of input.picks) {
        if (!isGlobalPick(pick)) {
            continue; // sidecar already saved above; global learns only confirmed, opted-in picks
        }
        const chosen = normalizeHash(pick.hash);
        const conflict = conflictByIndex.get(pick.componentIndex);
        const resolution = conflict
            ? (resolutions[String(pick.componentIndex)] ?? "use-new")
            : "use-new";

        if (conflict && resolution === "keep-old") {
            continue; // pick stays in the sidecar only
        }
        if (conflict && resolution === "use-new") {
            delete roles[conflict.existingHash]; // user asserts the old global was wrong here
        }
        // "use-new" (no conflict), "use-new" (resolved) and "keep-both" all record the chosen hash
        roles[chosen] = {
            role: "baseColor",
            sourceMod: input.sourceMod,
            date: new Date().toISOString(),
            sourceSize: pick.vertexCount,
        };
    }

    await saveGlobal({ version: SCHEMA_VERSION, roles });
}
