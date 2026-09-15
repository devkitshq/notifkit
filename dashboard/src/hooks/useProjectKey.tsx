import type { ReactNode } from "react";
import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { useAuth } from "./useAuth";

export interface ProjectItem {
  id: string;
  name: string;
  rateLimitRpm?: number | null;
  createdAt: string;
}

interface ProjectContextType {
  projects: ProjectItem[];
  selectedProjectId: string;
  setSelectedProjectId: (id: string) => void;
  projectApiKey: string | null;
  isLoadingProjects: boolean;
  refreshProjects: () => Promise<void>;
}

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const { token, apiUrl, isAuthenticated } = useAuth();
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);

  const fetchProjects = useCallback(async () => {
    if (!token) {
      setProjects([]);
      setSelectedProjectId("");
      setIsLoadingProjects(false);
      return;
    }

    try {
      setIsLoadingProjects(true);
      const res = await fetch(`${apiUrl}/v1/projects`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        const projs: ProjectItem[] = data.projects || [];
        setProjects(projs);
        if (projs.length > 0) {
          setSelectedProjectId((prev) => (projs.some((p) => p.id === prev) ? prev : projs[0]!.id));
        } else {
          setSelectedProjectId("");
        }
      }
    } catch (err) {
      console.error("Failed to load projects:", err);
    } finally {
      setIsLoadingProjects(false);
    }
  }, [apiUrl, token]);

  useEffect(() => {
    if (isAuthenticated && token) {
      void fetchProjects();
    } else {
      setProjects([]);
      setSelectedProjectId("");
      setIsLoadingProjects(false);
    }
  }, [isAuthenticated, token, fetchProjects]);

  return (
    <ProjectContext.Provider
      value={{
        projects,
        selectedProjectId,
        setSelectedProjectId,
        projectApiKey: token,
        isLoadingProjects,
        refreshProjects: fetchProjects,
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
