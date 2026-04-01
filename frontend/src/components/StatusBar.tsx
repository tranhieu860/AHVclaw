"use client";

import { useStore } from "@/lib/store";

export function StatusBar() {
  const { selectedModel, user } = useStore();

  return (
    <div className="h-7 px-4 flex items-center justify-between border-t border-zinc-800 bg-zinc-900 text-xs text-zinc-500">
      <div className="flex items-center gap-4">
        <span>Model: {selectedModel}</span>
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
          Connected
        </span>
      </div>
      <div>{user?.name || "Not logged in"}</div>
    </div>
  );
}
