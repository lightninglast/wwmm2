import { safeStorage } from "electron";
import type { WWMM2App } from "..";

export class Crypto {
    private desktop: WWMM2App;

    constructor(desktop: WWMM2App) {
        this.desktop = desktop;
    }

    public encryptString(str: string) {
        const encryptedBuf = safeStorage.encryptString(str);
        return encryptedBuf.toString("base64");
    }

    public decryptString(base64Str: string) {
        const buffer = Buffer.from(base64Str, "base64");
        const decryptedBuf = safeStorage.decryptString(buffer);
        return decryptedBuf.toString();
    }
}

export default Crypto;
