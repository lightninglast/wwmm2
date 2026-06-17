import type { WWMM2App } from "@main/index";
import LocalProtocol from "@main/services/protocol/local";
import { protocol } from "electron";

export function registerLocalProtocal(desktop: WWMM2App) {
    const localProtocol = new LocalProtocol(desktop);
    protocol.handle("local", localProtocol.handle);
}
