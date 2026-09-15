import type { ReactNode } from "react";
import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";

export interface AdminUser {
  id: string;
  email: string;
  username: string | null;
  role: string;
}

interface AuthContextType {
  user: AdminUser | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (identifier: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  apiUrl: string;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();

  // If VITE_API_URL is configured, use it. Otherwise, use empty string for same-origin calls.
  const apiUrl =
    import.meta.env.VITE_API_URL !== undefined && import.meta.env.VITE_API_URL !== ""
      ? String(import.meta.env.VITE_API_URL).replace(/\/$/, "")
      : "";

  const logout = useCallback(async () => {
    const activeToken =
      token ||
      (typeof window !== "undefined" ? localStorage.getItem("notifkit_admin_token") : null);
    if (activeToken) {
      try {
        await fetch(`${apiUrl}/v1/auth/logout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${activeToken}` },
        });
      } catch {
        // Ignore network errors during logout
      }
    }
    if (typeof window !== "undefined") {
      localStorage.removeItem("notifkit_admin_token");
      localStorage.removeItem("notifkit_admin_user");
    }
    setUser(null);
    setToken(null);
    void navigate("/login");
  }, [apiUrl, token, navigate]);

  const verifySession = useCallback(
    async (existingToken: string) => {
      try {
        const res = await fetch(`${apiUrl}/v1/auth/me`, {
          headers: { Authorization: `Bearer ${existingToken}` },
        });
        if (res.ok) {
          const data = await res.json();
          setUser(data.user);
          setToken(existingToken);
          if (typeof window !== "undefined") {
            localStorage.setItem("notifkit_admin_user", JSON.stringify(data.user));
          }
          return true;
        } else {
          if (typeof window !== "undefined") {
            localStorage.removeItem("notifkit_admin_token");
            localStorage.removeItem("notifkit_admin_user");
          }
          setUser(null);
          setToken(null);
          return false;
        }
      } catch {
        // In offline/network error, fallback to cached user if available
        const cached =
          typeof window !== "undefined" ? localStorage.getItem("notifkit_admin_user") : null;
        if (cached) {
          try {
            setUser(JSON.parse(cached));
            setToken(existingToken);
            return true;
          } catch {
            // ignore parse error
          }
        }
        return false;
      }
    },
    [apiUrl],
  );

  useEffect(() => {
    const initAuth = async () => {
      const storedToken =
        typeof window !== "undefined" ? localStorage.getItem("notifkit_admin_token") : null;
      if (storedToken) {
        await verifySession(storedToken);
      }
      setIsLoading(false);
    };

    void initAuth();
  }, [verifySession]);

  const login = async (
    identifier: string,
    password: string,
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await fetch(`${apiUrl}/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
      });

      const data = await res.json();
      if (!res.ok) {
        return { success: false, error: data.message || "Invalid credentials" };
      }

      setToken(data.token);
      setUser(data.user);
      if (typeof window !== "undefined") {
        localStorage.setItem("notifkit_admin_token", data.token);
        localStorage.setItem("notifkit_admin_user", JSON.stringify(data.user));
      }

      void navigate("/");
      return { success: true };
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Failed to connect to server",
      };
    }
  };

  const isLoginPage = location.pathname === "/login" || location.pathname === "/login/";

  // Route protection
  useEffect(() => {
    if (!isLoading) {
      if (!token && !isLoginPage) {
        void navigate("/login");
      } else if (token && isLoginPage) {
        void navigate("/");
      }
    }
  }, [isLoading, token, isLoginPage, navigate]);

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isLoading,
        isAuthenticated: !!token,
        login,
        logout,
        apiUrl,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
