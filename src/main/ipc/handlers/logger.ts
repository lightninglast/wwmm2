import type { WWMM2App } from "@main/index";
import { ipcMain } from "electron";

export function registerLoggerHandlers(desktop: WWMM2App) {
    ipcMain.on("logger:log", (_event, level, object, where) => {
        desktop.logger.log(level, object, where);
    });
}
