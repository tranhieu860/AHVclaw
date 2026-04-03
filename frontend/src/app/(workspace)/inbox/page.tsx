'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import {
  Inbox, Search, Send, UserCheck, UserX, Archive,
  MessageSquare, Bot, ChevronRight, RefreshCw,
} from 'lucide-react';

/* ── Types ─────────────────────────────────────────────────── */
interface InboxConversation {
  id: string;
  bot_id: string;
  contact_id: string;
  channel: string;
  channel_chat_id?: string;
  current_agent_id?: string;
  status: string;
  takeover_by?: string;
  created_at: string;
  updated_at: string;
  contact_name?: string;
  bot_name: string;
  last_message?: string;
  last_message_at?: string;
}

interface InboxMessage {
  id: string;
  conversation_id: string;
  direction: string;
  sender_type: string;
  sender_id?: string;
  content?: string;
  attachments?: unknown;
  created_at: string;
}

/* ── Helpers ───────────────────────────────────────────────── */
const STATUS_TABS = [
  { key: '', label: 'Tất cả' },
  { key: 'active', label: 'Hoạt động' },
  { key: 'takeover', label: 'Đã tiếp quản' },
  { key: 'archived', label: 'Lưu trữ' },
] as const;

const channelBadge = (ch: string) => {
  const map: Record<string, { label: string; cls: string }> = {
    telegram: { label: 'TG', cls: 'bg-sky-900/40 text-sky-400' },
    zalo:     { label: 'ZL', cls: 'bg-blue-900/40 text-blue-400' },
    discord:  { label: 'DC', cls: 'bg-indigo-900/40 text-indigo-400' },
  };
  const m = map[ch] || { label: ch.slice(0, 2).toUpperCase(), cls: 'bg-zinc-700 text-zinc-300' };
  return <span className={'text-[10px] px-1.5 py-0.5 rounded font-medium ' + m.cls}>{m.label}</span>;
};

const statusDot = (s: string) => {
  if (s === 'active')   return 'bg-green-500';
  if (s === 'takeover') return 'bg-yellow-500';
  return 'bg-zinc-500';
};

const statusLabel = (s: string) => {
  if (s === 'active')   return 'Hoạt động';
  if (s === 'takeover') return 'Đã tiếp quản';
  if (s === 'archived') return 'Lưu trữ';
  return s;
};

const timeAgo = (d?: string) => {
  if (!d) return '';
  const diff = Date.now() - new Date(d).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'vừa xong';
  if (mins < 60) return mins + 'p';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return hrs + 'h';
  return Math.floor(hrs / 24) + 'd';
};

const fullTime = (d: string) => {
  const dt = new Date(d);
  return dt.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
};

