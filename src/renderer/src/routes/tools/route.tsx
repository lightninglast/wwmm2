import { useTitlebar } from "@renderer/hooks/use-titlebar";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

export const Route = createFileRoute("/tools")({
  component: RouteComponent,
});

function RouteComponent() {
  return <ToolsRouteContent />;
}

function ToolsRouteContent() {
  const { Titlebar } = useTitlebar();
  const { t } = useTranslation();

  return (
    <>
      <Titlebar title={{ text: t("page.tools.dashboard.sidebar_title"), position: "center" }} />
      <Outlet />
    </>
  );
}
