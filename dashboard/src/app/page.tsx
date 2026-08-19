"use client";

import { useState } from "react";
import DashboardHeader from "@/components/DashboardHeader";
import RealTimeFeed from "@/components/RealTimeFeed";

export default function Home() {
  const [isConnected, setIsConnected] = useState(false);

  return (
    <div className="min-h-full flex flex-col w-full">
      <DashboardHeader isConnected={isConnected} />

      <main className="flex-1 container mx-auto p-4 md:p-6">
        <div className="pb-4">
          <div className="min-h-[500px]">
            <RealTimeFeed setIsConnected={setIsConnected} />
          </div>
        </div>
      </main>
    </div>
  );
}
