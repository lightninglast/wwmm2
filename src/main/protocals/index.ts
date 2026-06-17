import type { WWMM2App } from "@main/index";
import { registerLocalProtocal } from "./local";
import { registerModelViewerMemoryProtocol } from "./model-viewer-memory";

export function registerProtocal(desktop: WWMM2App) {
    registerLocalProtocal(desktop);
    registerModelViewerMemoryProtocol();
}
