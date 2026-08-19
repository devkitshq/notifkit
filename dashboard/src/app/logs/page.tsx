"use client";

import DashboardHeader from "@/components/DashboardHeader";
import LogsTable from "@/components/LogsTable";

export default function LogsPage() {
  return (
    <div className="min-h-full flex flex-col w-full">
      <DashboardHeader isConnected={true} />

      <main className="flex-1 container mx-auto p-4 md:p-6">
        <div className="pb-4">
          <div className="min-h-[500px]">
            <LogsTable />
          </div>
        </div>
      </main>
    </div>
  );
}
