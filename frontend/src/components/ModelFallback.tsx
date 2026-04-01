'use client';

interface ModelFallbackProps {
  value: string;
  onChange: (value: string) => void;
}

export function ModelFallback({ value, onChange }: ModelFallbackProps) {
  return (
    <div>
      <label className="block text-xs text-zinc-400 mb-1">Fallback Models</label>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="e.g. AHV-Holding, cc/claude-sonnet-4-6"
        className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none"
      />
      <p className="text-[10px] text-zinc-500 mt-1">Comma-separated. Used when primary model fails.</p>
    </div>
  );
}
