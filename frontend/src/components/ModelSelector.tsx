"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { api } from "@/lib/api";
import { ChevronDown } from "lucide-react";

interface Model {
  id: string;
  object: string;
}

export function ModelSelector() {
  const { selectedModel, setSelectedModel } = useStore();
  const [models, setModels] = useState<Model[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api.getModels().then((res) => {
      if (res?.data) setModels(res.data);
    });
  }, []);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm text-zinc-300 transition"
      >
        {selectedModel}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-72 max-h-64 overflow-y-auto bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl z-50">
          {models.map((m) => (
            <button
              key={m.id}
              onClick={() => { setSelectedModel(m.id); setOpen(false); }}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-zinc-700 transition ${
                selectedModel === m.id ? "text-blue-400" : "text-zinc-300"
              }`}
            >
              {m.id}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
