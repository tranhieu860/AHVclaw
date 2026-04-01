'use client';

import { useState } from 'react';
import { Globe, X, ExternalLink, RefreshCw } from 'lucide-react';

interface BrowserPanelProps {
  onClose: () => void;
}

export function BrowserPanel({ onClose }: BrowserPanelProps) {
  const [url, setUrl] = useState('');
  const [inputUrl, setInputUrl] = useState('');
  const [loading, setLoading] = useState(false);

  const navigate = () => {
    let target = inputUrl.trim();
    if (!target) return;
    if (!target.startsWith('http')) target = 'https://' + target;
    setUrl(target);
    setLoading(true);
  };

  return (
    <div className="w-96 border-l border-zinc-800 bg-zinc-950 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900">
        <Globe size={14} className="text-zinc-400 shrink-0" />
        <input
          value={inputUrl}
          onChange={e => setInputUrl(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && navigate()}
          placeholder="Enter URL..."
          className="flex-1 bg-zinc-800 text-white text-xs rounded px-2 py-1 outline-none border border-zinc-700 focus:border-blue-500"
        />
        <button onClick={navigate} className="text-zinc-400 hover:text-white">
          <RefreshCw size={14} />
        </button>
        <button onClick={onClose} className="text-zinc-400 hover:text-white">
          <X size={14} />
        </button>
      </div>

      {/* Browser content */}
      <div className="flex-1 bg-white relative">
        {url ? (
          <>
            <iframe
              src={url}
              className="w-full h-full border-0"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              onLoad={() => setLoading(false)}
            />
            {loading && (
              <div className="absolute inset-0 bg-zinc-950/50 flex items-center justify-center">
                <div className="text-zinc-400 text-sm animate-pulse">Loading...</div>
              </div>
            )}
          </>
        ) : (
          <div className="h-full flex items-center justify-center bg-zinc-950">
            <div className="text-center text-zinc-500">
              <Globe size={32} className="mx-auto mb-2 opacity-50" />
              <p className="text-sm">Enter a URL to browse</p>
            </div>
          </div>
        )}
      </div>

      {/* URL bar */}
      {url && (
        <div className="flex items-center justify-between px-3 py-1 border-t border-zinc-800 bg-zinc-900 text-xs text-zinc-500">
          <span className="truncate">{url}</span>
          <a href={url} target="_blank" rel="noopener noreferrer" className="hover:text-white">
            <ExternalLink size={12} />
          </a>
        </div>
      )}
    </div>
  );
}
