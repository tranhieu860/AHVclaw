'use client';

import { useEffect, useState } from 'react';
import { Radio, Plus, Play, Square, Trash2 } from 'lucide-react';

interface Bot {
  id: string;
  name: string;
  channel: string;
  status: string;
  token?: string;
  agent_id?: string;
  last_connected?: string;
  created_at: string;
}

export default function BotsPage() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [formName, setFormName] = useState('');
  const [formChannel, setFormChannel] = useState('telegram');
  const [formToken, setFormToken] = useState('');
  const [formAgentId, setFormAgentId] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3101';
  const headers = () => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${localStorage.getItem('access_token')}`,
  });

  const loadBots = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/bots`, { headers: headers() });
      if (res.ok) setBots(await res.json());
    } catch {}
  };

  useEffect(() => { loadBots(); }, []);

  const addBot = async () => {
    if (!formName || !formToken) return;
    try {
      await fetch(`${baseUrl}/api/bots`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          name: formName,
          channel: formChannel,
          token: formToken,
          agent_id: formAgentId || undefined,
        }),
      });
      setShowAdd(false);
      setFormName(''); setFormToken(''); setFormAgentId('');
      loadBots();
    } catch {}
  };

  const startBot = async (id: string) => {
    try {
      await fetch(`${baseUrl}/api/bots/${id}/start`, { method: 'POST', headers: headers() });
      loadBots();
    } catch {}
  };

  const stopBot = async (id: string) => {
    try {
      await fetch(`${baseUrl}/api/bots/${id}/stop`, { method: 'POST', headers: headers() });
      loadBots();
    } catch {}
  };

  const deleteBot = async (id: string) => {
    try {
      await fetch(`${baseUrl}/api/bots/${id}`, { method: 'DELETE', headers: headers() });
      setDeleteId(null);
      loadBots();
    } catch {}
  };

  const timeAgo = (date?: string) => {
    if (!date) return 'Never';
    const diff = Date.now() - new Date(date).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-white flex items-center gap-2">
          <Radio size={20} /> Bots
        </h1>
        <button onClick={() => setShowAdd(!showAdd)} className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm flex items-center gap-1">
          <Plus size={14} /> New Bot
        </button>
      </div>

      {showAdd && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-6 space-y-3">
          <input placeholder="Bot Name" value={formName} onChange={e => setFormName(e.target.value)}
            className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
          <select value={formChannel} onChange={e => setFormChannel(e.target.value)}
            className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none">
            <option value="telegram">Telegram</option>
            <option value="zalo">Zalo</option>
            <option value="discord">Discord</option>
          </select>
          <input placeholder="Bot Token" value={formToken} onChange={e => setFormToken(e.target.value)}
            className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
          <input placeholder="Agent ID (optional)" value={formAgentId} onChange={e => setFormAgentId(e.target.value)}
            className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
          <button onClick={addBot} className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded text-sm">Create Bot</button>
        </div>
      )}

      {deleteId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-6 max-w-sm w-full mx-4">
            <h3 className="text-white font-medium mb-2">Delete Bot?</h3>
            <p className="text-sm text-zinc-400 mb-4">This action cannot be undone. The bot will be stopped and removed.</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleteId(null)} className="px-3 py-1.5 rounded text-sm text-zinc-400 hover:text-white">Cancel</button>
              <button onClick={() => deleteBot(deleteId)} className="bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded text-sm">Delete</button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {bots.map(bot => (
          <div key={bot.id} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 hover:border-zinc-700 transition">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-blue-600/20 flex items-center justify-center">
                  <Radio size={20} className="text-blue-400" />
                </div>
                <div>
                  <h3 className="text-white font-medium">{bot.name}</h3>
                  <p className="text-xs text-zinc-500 capitalize">{bot.channel}</p>
                </div>
              </div>
              <span className={`flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full ${
                bot.status === 'running' ? 'bg-green-900/30 text-green-400' : 'bg-zinc-800 text-zinc-500'
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${bot.status === 'running' ? 'bg-green-400' : 'bg-zinc-500'}`} />
                {bot.status === 'running' ? 'Running' : 'Stopped'}
              </span>
            </div>
            <div className="flex items-center justify-between mt-4">
              <span className="text-xs text-zinc-500">Last connected: {timeAgo(bot.last_connected)}</span>
              <div className="flex items-center gap-1">
                {bot.status !== 'running' ? (
                  <button onClick={() => startBot(bot.id)} className="p-1.5 rounded hover:bg-zinc-800 text-green-400" title="Start">
                    <Play size={14} />
                  </button>
                ) : (
                  <button onClick={() => stopBot(bot.id)} className="p-1.5 rounded hover:bg-zinc-800 text-yellow-400" title="Stop">
                    <Square size={14} />
                  </button>
                )}
                <button onClick={() => setDeleteId(bot.id)} className="p-1.5 rounded hover:bg-zinc-800 text-red-400" title="Delete">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          </div>
        ))}
        {bots.length === 0 && !showAdd && (
          <div className="col-span-full text-center py-12 text-zinc-500">
            <Radio size={32} className="mx-auto mb-3 opacity-50" />
            <p>No bots configured. Create a bot to connect to messaging channels.</p>
          </div>
        )}
      </div>
    </div>
  );
}
