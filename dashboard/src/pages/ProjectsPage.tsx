import { useEffect, useState } from "react";
import DashboardHeader from "@/components/DashboardHeader";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { FolderKey, Plus, Copy, Trash2, AlertCircle, Eye, EyeOff } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";

interface Project {
  id: string;
  name: string;
  rateLimitRpm: number | null;
  createdAt: string;
}

interface ApiKey {
  id: string;
  role: string;
  createdAt: string;
}

export default function ProjectsPage() {
  const { apiUrl, token: adminKey } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [newProjectName, setNewProjectName] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);

  const [newlyGeneratedKey, setNewlyGeneratedKey] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);

  const fetchProjects = async () => {
    try {
      const res = await fetch(`${apiUrl}/v1/projects`, {
        headers: { Authorization: `Bearer ${adminKey}` },
      });
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects || []);
      }
    } catch (err) {
      console.error(err);
      toast.error("Failed to load projects");
    } finally {
      setLoading(false);
    }
  };

  const fetchApiKeys = async (projectId: string) => {
    try {
      const res = await fetch(`${apiUrl}/v1/projects/${projectId}/keys`, {
        headers: { Authorization: `Bearer ${adminKey}` },
      });
      if (res.ok) {
        const data = await res.json();
        setApiKeys(data.keys || []);
      }
    } catch (err) {
      console.error(err);
      toast.error("Failed to load API keys");
    }
  };

  useEffect(() => {
    void fetchProjects();
  }, []);

  useEffect(() => {
    if (selectedProjectId) {
      void fetchApiKeys(selectedProjectId);
      setNewlyGeneratedKey(null);
      setShowKey(false);
    } else {
      setApiKeys([]);
    }
  }, [selectedProjectId]);

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectName.trim()) return;

    try {
      const res = await fetch(`${apiUrl}/v1/projects`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: newProjectName }),
      });

      if (res.ok) {
        const data = await res.json();
        toast.success("Project created!");
        setNewProjectName("");
        void fetchProjects();
        if (data.apiKey) {
          setNewlyGeneratedKey(data.apiKey);
          setShowKey(false);
        }
      } else {
        const err = await res.json();
        toast.error(`Error: ${err.message || "Failed to create project"}`);
      }
    } catch (_err) {
      toast.error("Failed to create project");
    }
  };

  const handleGenerateKey = async () => {
    if (!selectedProjectId) return;
    try {
      const res = await fetch(`${apiUrl}/v1/projects/${selectedProjectId}/keys`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: "admin" }),
      });
      if (res.ok) {
        const data = await res.json();
        setNewlyGeneratedKey(data.apiKey);
        setShowKey(false);
        toast.success("New API Key generated successfully");
        void fetchApiKeys(selectedProjectId);
      } else {
        toast.error("Failed to generate key");
      }
    } catch (_err) {
      toast.error("Failed to generate key");
    }
  };

  const handleRevokeKey = async (keyId: string) => {
    if (!selectedProjectId) return;
    if (
      !confirm(
        "Are you sure you want to revoke this API key? Systems using it will immediately stop working.",
      )
    )
      return;
    try {
      const res = await fetch(`${apiUrl}/v1/projects/${selectedProjectId}/keys/${keyId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminKey}` },
      });
      if (res.ok) {
        toast.success("API Key revoked");
        void fetchApiKeys(selectedProjectId);
      } else {
        toast.error("Failed to revoke key");
      }
    } catch (_err) {
      toast.error("Failed to revoke key");
    }
  };

  return (
    <div className="min-h-full flex flex-col w-full">
      <DashboardHeader isConnected={true} />

      <main className="flex-1 container mx-auto p-4 md:p-6">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FolderKey className="w-6 h-6 text-foreground" />
            Projects & API Keys
          </h1>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-1 bg-card border-border h-fit">
            <CardHeader>
              <CardTitle>Create Project</CardTitle>
              <CardDescription>Add a new tenant to Notifkit</CardDescription>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={(e) => {
                  void handleCreateProject(e);
                }}
                className="space-y-4"
              >
                <div className="flex flex-col gap-2">
                  <label htmlFor="name" className="text-sm font-medium">
                    Project Name
                  </label>
                  <Input
                    id="name"
                    type="text"
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    placeholder="My Project"
                  />
                </div>
                <Button type="submit" className="w-full gap-2">
                  <Plus className="w-4 h-4" />
                  Create
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2 bg-card border-border">
            <CardHeader>
              <CardTitle>Existing Projects</CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="text-muted-foreground text-sm">Loading projects...</div>
              ) : projects.length === 0 ? (
                <div className="text-muted-foreground text-sm text-center py-8">
                  No projects found. Create one to get started.
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-3 text-xs font-semibold text-muted-foreground uppercase pb-2 border-b border-border">
                    <div>Name</div>
                    <div>Rate Limit</div>
                    <div>Created</div>
                  </div>
                  {projects.map((p) => (
                    <div
                      key={p.id}
                      className={`grid grid-cols-3 text-sm py-2 px-3 rounded-md cursor-pointer transition-colors ${
                        selectedProjectId === p.id
                          ? "bg-muted text-foreground border border-border"
                          : "hover:bg-muted/50"
                      }`}
                      onClick={() => setSelectedProjectId(p.id)}
                    >
                      <div className="font-medium text-foreground flex items-center gap-2">
                        {p.name}
                        {selectedProjectId === p.id && (
                          <span className="h-1.5 w-1.5 rounded-full bg-foreground" />
                        )}
                      </div>
                      <div className="text-muted-foreground font-mono text-xs flex flex-col gap-1 justify-center">
                        <span>{p.rateLimitRpm ? `${p.rateLimitRpm} RPM` : "600 RPM"}</span>
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {new Date(p.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {selectedProjectId && (
                <div className="mt-8 pt-6 border-t border-border">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="font-semibold text-base">API Keys</h3>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void handleGenerateKey();
                      }}
                    >
                      Generate New Key
                    </Button>
                  </div>

                  {newlyGeneratedKey && (
                    <div className="mb-6 p-4 rounded-lg bg-muted border border-border space-y-3">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 mt-0.5 text-foreground" />
                        <div>
                          <p className="font-medium text-sm text-foreground">
                            Please copy your new API key
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            For security reasons, this key will not be shown again. Make sure to
                            copy it now.
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 bg-background rounded-md p-2 border border-border">
                        <code className="flex-1 text-xs font-mono break-all text-foreground">
                          {showKey
                            ? newlyGeneratedKey
                            : newlyGeneratedKey.replace(
                                /(?<=^nk_live_).*/,
                                "********************************",
                              )}
                        </code>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          onClick={() => setShowKey(!showKey)}
                        >
                          {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          onClick={() => {
                            void navigator.clipboard.writeText(newlyGeneratedKey);
                            toast.success("Copied to clipboard!");
                          }}
                        >
                          <Copy className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  )}

                  {apiKeys.length === 0 ? (
                    <div className="text-sm text-muted-foreground">
                      No API keys found for this project.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="grid grid-cols-4 text-xs font-semibold text-muted-foreground uppercase pb-2">
                        <div className="col-span-2">Key ID</div>
                        <div>Role</div>
                        <div className="text-right">Actions</div>
                      </div>
                      {apiKeys.map((k) => (
                        <div
                          key={k.id}
                          className="grid grid-cols-4 text-sm py-2 items-center group"
                        >
                          <div className="col-span-2 font-mono text-muted-foreground truncate pr-4 text-xs">
                            {k.id}
                          </div>
                          <div className="capitalize text-muted-foreground text-xs">{k.role}</div>
                          <div className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                              onClick={() => {
                                void handleRevokeKey(k.id);
                              }}
                            >
                              <Trash2 className="w-4 h-4 mr-1.5" />
                              Revoke
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
