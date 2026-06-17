import type { IpcEvents } from "@shared/types";
import { BrowserWindow } from "electron";
import type { WWMM2App } from "../index";
import { registerFixToolsManagerHandlers } from "./handlers/fix-tools-manager";
import { registerGameBananaHandlers } from "./handlers/gamebanana";
import { registerLoggerHandlers } from "./handlers/logger";
import { registerModHandlers } from "./handlers/mod";
import { registerPathSelectorHandlers } from "./handlers/path-selector";
import { registerSettingHandlers } from "./handlers/setting";
import { registerToolsHandlers } from "./handlers/tools";
import { registerUtilHandlers } from "./handlers/util";
import { registerWindowHandlers } from "./handlers/window";
import { registerWuwaModFixerHandlers } from "./handlers/wuwa-mod-fixer";
import { registerXXMIHandlers } from "./handlers/xxmi";

export class IPC {
    private d: WWMM2App;

    constructor(d: WWMM2App) {
        this.d = d;
        this.setupHandlers();
    }

    private setupHandlers() {
        registerGameBananaHandlers(this.d);
        registerSettingHandlers(this.d);
        registerUtilHandlers(this.d);
        registerWindowHandlers(this.d);
        registerLoggerHandlers(this.d);
        registerPathSelectorHandlers();

        registerModHandlers(this.d);
        registerFixToolsManagerHandlers(this.d);
        registerToolsHandlers(this.d);
        registerWuwaModFixerHandlers(this.d);
        registerXXMIHandlers(this.d);
    }

    public postMessageToWindow<K extends keyof IpcEvents>(
        window: BrowserWindow,
        channel: K,
        ...args: Parameters<IpcEvents[K]>
    ) {
        window.webContents.send(channel, ...args);
    }

    public broadcast<K extends keyof IpcEvents>(channel: K, ...args: Parameters<IpcEvents[K]>) {
        BrowserWindow.getAllWindows().forEach((win) => {
            win.webContents.send(channel, ...args);
        });
    }
}
