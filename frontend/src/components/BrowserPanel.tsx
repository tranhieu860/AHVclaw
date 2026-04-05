'use client';

import { useState, useEffect, useRef } from 'react';
import { Globe, X, Monitor, Plug, Download } from 'lucide-react';
import { getLastBrowserUpdate, isExtensionOnline } from '@/lib/useEvents';

interface BrowserPanelProps {
  onClose: () => void;
}

interface BrowserState {
  source: 'playwright' | 'extension' | 'idle';
  screenshot: string;
  url: string;
  title: string;
  action: string;
  cursor?: { x: number; y: number };
}

export function BrowserPanel({ onClose }: BrowserPanelProps) {
  const [state, setState] = useState<BrowserState>({
    source: 'idle', screenshot: '', url: '', title: '', action: '',
  });
  const [extOnline, setExtOnline] = useState(isExtensionOnline());

  // Check cached state on mount
  useEffect(() => {
    const cached = getLastBrowserUpdate();
    if (cached && cached.data) {
      setState({
        source: cached.data.source || 'playwright',
        screenshot: cached.data.screenshot || '',
        url: cached.data.url || '',
        title: cached.data.title || '',
        action: cached.data.action || '',
        cursor: cached.data.cursor,
      });
    }
  }, []);

  useEffect(() => {
    const handler = (event: CustomEvent) => {
      const data = event.detail;
      if (data.type === 'browser_update' && data.data) {
        setState({
          source: data.data.source || 'playwright',
          screenshot: data.data.screenshot || '',
          url: data.data.url || '',
          title: data.data.title || '',
          action: data.data.action || '',
          cursor: data.data.cursor,
        });
      }
    };
    window.addEventListener('ahvclaw-event', handler as EventListener);
    return () => window.removeEventListener('ahvclaw-event', handler as EventListener);
  }, []);

  useEffect(() => {
    const handler = (event: CustomEvent) => {
      setExtOnline(event.detail?.online || false);
    };
    window.addEventListener('ahvclaw-extension-status', handler as EventListener);
    return () => window.removeEventListener('ahvclaw-extension-status', handler as EventListener);
  }, []);

  const sourceBadge = state.source === 'extension'
    ? { label: 'Extension', color: 'bg-blue-500' }
    : state.source === 'playwright'
    ? { label: 'Playwright', color: 'bg-green-500' }
    : { label: 'Idle', color: 'bg-zinc-500' };

  return (
    <div className="flex-1 bg-zinc-950 flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900">
        <Globe size={14} className="text-zinc-400 shrink-0" />
        <div className="flex-1 bg-zinc-800 text-white text-xs rounded px-2 py-1 border border-zinc-700 truncate">
          {state.url || 'Waiting for AGI browser activity...'}
        </div>
        <div className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium text-white ${sourceBadge.color}`}>
          {state.source === 'extension' ? <Plug size={10} /> : <Monitor size={10} />}
          {sourceBadge.label}
        </div>
        <div className="flex items-center gap-1 text-[10px]" title={extOnline ? 'Extension: Online' : 'Extension: Offline'}>
          <div className={`w-2 h-2 rounded-full ${extOnline ? 'bg-green-500 shadow-[0_0_4px_#22c55e]' : 'bg-zinc-600'}`} />
          <span className={extOnline ? 'text-green-400' : 'text-zinc-600'}>Ext</span>
        </div>
        <button onClick={onClose} className="text-zinc-400 hover:text-white">
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 bg-zinc-950 relative overflow-hidden">
        {state.screenshot ? (
          <>
            <img
              src={`data:image/jpeg;base64,${state.screenshot}`}
              alt="Browser view"
              className="w-full h-full object-contain"
            />
            {state.cursor && (
              <div
                className="absolute w-4 h-4 rounded-full border-2 border-red-500 bg-red-500/30 pointer-events-none"
                style={{
                  left: `${state.cursor.x}px`,
                  top: `${state.cursor.y}px`,
                  transform: 'translate(-50%, -50%)',
                }}
              />
            )}
          </>
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="text-center text-zinc-500">
              <Globe size={32} className="mx-auto mb-2 opacity-50" />
              <p className="text-sm">Đang chờ AGI thao tác trình duyệt...</p>
              <p className="text-xs mt-1 text-zinc-600">Screenshots sẽ hiển thị ở đây</p>
              <a
                href="/downloads/ahvclaw-extension.zip"
                download
                className="inline-flex items-center gap-1.5 mt-4 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg transition-colors"
              >
                <Download size={12} />
                Tải Extension Chrome
              </a>
              <p className="text-[10px] mt-2 text-zinc-600">
                Cài extension để AGI điều khiển trình duyệt của bạn
              </p>
            </div>
          </div>
        )}
      </div>

      {state.action && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-t border-zinc-800 bg-zinc-900">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="text-xs text-zinc-400 truncate">{state.action}</span>
        </div>
      )}

      {state.title && (
        <div className="px-3 py-1 border-t border-zinc-800 bg-zinc-900 text-xs text-zinc-500 truncate">
          {state.title}
        </div>
      )}
    </div>
  );
}
