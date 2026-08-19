import type {
  AddUserInput,
  UpdateUserInput,
  AddContactInput,
  SyncTemplatesInput,
  NotifyRequestInput,
  TriggerWorkflowInput,
  CreateWorkflowInput,
  IngestEventInput,
  UpdateProjectInput,
} from "./contracts/sdk.js";

export interface NotifkitClientOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  templates?: SyncTemplatesInput["templates"];
  apiKey?: string;
}

export class NotifkitClient {
  private readonly options: NotifkitClientOptions;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(options: NotifkitClientOptions) {
    this.options = options;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.headers = {
      "Content-Type": "application/json",
      ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
      ...options.headers,
    };
  }

  private async request<T>(path: string, method: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: this.headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 204) {
      return undefined as T;
    }

    const data = await res.json();
    if (!res.ok) {
      const errorMsg =
        (data as any).message || (data as any).error || `Request failed with status ${res.status}`;
      throw new Error(errorMsg);
    }
    return data as T;
  }

  /** Sync templates with the server. */
  async syncTemplates(input: SyncTemplatesInput): Promise<{ synced: number }> {
    return this.request("/v1/templates", "PUT", input);
  }

  /** Create/upsert a user profile and contacts. */
  async addUser(input: AddUserInput): Promise<{ id: string }> {
    return this.request("/v1/users", "POST", input);
  }

  /** Update user profile. */
  async updateUser(id: string, input: UpdateUserInput): Promise<{ id: string }> {
    return this.request(`/v1/users/${id}`, "PATCH", input);
  }

  /** Delete user profile. */
  async deleteUser(id: string): Promise<void> {
    return this.request(`/v1/users/${id}`, "DELETE");
  }

  /** Add contact targets to user profile. */
  async addContact(
    userId: string,
    input: AddContactInput,
  ): Promise<{ userId: string; channel: string; target: string }> {
    return this.request(`/v1/users/${userId}/contacts`, "POST", input);
  }

  /** Delete a specific contact channel target. */
  async deleteContact(userId: string, channel: string, target: string): Promise<void> {
    return this.request(`/v1/users/${userId}/contacts/${channel}/${target}`, "DELETE");
  }

  /** Request a notification dispatch. */
  async notify(
    input: NotifyRequestInput,
  ): Promise<{ messageId: string; notificationId: string; target: unknown }> {
    return this.request("/v1/notify", "POST", input);
  }

  /** Trigger a registered background workflow. */
  async triggerWorkflow(
    input: TriggerWorkflowInput,
  ): Promise<{ messageId: string; instanceId: string }> {
    return this.request("/v1/workflows/trigger", "POST", input);
  }

  /** Create a dynamic JSON workflow definition. */
  async createWorkflow(input: CreateWorkflowInput): Promise<{ name: string }> {
    return this.request("/v1/workflows", "POST", input);
  }

  /** Ingest an external event into the system to resume workflows or trigger automations. */
  async ingestEvent(input: IngestEventInput): Promise<{ messageId: string; eventId: string }> {
    return this.request("/v1/events", "POST", input);
  }

  /** Sync templates configured on the client options to the server. */
  async sync(): Promise<{ synced: number }> {
    if (!this.options.templates || this.options.templates.length === 0) {
      return { synced: 0 };
    }
    return this.syncTemplates({ templates: this.options.templates });
  }

  // ─── Missing Endpoints additions ─────────────────────────────────────────────

  /** List registered workflow definitions. */
  async listWorkflows(): Promise<{ workflows: any[] }> {
    return this.request("/v1/workflows", "GET");
  }

  /** Get a workflow instance by ID. */
  async getWorkflow(instanceId: string): Promise<any> {
    return this.request(`/v1/workflows/instances/${instanceId}`, "GET");
  }

  /** Cancel a running/suspended workflow instance. */
  async cancelWorkflow(instanceId: string): Promise<void> {
    return this.request(`/v1/workflows/instances/${instanceId}`, "DELETE");
  }

  /** Get notification logs for the project. */
  async getNotificationLogs(options?: {
    limit?: number;
    cursor?: string;
    templateId?: string;
    workflowInstanceId?: string;
    channel?: string;
    status?: string;
  }): Promise<{ logs: any[]; nextCursor: string | null }> {
    let url = "/v1/notifications/logs";
    if (options) {
      const params = new URLSearchParams();
      if (options.limit !== undefined) params.append("limit", options.limit.toString());
      if (options.cursor) params.append("cursor", options.cursor);
      if (options.templateId) params.append("templateId", options.templateId);
      if (options.workflowInstanceId)
        params.append("workflowInstanceId", options.workflowInstanceId);
      if (options.channel) params.append("channel", options.channel);
      if (options.status) params.append("status", options.status);
      const str = params.toString();
      if (str) url += `?${str}`;
    }
    return this.request(url, "GET");
  }

  /** List/paginate users. */
  async listUsers(options?: {
    limit?: number;
    cursor?: string;
  }): Promise<{ users: any[]; nextCursor: string | null }> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", options.limit.toString());
    if (options?.cursor) params.set("cursor", options.cursor);
    const qs = params.toString();
    return this.request(`/v1/users${qs ? `?${qs}` : ""}`, "GET");
  }

  /** Delete a template. */
  async deleteTemplate(id: string): Promise<void> {
    return this.request(`/v1/templates/${id}`, "DELETE");
  }

  /** Get a user's contacts. */
  async getUserContacts(userId: string): Promise<{ contacts: any[] }> {
    return this.request(`/v1/users/${userId}/contacts`, "GET");
  }

  /** List projects (Admin only). */
  async listProjects(): Promise<{ projects: any[] }> {
    return this.request("/v1/projects", "GET");
  }

  /** Delete a project (Admin only). */
  async deleteProject(id: string): Promise<void> {
    return this.request(`/v1/projects/${id}`, "DELETE");
  }

  /** Create a new project API key (Admin only). */
  async createProjectKey(
    id: string,
    input?: { role?: "admin" | "read_only" },
  ): Promise<{ id: string; apiKey: string; role: string }> {
    return this.request(`/v1/projects/${id}/keys`, "POST", input || {});
  }

  /** List project API keys (Admin only). */
  async listProjectKeys(id: string): Promise<{ keys: any[] }> {
    return this.request(`/v1/projects/${id}/keys`, "GET");
  }

  /** Delete a project API key (Admin only). */
  async deleteProjectKey(id: string, keyId: string): Promise<void> {
    return this.request(`/v1/projects/${id}/keys/${keyId}`, "DELETE");
  }

  /** Update project settings (Admin only). */
  async updateProject(id: string, input: UpdateProjectInput): Promise<{ id: string }> {
    return this.request(`/v1/projects/${id}`, "PATCH", input);
  }

  /** List unique segment tags. */
  async listSegments(): Promise<{ segments: string[] }> {
    return this.request("/v1/segments", "GET");
  }

  // ─── Campaigns ───────────────────────────────────────────────────────────────

  /** List campaign labels seen in the delivery log, most recent activity first. */
  async listCampaigns(options?: { limit?: number }): Promise<{
    campaigns: {
      campaign: string;
      messages: number;
      firstSentAt: string;
      lastActivityAt: string;
    }[];
  }> {
    const qs = options?.limit ? `?limit=${options.limit}` : "";
    return this.request(`/v1/campaigns${qs}`, "GET");
  }

  /** Delivery and engagement funnel for one campaign. */
  async getCampaignStats(campaign: string): Promise<{
    campaign: string;
    totals: Record<string, number | null>;
    byChannel: Record<string, Record<string, number>>;
    engagementTracked: boolean;
    warnings: string[];
  }> {
    return this.request(`/v1/campaigns/${encodeURIComponent(campaign)}/stats`, "GET");
  }

  // ─── Suppressions ────────────────────────────────────────────────────────────

  /** List suppressed destinations. */
  async listSuppressions(options?: {
    limit?: number;
    channel?: string;
    reason?: string;
  }): Promise<{ suppressions: any[] }> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", options.limit.toString());
    if (options?.channel) params.set("channel", options.channel);
    if (options?.reason) params.set("reason", options.reason);
    const qs = params.toString();
    return this.request(`/v1/suppressions${qs ? `?${qs}` : ""}`, "GET");
  }

  /** Suppress a destination by hand. */
  async createSuppression(input: {
    channel: string;
    target: string;
    reason?: "unsubscribed" | "complained" | "bounced" | "manual";
  }): Promise<{ channel: string; target: string; reason: string }> {
    return this.request("/v1/suppressions", "POST", input);
  }

  /** Remove a suppression, re-enabling sends to that destination. */
  async deleteSuppression(channel: string, target: string): Promise<void> {
    return this.request(
      `/v1/suppressions/${encodeURIComponent(channel)}/${encodeURIComponent(target)}`,
      "DELETE",
    );
  }

  // ─── Notification Status & Cancellation ─────────────────────────────────────

  /** Get real-time status and delivery logs for a specific notification task. */
  async getNotificationStatus(taskId: string): Promise<{ status: string; logs: any[] }> {
    return this.request(`/v1/notifications/${encodeURIComponent(taskId)}`, "GET");
  }

  /** Cancel a scheduled notification task. */
  async cancelNotification(taskId: string): Promise<{ success: boolean }> {
    return this.request(`/v1/notifications/${encodeURIComponent(taskId)}`, "DELETE");
  }

  /** List pending scheduled messages. */
  async getScheduledMessages(): Promise<{ scheduled: any[] }> {
    return this.request("/v1/notifications/scheduled", "GET");
  }

  // ─── User Profile & Preferences ─────────────────────────────────────────────

  /** Get user profile and contacts by ID. */
  async getUser(id: string): Promise<any> {
    return this.request(`/v1/users/${encodeURIComponent(id)}`, "GET");
  }

  /** Get user details including contacts and recent message logs. */
  async getUserDetails(id: string): Promise<any> {
    return this.request(`/v1/users/${encodeURIComponent(id)}/details`, "GET");
  }

  /** Get user preferences. */
  async getUserPreferences(id: string): Promise<any> {
    return this.request(`/v1/users/${encodeURIComponent(id)}/preferences`, "GET");
  }

  /** Update user preferences. */
  async updateUserPreferences(
    id: string,
    preferences: Record<string, any>,
  ): Promise<{ id: string; preferences: any }> {
    return this.request(`/v1/users/${encodeURIComponent(id)}/preferences`, "PATCH", preferences);
  }

  // ─── Templates Querying ─────────────────────────────────────────────────────

  /** List all templates for the project. */
  async listTemplates(): Promise<{ templates: any[] }> {
    return this.request("/v1/templates", "GET");
  }

  /** Get a template by ID. */
  async getTemplate(id: string): Promise<any> {
    return this.request(`/v1/templates/${encodeURIComponent(id)}`, "GET");
  }

  // ─── System Health, Metrics & DLQ ───────────────────────────────────────────

  /** Get system health and worker status. */
  async getSystemHealth(): Promise<any> {
    return this.request("/v1/system/health", "GET");
  }

  /** Get system metrics and queue lengths. */
  async getSystemMetrics(): Promise<any> {
    return this.request("/v1/system/metrics", "GET");
  }

  /** Get dead-letter queue messages. */
  async getDLQMessages(): Promise<{ messages: any[] }> {
    return this.request("/v1/dlq", "GET");
  }

  /** Replay a dead-letter queue message. */
  async replayDLQMessage(id: string): Promise<{ success: boolean; replayedId: string }> {
    return this.request("/v1/dlq/replay", "POST", { id });
  }

  /** Delete a dead-letter queue message. */
  async deleteDLQMessage(id: string): Promise<{ success: boolean }> {
    return this.request(`/v1/dlq/${encodeURIComponent(id)}`, "DELETE");
  }
}
