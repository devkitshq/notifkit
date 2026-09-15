import { Routes, Route } from "react-router-dom";
import Sidebar from "@/components/Sidebar";
import { Toaster } from "@/components/ui/sonner";
import HomePage from "@/pages/HomePage";
import LoginPage from "@/pages/LoginPage";
import LogsPage from "@/pages/LogsPage";
import SystemPage from "@/pages/SystemPage";
import AnalyticsPage from "@/pages/AnalyticsPage";
import DlqPage from "@/pages/DlqPage";
import ScheduledPage from "@/pages/ScheduledPage";
import WorkflowsPage from "@/pages/WorkflowsPage";
import TemplatesPage from "@/pages/TemplatesPage";
import UsersPage from "@/pages/UsersPage";
import ProjectsPage from "@/pages/ProjectsPage";

export default function App() {
  return (
    <div className="h-screen flex bg-background text-foreground overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/system" element={<SystemPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/dlq" element={<DlqPage />} />
          <Route path="/scheduled" element={<ScheduledPage />} />
          <Route path="/workflows" element={<WorkflowsPage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="*" element={<HomePage />} />
        </Routes>
      </main>
      <Toaster theme="dark" />
    </div>
  );
}
