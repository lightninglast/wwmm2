import { useTitlebar } from "@renderer/hooks/use-titlebar";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/")({
  component: RouteComponent,
});

function RouteComponent() {
  const navi = useNavigate();
  const { Titlebar } = useTitlebar();

  useEffect(() => {
    navi({ to: "/mod" });
  }, [navi]);

  return (
    <div className="flex flex-col min-h-screen">
      <Titlebar />
    </div>
  );
}
