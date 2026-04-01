'use client';

import { useEffect, useState } from 'react';
import { Inbox, Send, UserCheck, UserX, Archive, MessageSquare } from 'lucide-react';

interface InboxItem {
  id: string;
  contact_name: string;
  last_message: string;
  channel: string;
  status: string;
  updated_at: string;
}

interface ChatMessage {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

export default function InboxPage() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [reply, setReply] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterChannel, setFilterChannel] = useState('all');

  const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3101';
  const headers = () => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${localStorage.getItem('access_token')}`,
  });

  const loadInbox = async () => {
    try {
      const params = new URLSearchParams();
      if (filterStatus !== 'all') params.set('status', filterStatus);
      if (filterChannel !== 'all') params.set('channel', filterChannel);
      const res = await fetch(`${baseUrl}/api/inbox?${params}`, { headers: headers() });
      if (res.ok) setItems(await res.json());
    } catch {}
  };

  const loadMessages = async (id: string) => {
    try {
      const res = await fetch(`${baseUrl}/api/inbox/${id}`, { headers: headers() });
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages || data || []);
      }
    } catch {}
  };

  useEffect(() => { loadInbox(); }, [filterStatus, filterChannel]);

  const selectConversation = (id: string) => {
    setSelected(id);
    loadMessages(id);
  };

  const sendReply = async () => {
    if (!reply.trim() || !selected) return;
    try {
      await fetch(`${baseUrl}/api/inbox/${selected}/reply`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ content: reply }),
      });
      setReply('');
      loadMessages(selected);
    } catch {}
  };

  const takeover = async () => {
    if (!selected) return;
    try {
      await fetch(`${baseUrl}/api/inbox/${selected}/takeover`, { method: 'POST', headers: headers() });
      loadInbox();
    } catch {}
  };

  const release = async () => {
    if (!selected) return;
    try {
      await fetch(`${baseUrl}/api/inbox/${selected}/release`, { method: 'POST', headers: headers() });
      loadInbox();
    } catch {}
  };

  const timeAgo = (date: string) => {
    const diff = Date.now() - new Date(date).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  };

  const channelBadge = (ch: string) => {
    const colors: Record<string, string> = {
      telegram: 'bg-blue-900/30 text-blue-400',
      zalo: 'bg-indigo-900/30 text-indigo-400',
      discord: 'bg-purple-900/30 text-purple-400',
    };
    return colors[ch] || 'bg-zinc-800 text-zinc-400';
  };

  const selectedItem = items.find(i => i.id === selected);

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Left panel */}
      <div className="w-80 border-r border-zinc-800 flex flex-col bg-zinc-950">
        <div className="p-3 border-b border-zinc-800">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2 mb-3">
            <Inbox size={16} /> Inbox
          </h2>
          <div className="flex gap-2">
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
              className="flex-1 bg-zinc-800 text-xs text-white rounded px-2 py-1 border border-zinc-700 outline-none">
              <option value="all">All Status</option>
              <option value="open">Open</option>
              <option value="bot">Bot</option>
              <option value="human">Human</option>
              <option value="archived">Archived</option>
            </select>
            <select value={filterChannel} onChange={e => setFilterChannel(e.target.value)}
              className="flex-1 bg-zinc-800 text-xs text-white rounded px-2 py-1 border border-zinc-700 outline-none">
              <option value="all">All Channels</option>
              <option value="telegram">Telegram</option>
              <option value="zalo">Zalo</option>
              <option value="discord">Discord</option>
            </select>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {items.map(item => (
            <button key={item.id} onClick={() => selectConversation(item.id)}
              className={`w-full text-left px-3 py-3 border-b border-zinc-800/50 hover:bg-zinc-800/50 transition ${selected === item.id ? 'bg-zinc-800' : ''}`}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-white font-medium truncate">{item.contact_name || 'Unknown'}</span>
                <span className="text-[10px] text-zinc-500 shrink-0">{timeAgo(item.updated_at)}</span>
              </div>
              <p className="text-xs text-zinc-500 truncate">{item.last_message}</p>
              <span className={`inline-block mt-1 text-[10px] px-1.5 py-0.5 rounded ${channelBadge(item.channel)}`}>{item.channel}</span>
            </button>
          ))}
          {items.length === 0 && (
            <div className="text-center py-8 text-zinc-500 text-sm">No conversations</div>
          )}
        </div>
      </div>

      {/* Right panel */}
      <div className="flex-1 flex flex-col">
        {selected && selectedItem ? (
          <>
            <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
              <div>
                <h3 className="text-white font-medium">{selectedItem.contact_name || 'Unknown'}</h3>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${channelBadge(selectedItem.channel)}`}>{selectedItem.channel}</span>
              </div>
              <div className="flex gap-1">
                <button onClick={takeover} className="p-1.5 rounded hover:bg-zinc-800 text-blue-400" title="Takeover"><UserCheck size={16} /></button>
                <button onClick={release} className="p-1.5 rounded hover:bg-zinc-800 text-yellow-400" title="Release"><UserX size={16} /></button>
                <button className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400" title="Archive"><Archive size={16} /></button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.map(msg => (
                <div key={msg.id} className={`flex ${msg.role === 'user' || msg.role === 'contact' ? 'justify-start' : 'justify-end'}`}>
                  <div className={`max-w-[70%] rounded-lg px-3 py-2 text-sm ${
                    msg.role === 'user' || msg.role === 'contact' ? 'bg-zinc-800 text-zinc-200' : 'bg-blue-600 text-white'
                  }`}>
                    {msg.content}
                    <div className="text-[10px] opacity-50 mt-1">{new Date(msg.created_at).toLocaleTimeString()}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="p-3 border-t border-zinc-800">
              <div className="flex gap-2">
                <input value={reply} onChange={e => setReply(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); } }}
                  placeholder="Type a reply..."
                  className="flex-1 bg-zinc-800 text-white text-sm rounded-lg px-3 py-2 border border-zinc-700 outline-none focus:border-blue-500" />
                <button onClick={sendReply} disabled={!reply.trim()}
                  className="p-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-30 text-white">
                  <Send size={16} />
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-zinc-500">
            <div className="text-center">
              <MessageSquare size={32} className="mx-auto mb-3 opacity-50" />
              <p>Select a conversation to view messages</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
