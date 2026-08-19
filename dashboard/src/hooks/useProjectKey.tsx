"use client";

import type { ReactNode } from "react";
import { createContext, useContext, useState, useEffect } from "react";

interface ProjectContextType {
  projects: any[];
  selectedProjectId: string;
  setSelectedProjectId: (id: string) => void;
  projectApiKey: string | null;
  isLoadingProjects: boolean;
}

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<any[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [projectApiKey, setProjectApiKey] = useState<string | null>(null);
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
  const adminKey = process.env.NEXT_PUBLIC_ADMIN_KEY || "test_admin_key";

  useEffect(() => {
    fetch(`${apiUrl}/v1/projects`, { headers: { Authorization: `Bearer ${adminKey}` } })
      .then((res) => res.json())
      .then((data) => {
        const projs = data.projects || [];
        setProjects(projs);
        if (projs.length > 0) {
          setSelectedProjectId(projs[0].id);
        }
        setIsLoadingProjects(false);
      })
      .catch((err) => {
        console.error(err);
        setIsLoadingProjects(false);
      });
  }, [apiUrl, adminKey]);

  useEffect(() => {
    // With Admin token, we no longer need the project's API key.
    // We just use the Admin token and pass x-project-id.
    setProjectApiKey(adminKey);
  }, [adminKey]);

  return (
    <ProjectContext.Provider
      value={{
        projects,
        selectedProjectId,
        setSelectedProjectId,
        projectApiKey,
        isLoadingProjects,
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject() {
  const context = useContext(ProjectContext);
  if (context === undefined) {
    throw new Error("useProject must be used within a ProjectProvider");
  }
  return context;
}
