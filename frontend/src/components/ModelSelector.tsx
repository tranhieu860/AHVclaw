"use client";

import { useEffect, useState, useRef } from "react";
import { useStore } from "@/lib/store";
import { api } from "@/lib/api";
import { ChevronDown, Search, X } from "lucide-react";

interface Model {
  id: string;
  object: string;
}

export function ModelSelector() {
  const { selectedModel, setSelectedModel } = useStore();
  const [models, setModels] = useState<Model[]>([]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getModels().then((res) => {
      if (res?.data) setModels(res.data);
    });
  }, []);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = models.filter(m =>
    m.id.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm text-zinc-300 transition"
      >
        {selectedModel}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-72 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl z-50 max-h-80 overflow-hidden">
          <div className="p-2 border-b border-zinc-700">
            <div className="flex items-center gap-2 bg-zinc-900 rounded px-2 py-1.5">
              <Search size={14} className="text-zinc-400" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search models..."
                className="flex-1 bg-transparent text-white text-sm outline-none placeholder-zinc-500"
                autoFocus
              />
              {search && (
                <button onClick={() => setSearch('')} className="text-zinc-400 hover:text-white">
                  <X size={12} />
                </button>
              )}
            </div>
          </div>
          <div className="overflow-y-auto max-h-64">
            {filtered.map((m) => (
              <button
                key={m.id}
                onClick={() => { setSelectedModel(m.id); setOpen(false); setSearch(''); }}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-zinc-700 transition ${
                  selectedModel === m.id ? "text-blue-400" : "text-zinc-300"
                }`}
              >
                {m.id}
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="text-xs text-zinc-500 p-3 text-center">No models found</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
