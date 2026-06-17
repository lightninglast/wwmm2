import type { AppStatus } from "@shared/types";
import type { UpdaterReleaseNotes, UpdaterStatus } from "@shared/updater";
import { createStore, useStore } from "zustand";

interface GlobalStore {
    appStatus: AppStatus | null;
    setAppStatus: (appStatus: AppStatus) => void;
    updateAvailable: boolean;
    setUpdateAvailable: (updateAvailable: boolean) => void;
    updateDownloaded: boolean;
    setUpdateDownloaded: (updateDownloaded: boolean) => void;
    releaseVersion: string | null;
    releaseNotes: UpdaterReleaseNotes | null;
    shouldPromptForUpdate: boolean;
    setShouldPromptForUpdate: (shouldPromptForUpdate: boolean) => void;
    updaterMode: UpdaterStatus["mode"];
    setUpdaterMode: (mode: UpdaterStatus["mode"]) => void;
    updaterChecking: boolean;
    setUpdaterChecking: (updaterChecking: boolean) => void;
    updaterDownloading: boolean;
    setUpdaterDownloading: (updaterDownloading: boolean) => void;
    setUpdaterStatus: (status: UpdaterStatus) => void;
}

export const globalStore = createStore<GlobalStore>((set) => {
    return {
        appStatus: null,
        setAppStatus: (appStatus) => set({ appStatus }),
        updateAvailable: false,
        setUpdateAvailable: (updateAvailable) => set({ updateAvailable }),
        updateDownloaded: false,
        setUpdateDownloaded: (updateDownloaded) => set({ updateDownloaded }),
        releaseVersion: null,
        releaseNotes: null,
        shouldPromptForUpdate: false,
        setShouldPromptForUpdate: (shouldPromptForUpdate) => set({ shouldPromptForUpdate }),
        updaterMode: "auto",
        setUpdaterMode: (updaterMode) => set({ updaterMode }),
        updaterChecking: false,
        setUpdaterChecking: (updaterChecking) => set({ updaterChecking }),
        updaterDownloading: false,
        setUpdaterDownloading: (updaterDownloading) => set({ updaterDownloading }),
        setUpdaterStatus: (status) =>
            set({
                updaterMode: status.mode,
                updateAvailable: status.updateAvailable,
                updateDownloaded: status.updateDownloaded,
                releaseVersion: status.releaseVersion,
                releaseNotes: status.releaseNotes,
                shouldPromptForUpdate: status.shouldPromptForUpdate,
                updaterChecking: status.isChecking,
                updaterDownloading: status.isDownloading,
            }),
    };
});

export function useGlobalStore<T>(selector: (state: GlobalStore) => T): T {
    return useStore(globalStore, selector);
}
