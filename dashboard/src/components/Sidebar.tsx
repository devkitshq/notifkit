"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
  const pathname = usePathname();
  const { user, logout, isAuthenticated } = useAuth();

  const isLoginPage =
    pathname === "/login" ||
    pathname === "/login/" ||
    pathname?.endsWith("/login") ||
    pathname?.endsWith("/login/");
  if (isLoginPage || !isAuthenticated) {
    return null;
  }

  return (
    <div className="flex flex-col w-64 border-r border-border bg-card/30 backdrop-blur-md h-full shrink-0">
      <div className="p-6 border-b border-border/50 flex items-center gap-3">
        <div className="bg-primary/20 p-2 rounded-lg">
          <LayoutDashboard className="w-6 h-6 text-primary" />
        </div>
        <div>
          <h1 className="font-bold text-lg tracking-tight bg-gradient-to-br from-foreground to-foreground/70 bg-clip-text text-transparent">
            Notifkit
          </h1>
          <span className="text-[10px] uppercase font-semibold tracking-wider text-muted-foreground">
            Admin Console
          </span>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto p-4 space-y-1.5">
        {navigation.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 group relative overflow-hidden",
                isActive
                  ? "text-primary bg-primary/10"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
              )}
            >
              {isActive && (
                <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary rounded-r-md" />
              )}
              <item.icon
                className={cn(
                  "w-5 h-5 transition-colors",
                  isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
                )}
              />
              {item.name}
            </Link>
          );
        })}
      </nav>

      {/* Admin User info and logout */}
      <div className="p-4 border-t border-border/50 bg-muted/20 space-y-3">
        {user && (
          <div className="flex items-center gap-2.5 px-2 py-1.5">
            <div className="h-7 w-7 rounded-full bg-primary/20 flex items-center justify-center shrink-0 border border-primary/30">
              <UserCheck className="h-3.5 w-3.5 text-primary" />
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
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:text-destructive hover:bg-destructive/10 border border-transparent hover:border-destructive/20 transition-all cursor-pointer"
        >
          <LogOut className="h-3.5 w-3.5" />
          <span>Sign Out</span>
        </button>
      </div>
    </div>
  );
}
