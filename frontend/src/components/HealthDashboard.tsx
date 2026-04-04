"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface HealthEntry {
  id: string;
  name: string;
  provider_type: string;
  test_status: string;
  error_code: number;
  last_error: string;
  last_error_at: string | null;
  backoff_level: number;
  is_active: boolean;
}

const statusColors: Record<string, string> = {
  active: "bg-green-500",
  pending: "bg-yellow-500",
  error: "bg-red-500",
  unavailable: "bg-red-700",
};

const statusLabels: Record<string, string> = {
  active: "Hoạt động",
  pending: "Chưa test",
  error: "Lỗi",
  unavailable: "Không khả dụng",
};

export default function HealthDashboard() {
  const [entries, setEntries] = useState<HealthEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadHealth();
    const interval = setInterval(loadHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  async function loadHealth() {
    try {
      const data = await api.getConnectionHealth();
      setEntries(data || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="text-zinc-400 text-sm">Đang tải...</div>;
  if (entries.length === 0) return <div className="text-zinc-500 text-sm">Chưa có kết nối nào.</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-300">Trạng thái kết nối</h3>
        <button onClick={loadHealth} className="text-xs text-zinc-500 hover:text-zinc-300 transition">
          ↻ Làm mới
        </button>
      </div>
      <div className="grid gap-2">
        {entries.map((e) => (
          <div
            key={e.id}
            className="flex items-center gap-3 px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg"
          >
            <div className={`w-2 h-2 rounded-full ${statusColors[e.test_status] || "bg-gray-500"}`} />
            <div className="flex-1 min-w-0">
              <div className="text-sm text-zinc-200 truncate">{e.name}</div>
              <div className="text-xs text-zinc-500">{e.provider_type}</div>
            </div>
            <div className="text-right">
              <div className="text-xs text-zinc-400">
                {statusLabels[e.test_status] || e.test_status}
              </div>
              {e.backoff_level > 0 && (
                <div className="text-xs text-orange-400">Backoff: {e.backoff_level}</div>
              )}
            </div>
            {!e.is_active && (
              <span className="text-xs bg-zinc-700 text-zinc-400 px-1.5 py-0.5 rounded">OFF</span>
            )}
          </div>
        ))}
      </div>
      {entries.some((e) => e.last_error && e.test_status !== "active") && (
        <details className="text-xs text-zinc-500">
          <summary className="cursor-pointer hover:text-zinc-300">Xem lỗi gần đây</summary>
          <div className="mt-2 space-y-1 pl-2 border-l border-zinc-800">
            {entries
              .filter((e) => e.last_error && e.test_status !== "active")
              .map((e) => (
                <div key={e.id}>
                  <span className="text-red-400">{e.name}:</span> {e.last_error}
                </div>
              ))}
          </div>
        </details>
      )}
    </div>
  );
}
