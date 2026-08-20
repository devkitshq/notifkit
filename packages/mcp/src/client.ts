/**
 * A minimal HTTP client for the notifkit API.
 *
 * Deliberately self-contained rather than importing `NotifkitClient` from the
 * root package: that entrypoint re-exports the db, redis, and config modules,
 * which would pull Postgres and Redis drivers into a process whose only job is
 * to speak JSON-RPC over stdio.
 */

export interface NotifkitApiOptions {
  baseUrl: string;
  apiKey: string;
  /** Required when `apiKey` is the admin key; project-scoped keys carry their own project. */
  projectId?: string;
}

export class NotifkitApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "NotifkitApiError";
  }
}

export class NotifkitApi {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(options: NotifkitApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
      ...(options.projectId ? { "x-project-id": options.projectId } : {}),
    };
  }

  async request<T>(
    method: string,
    path: string,
    options?: { body?: unknown; query?: Record<string, string | number | undefined> },
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;

    if (options?.query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) params.set(key, String(value));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const res = await fetch(url, {
      method,
      headers: this.headers,
      body: options?.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!res.ok) {
      const record =
        typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
      const message =
        typeof record["message"] === "string"
          ? record["message"]
          : typeof record["error"] === "string"
            ? record["error"]
            : `Request failed with status ${res.status}`;
      throw new NotifkitApiError(message, res.status, data);
    }

    return data as T;
  }

  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, { body });
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, { body });
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }
}
