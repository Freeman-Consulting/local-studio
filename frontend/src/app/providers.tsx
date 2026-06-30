"use client";

import type { ReactNode } from "react";
import { ProjectsProvider } from "@/features/agent/projects/context";
import { ToolsProvider } from "@/features/agent/tools/context";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ProjectsProvider>
      <ToolsProvider>{children}</ToolsProvider>
    </ProjectsProvider>
  );
}
