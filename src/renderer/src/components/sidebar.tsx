import { cn } from "@renderer/lib/utils";
import { useGlobalStore } from "@renderer/store/global";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  BananaIcon,
  DatabaseBackupIcon,
  GamepadIcon,
  SettingsIcon,
  WrenchIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export function Sidebar({ className }: { className?: string }) {
  const navi = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const appStatus = useGlobalStore((state) => state.appStatus);

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
  };

  const iconSize = "size-7";
  const pathname = location.pathname;
  const isModPage = pathname.startsWith("/mod");
  const isBackupPage = pathname.startsWith("/backup");
  const isToolsPage = pathname.startsWith("/tools");
  const isGameBananaPage = pathname.startsWith("/gamebanana");
  const isSettingPage = pathname.startsWith("/setting");
  const getNavButtonClassName = (isActive: boolean) =>
    cn("relative overflow-visible", isActive && "text-accent hover:text-accent");

  return (
    <div className={cn("flex w-13 flex-col border-r", className)}>
      <div className="w-full flex flex-col h-full select-none">
        <div className="flex flex-col overflow-y-auto overflow-x-hidden dragselect-start-allowed p-2 space-y-2">
          <Tooltip disableHoverableContent={true}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-lg"
                className={cn(
                  getNavButtonClassName(isGameBananaPage),
                  isGameBananaPage && "text-yellow-500 hover:text-yellow-500",
                )}
                aria-current={isGameBananaPage ? "page" : undefined}
                onPointerDown={handlePointerDown}
                onClick={() => {
                  navi({ to: "/gamebanana" });
                }}
              >
                <BananaIcon className={cn(iconSize)} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" hideWhenDetached={true}>
              GameBanana
            </TooltipContent>
          </Tooltip>

          <Separator />

          <Tooltip disableHoverableContent={true}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-lg"
                className={getNavButtonClassName(isModPage)}
                aria-current={isModPage ? "page" : undefined}
                onPointerDown={handlePointerDown}
                onClick={() => {
                  navi({ to: "/mod" });
                }}
              >
                <GamepadIcon className={cn(iconSize)} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" hideWhenDetached={true}>
              {t("page.mod.title")}
            </TooltipContent>
          </Tooltip>

          {appStatus?.isDev && (
            <Tooltip disableHoverableContent={true}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-lg"
                  className={getNavButtonClassName(isBackupPage)}
                  aria-current={isBackupPage ? "page" : undefined}
                  onPointerDown={handlePointerDown}
                  onClick={() => {
                    navi({ to: "/backup" });
                  }}
                >
                  <DatabaseBackupIcon className={cn(iconSize)} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" hideWhenDetached={true}>
                {t("page.backup.title")}
              </TooltipContent>
            </Tooltip>
          )}

          <Tooltip disableHoverableContent={true}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-lg"
                className={getNavButtonClassName(isToolsPage)}
                aria-current={isToolsPage ? "page" : undefined}
                onPointerDown={handlePointerDown}
                onClick={() => {
                  navi({ to: "/tools" });
                }}
              >
                <WrenchIcon className={cn(iconSize)} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" hideWhenDetached={true}>
              {t("page.tools.dashboard.sidebar_title")}
            </TooltipContent>
          </Tooltip>

          <Separator orientation="horizontal" />

          <Tooltip disableHoverableContent={true}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-lg"
                className={getNavButtonClassName(isSettingPage)}
                aria-current={isSettingPage ? "page" : undefined}
                onPointerDown={handlePointerDown}
                onClick={() => {
                  navi({ to: "/setting/gen" });
                }}
              >
                <SettingsIcon className={cn(iconSize)} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" hideWhenDetached={true}>
              {t("page.setting.title")}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
