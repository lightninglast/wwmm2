import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { useGames } from "@renderer/hooks/use-mod-data";
import { Logger } from "@renderer/lib/logger";
import { useModStore } from "@renderer/store/mod";
import type { FolderGroup } from "@shared/types";
import { Download, FolderPlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

function sanitizeFolderName(name: string) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
}

export function DownloadConfirmationOverlay() {
  const { t } = useTranslation();

  const downloadMode = useModStore((s) => s.downloadMode);
  const setDownloadMode = useModStore((s) => s.setDownloadMode);
  const selectedGroup = useModStore((s) => s.selectedGroup);
  const setSelectedGroup = useModStore((s) => s.setSelectedGroup);
  const selectedGame = useModStore((s) => s.selectedGame);

  const { data: games = [] } = useGames();
  const gameFolderPath = games.find((g) => g.game === selectedGame)?.modFolderPath;

  const selectedPath = selectedGroup?.path || null;
  const selectedGroupName = selectedGroup?.name;
  const suggestedName = downloadMode?.suggestedName;
  const categoryName = downloadMode?.categoryName;
  const sanitizedCategoryName = categoryName ? sanitizeFolderName(categoryName) : null;
  const isNewFolderAlreadySelected =
    sanitizedCategoryName && selectedGroupName
      ? selectedGroupName === sanitizedCategoryName
      : false;
  const showCreateFolder =
    !!sanitizedCategoryName && !!gameFolderPath && !isNewFolderAlreadySelected;

  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [fileName, setFileName] = useState(suggestedName || "");

  useEffect(() => {
    setFileName(suggestedName || "");
  }, [suggestedName]);

  const handleCreateFolder = async () => {
    if (!gameFolderPath || !sanitizedCategoryName) return;
    setIsCreatingFolder(true);
    try {
      let createdPath: string;
      try {
        createdPath = await window.api.invoke("util:fs:mkdir", gameFolderPath, sanitizedCategoryName);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("ALREADY_EXISTS:")) {
          // Folder exists — use it anyway
          createdPath = `${gameFolderPath}\\${sanitizedCategoryName}`;
        } else {
          throw error;
        }
      }
      const newGroup: FolderGroup = {
        name: sanitizedCategoryName,
        path: createdPath,
        mods: [],
      };
      setSelectedGroup(newGroup);
    } catch (error) {
      toast.error(t("components.download-confirmation-overlay.create_folder_failed"));
      Logger.error(error, "DownloadConfirmationOverlay:handleCreateFolder");
    } finally {
      setIsCreatingFolder(false);
    }
  };

  const handleConfirm = async () => {
    if (!downloadMode || !selectedGroup) return;

    try {
      await window.api.invoke(
        "pathSelector:selectModManagerPath",
        downloadMode.downloadId,
        selectedGroup.path,
        suggestedName ? fileName.trim() : undefined,
      );

      setDownloadMode(null);
    } catch (error) {
      toast.error(t("components.download-confirmation-overlay.path_select_failed"));
      Logger.error(error, "DownloadConfirmationOverlay:handleConfirm");
    }
  };

  const handleCancel = async () => {
    if (!downloadMode) return;

    try {
      await window.api.invoke("pathSelector:cancel", downloadMode.downloadId);
      setDownloadMode(null);
    } catch (error) {
      Logger.error(error, "DownloadConfirmationOverlay:handleCancel");
    }
  };

  if (!downloadMode) return null;

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/20"
      onClick={(e) => {
        e.stopPropagation();
      }}
    >
      <div
        className="bg-background/75 backdrop-blur rounded-lg p-4 max-w-md w-full mx-4 shadow-lg"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <div className="space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-lg font-semibold">
                {t("components.download-confirmation-overlay.title")}
              </h3>
              <p className="text-sm text-muted-foreground mt-1">
                {t("components.download-confirmation-overlay.description")}
              </p>
            </div>
          </div>

          {suggestedName && (
            <div className="space-y-1">
              <p className="text-sm font-medium">
                {t("components.download-confirmation-overlay.file_name")}
              </p>
              <Input
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                placeholder={t("components.download-confirmation-overlay.file_name_placeholder")}
                transparentBackground
                className="w-full"
              />
            </div>
          )}

          <div className="space-y-1">
            <p className="text-sm font-medium">
              {t("components.download-confirmation-overlay.download_location")}
            </p>
            <Input
              value={
                selectedGroupName
                  ? selectedGroupName
                  : t("components.download-confirmation-overlay.need_select_character_folder")
              }
              className="w-full"
              hideFocusRing
              transparentBackground
              readOnly
            />
          </div>

          {showCreateFolder && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              disabled={isCreatingFolder || !gameFolderPath}
              onClick={() => void handleCreateFolder()}
            >
              <FolderPlusIcon className="size-4 mr-2" />
              {t("components.download-confirmation-overlay.create_folder", {
                name: sanitizedCategoryName,
              })}
            </Button>
          )}

          <div className="flex gap-2 pt-2">
            <Button variant="outline" onClick={handleCancel} className="flex-1">
              {t("g.cancel")}
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={!selectedPath || (suggestedName ? !fileName.trim() : false)}
              className="flex-1"
            >
              <Download className="size-4 mr-2" />
              {t("g.select")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