/* ── Component ─────────────────────────────────────────────── */
export default function InboxPage() {
  const { user } = useStore();

  /* ── state ── */
  const [convos, setConvos]       = useState<InboxConversation[]>([]);
  const [selected, setSelected]   = useState<InboxConversation | null>(null);
  const [messages, setMessages]   = useState<InboxMessage[]>([]);
  const [statusTab, setStatusTab] = useState('');
  const [search, setSearch]       = useState('');
  const [reply, setReply]         = useState('');
  const [sending, setSending]     = useState(false);
  const [loading, setLoading]     = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const wsRef     = useRef<WebSocket | null>(null);
  const reconnRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  /* ── load conversations ── */
  const loadConvos = useCallback(async () => {
    try {
      const params: Record<string, string> = {};
      if (statusTab) params.status = statusTab;
      const data = await api.getInbox(params);
      setConvos(data || []);
    } catch {} finally { setLoading(false); }
  }, [statusTab]);

  useEffect(() => { loadConvos(); }, [loadConvos]);

  /* ── load messages for selected ── */
  const loadMessages = useCallback(async (id: string) => {
    setLoadingMsgs(true);
    try {
      const msgs = await api.getInboxConversation(id);
      setMessages(msgs || []);
    } catch {} finally { setLoadingMsgs(false); }
  }, []);

  useEffect(() => {
    if (selected) loadMessages(selected.id);
    else setMessages([]);
  }, [selected, loadMessages]);

  /* auto-scroll */
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  /* ── WebSocket real-time ── */
  const connectWs = useCallback(async () => {
    if (!user) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    try {
      const ws = await api.createEventSocket();
      wsRef.current = ws;
      ws.onmessage = (event) => {
        try {
          const evt = JSON.parse(event.data);
          if (evt.type === 'new_message') {
            const data = evt.data;
            if (selected && data.conversation_id === selected.id) {
              setMessages(prev => [...prev, {
                id: crypto.randomUUID(),
                conversation_id: data.conversation_id,
                direction: data.role === 'user' ? 'inbound' : 'outbound',
                sender_type: data.source || data.role,
                content: data.content,
                created_at: data.created_at || new Date().toISOString(),
              }]);
            }
            loadConvos();
          }
          if (evt.type === 'conversation_updated') {
            loadConvos();
            if (selected) loadMessages(selected.id);
          }
        } catch {}
      };
      ws.onclose = () => { wsRef.current = null; reconnRef.current = setTimeout(connectWs, 3000); };
      ws.onerror = () => { ws.close(); };
    } catch { reconnRef.current = setTimeout(connectWs, 5000); }
  }, [user, selected, loadConvos, loadMessages]);

  useEffect(() => { connectWs(); return () => { clearTimeout(reconnRef.current); wsRef.current?.close(); }; }, [connectWs]);

  /* ── actions ── */
  const doReply = async () => {
    if (!selected || !reply.trim() || sending) return;
    setSending(true);
    try {
      await api.replyToConversation(selected.id, reply.trim());
      setReply('');
      loadMessages(selected.id);
      loadConvos();
    } catch {} finally { setSending(false); }
  };

  const doTakeover = async () => {
    if (!selected) return;
    try { await api.takeoverConversation(selected.id); loadConvos(); setSelected({ ...selected, status: 'takeover' }); } catch {}
  };

  const doRelease = async () => {
    if (!selected) return;
    try { await api.releaseConversation(selected.id); loadConvos(); setSelected({ ...selected, status: 'active' }); } catch {}
  };

  const doArchive = async () => {
    if (!selected) return;
    if (!confirm('Lưu trữ hội thoại này?')) return;
    try { await api.archiveConversation(selected.id); loadConvos(); setSelected(null); } catch {}
  };

  /* ── filtered list ── */
  const filtered = convos.filter(c => {
    if (search) {
      const q = search.toLowerCase();
      const name = (c.contact_name || '').toLowerCase();
      if (!name.includes(q)) return false;
    }
    return true;
  });

  const isTakeover = selected?.status === 'takeover';

  /* ── render ── */
  return (
    <div className="flex-1 flex overflow-hidden">
      {/* ── Left Panel ── */}
      <div className="w-[380px] flex-shrink-0 border-r border-zinc-800 flex flex-col bg-zinc-950/50">
        {/* header */}
        <div className="px-4 pt-5 pb-3">
          <h1 className="text-lg font-semibold text-white flex items-center gap-2 mb-4">
            <Inbox size={20} /> Hộp thư đến
          </h1>
          {/* search */}
          <div className="relative mb-3">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Tìm theo tên liên hệ..."
              className="w-full bg-zinc-800 text-white text-sm rounded-lg pl-8 pr-3 py-2 border border-zinc-700 focus:border-blue-500 outline-none placeholder:text-zinc-500" />
          </div>
          {/* status tabs */}
          <div className="flex gap-1">
            {STATUS_TABS.map(t => (
              <button key={t.key} onClick={() => { setStatusTab(t.key); setSelected(null); }}
                className={'px-3 py-1 rounded-full text-xs font-medium transition ' +
                  (statusTab === t.key ? 'bg-blue-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-white')}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* conversation list */}
        <div className="flex-1 overflow-y-auto">
          {loading && <div className="text-center py-8 text-zinc-500 text-sm">Đang tải...</div>}
          {!loading && filtered.length === 0 && (
            <div className="text-center py-12 text-zinc-500">
              <MessageSquare size={28} className="mx-auto mb-2 opacity-40" />
              <p className="text-sm">Không có hội thoại nào.</p>
            </div>
          )}
          {filtered.map(c => (
            <button key={c.id} onClick={() => setSelected(c)}
              className={'w-full text-left px-4 py-3 border-b border-zinc-800/60 transition hover:bg-zinc-800/50 ' +
                (selected?.id === c.id ? 'bg-zinc-800/70' : '')}>
              <div className="flex items-center gap-2 mb-1">
                <span className={'w-2 h-2 rounded-full flex-shrink-0 ' + statusDot(c.status)} />
                <span className="text-sm font-medium text-white truncate flex-1">
                  {c.contact_name || 'Không rõ'}
                </span>
                {channelBadge(c.channel)}
                <span className="text-[10px] text-zinc-500 flex-shrink-0">{timeAgo(c.last_message_at || c.updated_at)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500 truncate flex-1 pl-4">
                  {c.last_message ? (c.last_message.length > 60 ? c.last_message.slice(0, 60) + '...' : c.last_message) : 'Chưa có tin nhắn'}
                </span>
                <span className="text-[10px] text-zinc-600 flex-shrink-0">{c.bot_name}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ── Right Panel ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-zinc-500">
            <div className="text-center">
              <Inbox size={40} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">Chọn một hội thoại để xem</p>
            </div>
          </div>
        ) : (
          <>
            {/* header */}
            <div className="px-5 py-3 border-b border-zinc-800 flex items-center gap-3 flex-shrink-0">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-white font-medium truncate">{selected.contact_name || 'Không rõ'}</span>
                  {channelBadge(selected.channel)}
                  <span className={'text-[10px] px-2 py-0.5 rounded-full font-medium ' +
                    (selected.status === 'active' ? 'bg-green-900/30 text-green-400' :
                     selected.status === 'takeover' ? 'bg-yellow-900/30 text-yellow-400' :
                     'bg-zinc-700 text-zinc-400')}>
                    {statusLabel(selected.status)}
                  </span>
                </div>
                <div className="text-xs text-zinc-500 mt-0.5">
                  Bot: {selected.bot_name}
                </div>
              </div>
              {/* actions */}
              <div className="flex items-center gap-1.5">
                <button onClick={loadConvos} title="Làm mới"
                  className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition">
                  <RefreshCw size={15} />
                </button>
                {selected.status !== 'takeover' ? (
                  <button onClick={doTakeover} title="Tiếp quản"
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-yellow-600/20 text-yellow-400 hover:bg-yellow-600/30 transition">
                    <UserCheck size={14} /> Tiếp quản
                  </button>
                ) : (
                  <button onClick={doRelease} title="Trả lại cho AI"
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-green-600/20 text-green-400 hover:bg-green-600/30 transition">
                    <Bot size={14} /> Trả lại AI
                  </button>
                )}
                {selected.status !== 'archived' && (
                  <button onClick={doArchive} title="Lưu trữ"
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-700/50 text-zinc-400 hover:text-white transition">
                    <Archive size={14} /> Lưu trữ
                  </button>
                )}
              </div>
            </div>

            {/* messages */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
              {loadingMsgs && <div className="text-center py-8 text-zinc-500 text-sm">Đang tải tin nhắn...</div>}
              {!loadingMsgs && messages.length === 0 && (
                <div className="text-center py-12 text-zinc-500 text-sm">Chưa có tin nhắn nào.</div>
              )}
              {messages.map(m => {
                const isInbound = m.direction === 'inbound' || m.direction === 'user' || m.sender_type === 'user';
                return (
                  <div key={m.id} className={'flex ' + (isInbound ? 'justify-start' : 'justify-end')}>
                    <div className={'max-w-[70%] rounded-xl px-4 py-2.5 ' +
                      (isInbound
                        ? 'bg-zinc-800 text-white'
                        : m.sender_type === 'bot' || m.sender_type === 'ai' || m.sender_type === 'assistant'
                          ? 'bg-blue-600/20 text-blue-100 border border-blue-600/20'
                          : 'bg-green-600/20 text-green-100 border border-green-600/20')}>
                      {!isInbound && (
                        <div className="text-[10px] mb-1 opacity-60">
                          {m.sender_type === 'bot' || m.sender_type === 'ai' || m.sender_type === 'assistant' ? 'AI' : 'Nhân viên'}
                        </div>
                      )}
                      <div className="text-sm whitespace-pre-wrap break-words">{m.content || ''}</div>
                      <div className="text-[10px] mt-1 opacity-40 text-right">{fullTime(m.created_at)}</div>
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>

            {/* reply input */}
            {isTakeover && (
              <div className="px-5 py-3 border-t border-zinc-800 flex-shrink-0">
                <div className="flex gap-2">
                  <input
                    value={reply}
                    onChange={e => setReply(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doReply(); } }}
                    placeholder="Nhập tin nhắn trả lời..."
                    className="flex-1 bg-zinc-800 text-white text-sm rounded-lg px-4 py-2.5 border border-zinc-700 focus:border-blue-500 outline-none placeholder:text-zinc-500"
                    disabled={sending}
                  />
                  <button onClick={doReply} disabled={sending || !reply.trim()}
                    className="px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white transition flex items-center gap-1.5">
                    <Send size={15} />
                  </button>
                </div>
              </div>
            )}
            {!isTakeover && selected.status !== 'archived' && (
              <div className="px-5 py-3 border-t border-zinc-800 flex-shrink-0">
                <div className="text-center text-xs text-zinc-500">
                  <Bot size={14} className="inline mr-1 -mt-0.5" />
                  AI đang phản hồi. Bấm <strong className="text-yellow-400">Tiếp quản</strong> để trả lời thủ công.
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
