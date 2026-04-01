"use client";

import { useStore } from "@/lib/store";
import { Globe } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";

export function StatusBar() {
  const { selectedModel, user } = useStore();
  const toggleRightPanel = useStore((s) => s.toggleRightPanel);

  return (
    <div className="hidden md:flex h-7 px-4 items-center justify-between border-t border-zinc-800 bg-zinc-900 text-xs text-zinc-500">
      <div className="flex items-center gap-4">
        <span>Model: {selectedModel}</span>
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
          Connected
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={toggleRightPanel} className="text-zinc-400 hover:text-white flex items-center gap-1" title="Toggle browser panel">
          <Globe size={12} />
        </button>
        <ThemeToggle />
        <span>{user?.name || "Not logged in"}</span>
      </div>
    </div>
  );
}
