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
} from "lucide-react";
import { cn } from "@/lib/utils";

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

  return (
    <div className="flex flex-col w-64 border-r border-border bg-card/30 backdrop-blur-md h-full shrink-0">
      <div className="p-6 border-b border-border/50 flex items-center gap-3">
        <div className="bg-primary/20 p-2 rounded-lg">
          <LayoutDashboard className="w-6 h-6 text-primary" />
        </div>
        <h1 className="font-bold text-lg tracking-tight bg-gradient-to-br from-foreground to-foreground/70 bg-clip-text text-transparent">
          Notifkit
        </h1>
      </div>

      <nav className="flex-1 overflow-y-auto p-4 space-y-2">
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

      <div className="p-4 border-t border-border/50">
        <div className="text-xs text-muted-foreground text-center">Notifkit Observability v1.0</div>
      </div>
    </div>
  );
}
