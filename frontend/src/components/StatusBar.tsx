"use client";

import { useState, useEffect } from "react";
import { useStore } from "@/lib/store";
import { Globe } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";

export function StatusBar() {
  const { selectedModel, user } = useStore();
  const toggleRightPanel = useStore((s) => s.toggleRightPanel);
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    setIsOnline(navigator.onLine);

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return (
    <div className="hidden md:flex h-7 px-4 items-center justify-between border-t border-zinc-800 bg-zinc-900 text-xs text-zinc-500">
      <div className="flex items-center gap-4">
        <span>Model: {selectedModel}</span>
        <span className="flex items-center gap-1">
          <span className={`w-1.5 h-1.5 rounded-full ${isOnline ? "bg-green-500" : "bg-red-500"}`} />
          {isOnline ? "Đã kết nối" : "Mất kết nối"}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={toggleRightPanel} className="text-zinc-400 hover:text-white flex items-center gap-1" title="Bật/tắt trình duyệt">
          <Globe size={12} />
        </button>
        <ThemeToggle />
        <span>{user?.name || "Chưa đăng nhập"}</span>
      </div>
    </div>
  );
}
