import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import fse from "fs-extra";
import StreamZip from "node-stream-zip";
import type { WWMM2App } from "..";

const execAsync = promisify(exec);

interface ExtractOptions {
    flattenSingleRoot?: boolean;
}

const IGNORED_NAMES = new Set(["desktop.ini", "thumbs.db"]);

function isIgnored(name: string) {
    return IGNORED_NAMES.has(name.toLowerCase());
}

function getUniquePath(dir: string, name: string): string {
    let target = path.join(dir, name);
    let counter = 2;
    while (fse.pathExistsSync(target)) {
        target = path.join(dir, `${name} (${counter++})`);
    }
    return target;
}

async function extractZip(
    archivePath: string,
    targetDir: string,
    flattenSingleRoot: boolean,
    onProgress?: (percent: number, message: string) => void,
): Promise<string> {
    const zip = new StreamZip.async({ file: archivePath });

    try {
        const tempDir = path.join(targetDir, `.extract_temp_${Date.now()}_${process.pid}`);
        await fse.ensureDir(tempDir);

        onProgress?.(1, "Starting extraction");

        const count = await zip.extract(null, tempDir);
        onProgress?.(90, `Extracted ${count} files`);

        // Resolve flattening
        let contentDir = tempDir;
        let folderName = path.basename(archivePath, path.extname(archivePath));

        if (flattenSingleRoot) {
            const topEntries = (await fse.readdir(tempDir)).filter((e) => !isIgnored(e));
            if (topEntries.length === 1) {
                const candidatePath = path.join(tempDir, topEntries[0]);
                const stat = await fse.stat(candidatePath);
                if (stat.isDirectory()) {
                    contentDir = candidatePath;
                    folderName = topEntries[0];
                }
            }
        }

        onProgress?.(95, "Moving extracted contents");

        const targetPath = getUniquePath(targetDir, folderName);
        await fse.move(contentDir, targetPath);
        await fse.remove(tempDir).catch(() => {});

        onProgress?.(100, "Done");
        return targetPath;
    } finally {
        await zip.close();
    }
}

async function findUnrar(): Promise<string | null> {
    const candidates = [
        "C:\\Program Files\\WinRAR\\UnRAR.exe",
        "C:\\Program Files (x86)\\WinRAR\\UnRAR.exe",
    ];
    for (const p of candidates) {
        if (await fse.pathExists(p)) return p;
    }
    // Try PATH
    try {
        await execAsync("UnRAR.exe /?");
        return "UnRAR.exe";
    } catch {
        return null;
    }
}

async function extractRar(
    archivePath: string,
    targetDir: string,
    flattenSingleRoot: boolean,
    onProgress?: (percent: number, message: string) => void,
): Promise<string> {
    const unrar = await findUnrar();
    if (!unrar) {
        throw new Error("RAR extraction requires WinRAR. Install WinRAR to extract .rar files.");
    }

    const tempDir = path.join(targetDir, `.extract_temp_${Date.now()}_${process.pid}`);
    await fse.ensureDir(tempDir);

    try {
        onProgress?.(1, "Starting extraction");
        await execAsync(`"${unrar}" x -y "${archivePath}" "${tempDir}\\"`);
        onProgress?.(90, "Extraction complete");

        let contentDir = tempDir;
        let folderName = path.basename(archivePath, path.extname(archivePath));

        if (flattenSingleRoot) {
            const topEntries = (await fse.readdir(tempDir)).filter((e) => !isIgnored(e));
            if (topEntries.length === 1) {
                const candidatePath = path.join(tempDir, topEntries[0]);
                const stat = await fse.stat(candidatePath);
                if (stat.isDirectory()) {
                    contentDir = candidatePath;
                    folderName = topEntries[0];
                }
            }
        }

        onProgress?.(95, "Moving extracted contents");
        const targetPath = getUniquePath(targetDir, folderName);
        await fse.move(contentDir, targetPath);
        await fse.remove(tempDir).catch(() => {});

        onProgress?.(100, "Done");
        return targetPath;
    } catch (err) {
        await fse.remove(tempDir).catch(() => {});
        throw err;
    }
}

async function findSevenZip(): Promise<string | null> {
    const candidates = [
        "C:\\Program Files\\7-Zip\\7z.exe",
        "C:\\Program Files (x86)\\7-Zip\\7z.exe",
    ];
    for (const p of candidates) {
        if (await fse.pathExists(p)) return p;
    }
    // Try PATH (7z or the standalone 7za)
    for (const name of ["7z.exe", "7za.exe"]) {
        try {
            await execAsync(`${name} i`);
            return name;
        } catch {
            // not on PATH
        }
    }
    return null;
}

