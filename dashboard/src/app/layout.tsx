import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import Sidebar from "@/components/Sidebar";
import { AuthProvider } from "@/hooks/useAuth";
import { ProjectProvider } from "@/hooks/useProjectKey";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Notifkit Observability & Admin",
  description: "Real-time delivery observability dashboard and admin console for Notifkit",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
    >
      <body className="h-screen flex bg-background text-foreground bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-zinc-900 via-background to-background overflow-hidden">
        <AuthProvider>
          <ProjectProvider>
            <Sidebar />
            <main className="flex-1 overflow-y-auto">{children}</main>
            <Toaster theme="dark" />
          </ProjectProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
