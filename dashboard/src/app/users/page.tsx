"use client";

import { useEffect, useState, useCallback } from "react";
import DashboardHeader from "@/components/DashboardHeader";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { toast } from "sonner";
import { Users, Clock, Mail, History, Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useProject } from "@/hooks/useProjectKey";

interface User {
  id?: string;
  userId?: string;
  externalId?: string;
  email?: string;
  createdAt: string | number;
  attributes?: any;
  preferences?: any;
}

interface UserDetail extends User {
  contacts?: Array<{ id: string; channel: string; target: string; enabled: boolean }>;
  logs?: Array<{
    id: string;
    taskId: string;
    templateId: string;
    channel: string;
    status: string;
    timestamp: string;
  }>;
}

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserDetail | null>(null);
  const [_loadingDetail, setLoadingDetail] = useState(false);
  const { projects, selectedProjectId, projectApiKey, isLoadingProjects } = useProject();

  const fetchUsers = useCallback(async (apiKey: string, projectId: string) => {
    setLoading(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
      const res = await fetch(`${apiUrl}/v1/users`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "x-project-id": projectId,
        },
      });
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users || []);
      } else {
        toast.error("Failed to load users");
      }
    } catch (err) {
      console.error(err);
      toast.error("Failed to load users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (projectApiKey && selectedProjectId) {
      void fetchUsers(projectApiKey, selectedProjectId);
    } else {
      setUsers([]);
    }
  }, [projectApiKey, selectedProjectId, fetchUsers]);

  const handleOpenDetail = async (u: User) => {
    const id = u.externalId || u.userId || u.id;
    if (!id) return;
    setLoadingDetail(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
      const res = await fetch(`${apiUrl}/v1/users/${encodeURIComponent(id)}/details`, {
        headers: {
          Authorization: `Bearer ${projectApiKey}`,
          "x-project-id": selectedProjectId,
        },
      });
      if (res.ok) {
        const data = await res.json();
        setSelectedUser(data);
      } else {
        setSelectedUser({ ...u, contacts: [], logs: [] });
      }
    } catch {
      setSelectedUser({ ...u, contacts: [], logs: [] });
    } finally {
      setLoadingDetail(false);
    }
  };

  return (
    <div className="min-h-full flex flex-col w-full">
      <DashboardHeader isConnected={true} />

      <main className="flex-1 container mx-auto p-4 md:p-6 space-y-6">
        <div className="flex justify-between items-center">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="w-6 h-6 text-primary" />
            User Directory & Contact Preferences
          </h1>
        </div>

        <Card className="bg-card/50 backdrop-blur-sm border-border/50">
          <CardHeader>
            <CardTitle>Registered End-Users</CardTitle>
            <CardDescription>
              Recipient profiles, channel addresses, and preference overrides
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingProjects ? (
              <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-3">
                <Clock className="h-8 w-8 opacity-50" />
                <p className="text-sm">Loading projects...</p>
              </div>
            ) : projects.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-3">
                <Clock className="h-8 w-8 opacity-50" />
                <p className="text-sm">No projects exist. Create one in the Projects & Keys tab.</p>
              </div>
            ) : !projectApiKey ? (
              <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-3">
                <Clock className="h-8 w-8 opacity-50" />
                <p className="text-sm">No API key found for this project.</p>
              </div>
            ) : loading ? (
              <div className="text-muted-foreground text-sm py-4">Loading users...</div>
            ) : users.length === 0 ? (
              <div className="text-muted-foreground text-sm text-center py-8">No users found.</div>
            ) : (
              <div className="rounded-md border border-border/50 overflow-hidden">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-muted-foreground uppercase bg-muted/50">
                    <tr>
                      <th className="px-6 py-3 font-medium">External User ID</th>
                      <th className="px-6 py-3 font-medium">Primary Contact</th>
                      <th className="px-6 py-3 font-medium">Created At</th>
                      <th className="px-6 py-3 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {users.map((user, index) => {
                      const displayId =
                        user.externalId || user.userId || user.id || `user-${index}`;
                      return (
                        <tr
                          key={displayId}
                          className="hover:bg-muted/30 transition-colors cursor-pointer"
                          onClick={() => void handleOpenDetail(user)}
                        >
                          <td className="px-6 py-4 font-mono font-bold text-foreground">
                            {displayId}
                          </td>
                          <td className="px-6 py-4 text-muted-foreground">
                            {user.email ? (
                              user.email
                            ) : (
                              <span className="italic opacity-50">Not provided</span>
                            )}
                          </td>
                          <td className="px-6 py-4 text-muted-foreground text-xs">
                            {new Date(user.createdAt).toLocaleDateString()}
                          </td>
                          <td className="px-6 py-4 text-right">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 border-primary/30 text-primary hover:bg-primary/10"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleOpenDetail(user);
                              }}
                            >
                              <Eye className="h-3.5 w-3.5 mr-1" /> View Profile
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </main>

      {/* User Profile Deep-Dive Modal */}
      {selectedUser && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex justify-end">
          <div className="w-full max-w-xl bg-card border-l border-border/40 p-6 overflow-y-auto space-y-6">
            <div className="flex items-center justify-between border-b border-border/40 pb-3">
              <div>
                <h2 className="text-xl font-bold font-mono text-foreground">
                  User: {selectedUser.externalId || selectedUser.userId || selectedUser.id}
                </h2>
                <p className="text-xs text-muted-foreground">
                  Registered contact endpoints and preferences
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setSelectedUser(null)}>
                Close
              </Button>
            </div>

            {/* Registered Channels */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Mail className="h-4 w-4 text-blue-400" />
                Contact Channels ({selectedUser.contacts?.length ?? 0})
              </h3>
              {!selectedUser.contacts || selectedUser.contacts.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  No contact endpoints registered for this user.
                </p>
              ) : (
                <div className="space-y-2">
                  {selectedUser.contacts.map((c) => (
                    <div
                      key={c.id}
                      className="p-3 rounded-lg bg-muted/20 border border-border/30 flex items-center justify-between text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="capitalize font-mono text-[10px]">
                          {c.channel}
                        </Badge>
                        <span className="font-mono text-foreground">{c.target}</span>
                      </div>
                      <Badge variant={c.enabled !== false ? "default" : "destructive"}>
                        {c.enabled !== false ? "Active" : "Opted-out"}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Recent Notifications for User */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <History className="h-4 w-4 text-emerald-400" />
                Per-User Delivery Audit Trail
              </h3>
              {!selectedUser.logs || selectedUser.logs.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  No recent notifications logged for this user.
                </p>
              ) : (
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {selectedUser.logs.map((log) => (
                    <div
                      key={log.id}
                      className="p-2.5 rounded-lg bg-muted/20 border border-border/30 flex items-center justify-between text-xs"
                    >
                      <div>
                        <span className="font-mono text-foreground font-semibold">
                          {log.taskId}
                        </span>
                        <span className="text-muted-foreground ml-2">({log.templateId})</span>
                      </div>
                      <Badge variant="secondary" className="capitalize text-[10px]">
                        {log.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
