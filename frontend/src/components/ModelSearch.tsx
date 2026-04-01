'use client';

import { useState, useEffect, useRef } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';

interface ModelSearchProps {
  value: string;
  onChange: (model: string) => void;
  label?: string;
  placeholder?: string;
}

export function ModelSearch({ value, onChange, label, placeholder }: ModelSearchProps) {
  const [models, setModels] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3101';

  useEffect(() => {
    const fetchModels = async () => {
      setLoading(true);
      try {
        const res = await fetch(`${baseUrl}/api/models`, {
          headers: { Authorization: `Bearer ${localStorage.getItem('access_token')}` },
        });
        if (res.ok) {
          const data = await res.json();
          const ids = (data.data || data || []).map((m: any) => m.id || m);
          setModels(ids);
        }
      } catch {}
      setLoading(false);
    };
    fetchModels();
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
    m.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div ref={ref} className="relative">
      {label && <label className="block text-xs text-zinc-400 mb-1">{label}</label>}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 hover:border-zinc-600"
      >
        <span className={value ? 'text-white' : 'text-zinc-500'}>
          {value || placeholder || 'Select model...'}
        </span>
        <ChevronDown size={14} className="text-zinc-400" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl max-h-64 overflow-hidden">
          <div className="p-2 border-b border-zinc-800">
            <div className="flex items-center gap-2 bg-zinc-800 rounded px-2 py-1.5">
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
          <div className="overflow-y-auto max-h-48">
            {loading && <p className="text-xs text-zinc-500 p-2">Loading...</p>}
            {filtered.map(m => (
              <button
                key={m}
                type="button"
                onClick={() => { onChange(m); setOpen(false); setSearch(''); }}
                className={`w-full text-left px-3 py-1.5 text-sm hover:bg-zinc-800 ${
                  m === value ? 'text-blue-400 bg-zinc-800/50' : 'text-zinc-300'
                }`}
              >
                {m}
              </button>
            ))}
            {filtered.length === 0 && !loading && (
              <p className="text-xs text-zinc-500 p-3 text-center">No models found</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
