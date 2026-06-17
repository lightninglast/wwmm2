import type { WWMM2App } from "@main/index";
import { rh } from "@main/ipc/helper";

export function registerWuwaModFixerHandlers(d: WWMM2App) {
    rh("wuwaFixer:getRateStatus", () => d.service.modTools.wuwaModFixer.getRateStatus());
    rh("wuwaFixer:getStatus", (importer: string | null) =>
        d.service.modTools.wuwaModFixer.getStatus(importer),
    );
    rh("wuwaFixer:prepareRun", (importer: string | null) =>
        d.service.modTools.wuwaModFixer.prepareRun(importer),
    );
    rh("wuwaFixer:installOrUpdate", () => d.service.modTools.wuwaModFixer.installOrUpdate());
    rh("wuwaFixer:run", (modPath, options) =>
        d.service.modTools.wuwaModFixer.run(modPath, options),
    );
}