// Windows' built-in bsdtar (libarchive) can read .7z, so this is always available
// as a fallback when a real 7-Zip install is not present. Resolve it explicitly to
// avoid picking up GNU tar from the PATH (Git/MSYS), which cannot extract .7z.
async function findBsdtar(): Promise<string | null> {
    const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    const tarPath = path.join(systemRoot, "System32", "tar.exe");
    return (await fse.pathExists(tarPath)) ? tarPath : null;
}

async function extract7z(
    archivePath: string,
    targetDir: string,
    flattenSingleRoot: boolean,
    onProgress?: (percent: number, message: string) => void,
): Promise<string> {
    const sevenZip = await findSevenZip();
    const bsdtar = sevenZip ? null : await findBsdtar();
    if (!sevenZip && !bsdtar) {
        throw new Error("7z extraction requires 7-Zip. Install 7-Zip to extract .7z files.");
    }

    const tempDir = path.join(targetDir, `.extract_temp_${Date.now()}_${process.pid}`);
    await fse.ensureDir(tempDir);

    try {
        onProgress?.(1, "Starting extraction");
        const command = sevenZip
            ? `"${sevenZip}" x -y -o"${tempDir}" "${archivePath}"`
            : `"${bsdtar}" -xf "${archivePath}" -C "${tempDir}"`;
        await execAsync(command);
        onProgress?.(90, "Extraction complete");

        let contentDir = tempDir;
        let folderName = path.basename(archivePath, path.extname(archivePath));

        if (flattenSingleRoot) {
            const topEntries = (await fse.readdir(tempDir)).filter((e) => !isIgnored(e));
            if (topEntries.length === 1) {
                const candidatePath = path.join(tempDir, topEntries[0]);
                const stat = await fse.stat(candidatePath);
                if (stat.isDirectory()) {
                    contentDir = candidatePath;
                    folderName = topEntries[0];
                }
            }
        }

        onProgress?.(95, "Moving extracted contents");
        const targetPath = getUniquePath(targetDir, folderName);
        await fse.move(contentDir, targetPath);
        await fse.remove(tempDir).catch(() => {});

        onProgress?.(100, "Done");
        return targetPath;
    } catch (err) {
        await fse.remove(tempDir).catch(() => {});
        throw err;
    }
}

export class ArchiveService {
    constructor(_desktop: WWMM2App) {}

    async hasSingleTopLevelDirectory(archivePath: string): Promise<boolean> {
        const ext = path.extname(archivePath).toLowerCase();
        if (ext !== ".zip") return false;

        const zip = new StreamZip.async({ file: archivePath });
        try {
            const entries = await zip.entries();
            const topLevel = new Set<string>();
            for (const name of Object.keys(entries)) {
                const normalized = name.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");
                if (!normalized) continue;
                const top = normalized.split("/")[0];
                if (top && !isIgnored(top)) topLevel.add(top);
                if (topLevel.size > 1) return false;
            }
            if (topLevel.size !== 1) return false;
            const [singleTop] = topLevel;
            return Object.keys(entries).some(
                (e) =>
                    e.replace(/\\/g, "/").startsWith(`${singleTop}/`) &&
                    e.replace(/\\/g, "/") !== `${singleTop}/`,
            );
        } finally {
            await zip.close();
        }
    }

    async extract(
        archivePath: string,
        targetDir: string,
        options?: ExtractOptions,
        onProgress?: (percent: number, message: string) => void,
    ): Promise<string> {
        await fse.ensureDir(targetDir);
        const flattenSingleRoot = options?.flattenSingleRoot ?? true;
        const ext = path.extname(archivePath).toLowerCase();

        try {
            if (ext === ".zip") {
                return await extractZip(archivePath, targetDir, flattenSingleRoot, onProgress);
            }
            if (ext === ".rar") {
                return await extractRar(archivePath, targetDir, flattenSingleRoot, onProgress);
            }
            if (ext === ".7z") {
                return await extract7z(archivePath, targetDir, flattenSingleRoot, onProgress);
            }
            // For other formats, try zip first (some archives are zip-compatible)
            try {
                return await extractZip(archivePath, targetDir, flattenSingleRoot, onProgress);
            } catch {
                throw new Error(
                    `Unsupported archive format: ${ext}. Only .zip, .rar and .7z are supported.`,
                );
            }
        } catch (error) {
            throw new Error(
                `Failed to extract archive: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}

export default ArchiveService;
