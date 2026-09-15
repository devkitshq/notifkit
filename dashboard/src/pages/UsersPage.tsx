import { useEffect, useState, useCallback } from "react";
import DashboardHeader from "@/components/DashboardHeader";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { toast } from "sonner";
import { Users, Clock, Mail, History, Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useProject } from "@/hooks/useProjectKey";
import { useAuth } from "@/hooks/useAuth";

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
  const { projects, selectedProjectId, projectApiKey, isLoadingProjects } = useProject();
  const { apiUrl } = useAuth();

  const fetchUsers = useCallback(
    async (apiKey: string, projectId: string) => {
      setLoading(true);
      try {
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
    },
    [apiUrl],
  );

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
    try {
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
    }
  };

  return (
    <div className="min-h-full flex flex-col w-full">
      <DashboardHeader isConnected={true} />

      <main className="flex-1 container mx-auto p-4 md:p-6 space-y-6">
        <div className="flex justify-between items-center">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="w-6 h-6 text-foreground" />
            User Directory & Contact Preferences
          </h1>
        </div>

        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle>Registered End-Users</CardTitle>
            <CardDescription>
              Recipient profiles, channel addresses, and preference overrides
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0 overflow-auto">
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
              <div className="text-muted-foreground text-sm p-6 text-center">Loading users...</div>
            ) : users.length === 0 ? (
              <div className="text-muted-foreground text-sm text-center p-8">No users found.</div>
            ) : (
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>External User ID</TableHead>
                    <TableHead>Primary Contact</TableHead>
                    <TableHead>Created At</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((user, index) => {
                    const displayId = user.externalId || user.userId || user.id || `user-${index}`;
                    return (
                      <TableRow
                        key={displayId}
                        className="hover:bg-muted/50 transition-colors cursor-pointer"
                        onClick={() => void handleOpenDetail(user)}
                      >
                        <TableCell className="font-mono font-bold text-foreground">
                          {displayId}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {user.email ? (
                            user.email
                          ) : (
                            <span className="italic opacity-50">Not provided</span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">
                          {new Date(user.createdAt).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleOpenDetail(user);
                            }}
                          >
                            <Eye className="h-3.5 w-3.5 mr-1" /> View Profile
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>

      {/* User Profile Deep-Dive Modal */}
      {selectedUser && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-xs flex justify-end">
          <div className="w-full max-w-xl bg-card border-l border-border p-6 overflow-y-auto space-y-6">
            <div className="flex items-center justify-between border-b border-border pb-3">
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
              <h3 className="text-sm font-semibold flex items-center gap-2 text-foreground">
                <Mail className="h-4 w-4 text-muted-foreground" />
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
                      className="p-3 rounded-md bg-muted/40 border border-border flex items-center justify-between text-xs"
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
              <h3 className="text-sm font-semibold flex items-center gap-2 text-foreground">
                <History className="h-4 w-4 text-muted-foreground" />
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
                      className="p-2.5 rounded-md bg-muted/40 border border-border flex items-center justify-between text-xs"
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
