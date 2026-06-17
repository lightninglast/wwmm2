import type { WWMM2App } from "@main/index";
import { app, Menu, Tray } from "electron";
import icon from "../../../resources/icon.png?asset";

export class TrayManager {
    private desktop: WWMM2App;
    public tray: Tray | null = null;

    constructor(desktop: WWMM2App) {
        this.desktop = desktop;
    }

    public createTray() {
        this.tray = new Tray(icon);
        const contextMenu = Menu.buildFromTemplate([
            {
                label: "Check for Updates...",
                type: "normal",
                click: async () => {
                    await this.desktop.updater.checkForUpdates(true);
                },
            },
            {
                label: "Setting",
                type: "normal",
                click: async () => {
                    await this.desktop.window.main.focusAndNavigate("/setting/gen");
                },
            },
            { type: "separator" },
            {
                label: "Quit",
                type: "normal",
                click: () => {
                    app.quit();
                },
            },
        ]);
        this.tray.setToolTip("WWMM2");
        this.tray.setContextMenu(contextMenu);
        this.tray.on("click", async () => {
            this.desktop.window.main.focus();
        });
    }
}

export default TrayManager;
