import { Link, useLocation } from "react-router-dom";
import {
  Activity,
  History,
  FolderKey,
  Users,
  LayoutDashboard,
  HeartPulse,
  BarChart3,
  AlertTriangle,
  Clock,
  GitFork,
  FileCode2,
  LogOut,
  UserCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";

const navigation = [
  { name: "Live Feed", href: "/", icon: Activity },
  { name: "History Logs", href: "/logs", icon: History },
  { name: "System Health", href: "/system", icon: HeartPulse },
  { name: "Analytics & Queue", href: "/analytics", icon: BarChart3 },
  { name: "Dead Letter (DLQ)", href: "/dlq", icon: AlertTriangle },
  { name: "Scheduled", href: "/scheduled", icon: Clock },
  { name: "Workflows", href: "/workflows", icon: GitFork },
  { name: "Templates", href: "/templates", icon: FileCode2 },
  { name: "Users", href: "/users", icon: Users },
  { name: "Projects & Keys", href: "/projects", icon: FolderKey },
];

export default function Sidebar() {
  const location = useLocation();
  const { user, logout, isAuthenticated } = useAuth();

  const isLoginPage = location.pathname === "/login" || location.pathname === "/login/";
  if (isLoginPage || !isAuthenticated) {
    return null;
  }

  return (
    <div className="flex flex-col w-64 border-r border-border bg-card h-full shrink-0">
      <div className="p-6 border-b border-border flex items-center gap-3">
        <div className="bg-primary text-primary-foreground p-2 rounded-lg">
          <LayoutDashboard className="w-5 h-5" />
        </div>
        <div>
          <h1 className="font-bold text-lg tracking-tight text-foreground">Notifkit</h1>
          <span className="text-[10px] uppercase font-semibold tracking-wider text-muted-foreground">
            Admin Console
          </span>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto p-4 space-y-1">
        {navigation.map((item) => {
          const isActive =
            item.href === "/" ? location.pathname === "/" : location.pathname.startsWith(item.href);

          return (
            <Link
              key={item.name}
              to={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors group relative",
                isActive
                  ? "text-primary-foreground bg-primary shadow-xs"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
            >
              <item.icon
                className={cn(
                  "w-4 h-4 transition-colors",
                  isActive
                    ? "text-primary-foreground"
                    : "text-muted-foreground group-hover:text-foreground",
                )}
              />
              {item.name}
            </Link>
          );
        })}
      </nav>

      {/* Admin User info and logout */}
      <div className="p-4 border-t border-border bg-muted/40 space-y-3">
        {user && (
          <div className="flex items-center gap-2.5 px-2 py-1.5">
            <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center shrink-0 border border-border">
              <UserCheck className="h-3.5 w-3.5 text-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-foreground truncate">
                {user.username || user.email}
              </p>
              <p className="text-[10px] text-muted-foreground capitalize">{user.role}</p>
            </div>
          </div>
        )}
        <button
          onClick={() => void logout()}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs font-medium text-muted-foreground hover:text-destructive hover:bg-destructive/10 border border-transparent transition-colors cursor-pointer"
        >
          <LogOut className="h-3.5 w-3.5" />
          <span>Sign Out</span>
        </button>
      </div>
    </div>
  );
}
