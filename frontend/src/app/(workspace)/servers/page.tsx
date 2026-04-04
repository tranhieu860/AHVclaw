'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Server, Plus, Trash2, Activity, Send, Cpu, HardDrive, Shield, Wrench, BarChart3 } from 'lucide-react';

interface ServerItem {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  environment: string;
  last_connected_at: string | null;
}

interface ChatMessage {
  id: string;
  role: string;
  content: string | null;
  created_at: string;
}

const QUICK_ACTIONS = [
  { icon: Cpu, label: 'Tổng quan hệ thống', prompt: 'Kiểm tra tổng quan hệ thống: CPU, RAM, disk, uptime, load average. Phân tích và đề xuất nếu có vấn đề.' },
  { icon: HardDrive, label: 'Disk & Storage', prompt: 'Kiểm tra dung lượng ổ đĩa, tìm file/folder lớn nhất, kiểm tra inode usage. Đề xuất dọn dẹp nếu cần.' },
  { icon: Shield, label: 'Bảo mật', prompt: 'Kiểm tra bảo mật server: firewall status, listening ports, failed SSH attempts, user accounts, sudo logs. Báo cáo rủi ro.' },
  { icon: BarChart3, label: 'Services', prompt: 'Liệt kê tất cả services đang chạy, kiểm tra status, port listening, memory usage mỗi service. Cảnh báo service nào bất thường.' },
  { icon: Wrench, label: 'Tối ưu hóa', prompt: 'Phân tích hiệu suất server và đề xuất các cải thiện: swap, kernel params, nginx/postgres tuning nếu có. Đưa ra hành động cụ thể.' },
];

export default function ServersPage() {
  const [servers, setServers] = useState<ServerItem[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedServer, setSelectedServer] = useState<ServerItem | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [toolActivity, setToolActivity] = useState<string | null>(null);
  const [serverStatus, setServerStatus] = useState<Record<string, 'online' | 'offline' | 'loading' | null>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedModel = 'AHV-Holding-TroLy';

  // Form
  const [formName, setFormName] = useState('');
  const [formHost, setFormHost] = useState('');
  const [formPort, setFormPort] = useState('22');
  const [formUser, setFormUser] = useState('root');
  const [formPass, setFormPass] = useState('');
  const [formEnv, setFormEnv] = useState('dev');

  const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3101';
  const headers = () => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${localStorage.getItem('access_token')}`,
  });

  const loadServers = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/servers`, { headers: headers() });
      if (res.ok) setServers(await res.json());
    } catch {}
  };

  useEffect(() => { loadServers(); }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, toolActivity]);

  const addServer = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/servers`, {
        method: 'POST', headers: headers(),
        body: JSON.stringify({
          name: formName, host: formHost, port: parseInt(formPort),
          username: formUser, credentials: formPass, auth_type: 'password',
          environment: formEnv,
        }),
      });
      if (res.ok) {
        setShowAdd(false);
        setFormName(''); setFormHost(''); setFormPass('');
        loadServers();
      }
    } catch {}
  };

  const deleteServer = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Xóa máy chủ này?')) return;
    await fetch(`${baseUrl}/api/servers/${id}`, { method: 'DELETE', headers: headers() });
    if (selectedServer?.id === id) {
      setSelectedServer(null);
      setConversationId(null);
      setMessages([]);
    }
    loadServers();
  };

  const selectServer = async (server: ServerItem) => {
    setSelectedServer(server);
    setMessages([]);
    setConversationId(null);

    try {
      const res = await fetch(`${baseUrl}/api/servers/${server.id}/conversation`, { headers: headers() });
      if (!res.ok) return;
      const data = await res.json();
      setConversationId(data.conversation_id);

      const msgRes = await fetch(`${baseUrl}/api/conversations/${data.conversation_id}`, { headers: headers() });
      if (msgRes.ok) {
        const msgData = await msgRes.json();
        setMessages(msgData.messages || msgData || []);
      }
    } catch {}

    setTimeout(() => inputRef.current?.focus(), 100);
  };

  const checkServerStatus = async (id: string) => {
    setServerStatus(prev => ({ ...prev, [id]: 'loading' }));
    try {
      const res = await fetch(`${baseUrl}/api/servers/${id}/status`, { headers: headers() });
      setServerStatus(prev => ({ ...prev, [id]: res.ok ? 'online' : 'offline' }));
    } catch {
      setServerStatus(prev => ({ ...prev, [id]: 'offline' }));
    }
  };

  // Check all servers on load
  useEffect(() => {
    servers.forEach(s => checkServerStatus(s.id));
  }, [servers]);

  const updateLastAssistant = (updater: (content: string) => string) => {
    setMessages(prev => {
      const msgs = [...prev];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant') {
          msgs[i] = { ...msgs[i], content: updater(msgs[i].content || '') };
          break;
        }
      }
      return msgs;
    });
  };

  const sendMessage = useCallback(async (overrideContent?: string) => {
    const content = (overrideContent || input).trim();
    if (!content || isStreaming) return;
    if (!overrideContent) setInput('');

    setMessages(prev => [...prev,
      { id: crypto.randomUUID(), role: 'user', content, created_at: new Date().toISOString() },
      { id: crypto.randomUUID(), role: 'assistant', content: '', created_at: new Date().toISOString() },
    ]);

    setIsStreaming(true);
    setToolActivity(null);

    try {
      const ticketRes = await fetch(`${baseUrl}/api/ws/ticket`, { method: 'POST', headers: headers() });
      const { ticket } = await ticketRes.json();
      const wsUrl = baseUrl.replace('http', 'ws');
      const ws = new WebSocket(`${wsUrl}/ws/chat?ticket=${ticket}`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'chat',
          data: { conversation_id: conversationId, content, model: selectedModel, attachments: [] },
        }));
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'delta': {
            const delta = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
            if (delta.done) {
              setIsStreaming(false);
              setToolActivity(null);
              ws.close();
            } else if (delta.content) {
              updateLastAssistant(prev => prev + delta.content);
            }
            break;
          }
          case 'conversation_id': {
            const id = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
            setConversationId(typeof id === 'object' ? id.id : id);
            break;
          }
          case 'tool_call': {
            const data = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
            setToolActivity(`${data.name}...`);
            break;
          }
          case 'tool_result': {
            setToolActivity(null);
            const result = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
            const txt = result.error
              ? `\n\n> **Lỗi (${result.name}):** ${result.error}`
              : `\n\n> **${result.name}:** ${(result.content || 'Done').substring(0, 800)}`;
            updateLastAssistant(prev => prev + txt);
            break;
          }
          case 'error': {
            setIsStreaming(false);
            setToolActivity(null);
            const errData = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
            updateLastAssistant(prev => prev + '\n\n**Lỗi:** ' + errData.message);
            ws.close();
            break;
          }
        }
      };

      ws.onerror = () => { setIsStreaming(false); setToolActivity(null); };
      ws.onclose = () => { setIsStreaming(false); };
    } catch {
      setIsStreaming(false);
      updateLastAssistant(() => 'Lỗi kết nối. Vui lòng thử lại.');
    }
  }, [input, conversationId, selectedModel, isStreaming, baseUrl]);

  const envColor = (env: string) =>
    env === 'production' ? 'bg-red-500/10 text-red-400 border-red-500/20' :
    env === 'staging' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
    'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';

  const statusDot = (id: string) => {
    const s = serverStatus[id];
    if (s === 'loading') return 'bg-yellow-500 animate-pulse';
    if (s === 'online') return 'bg-green-500';
    if (s === 'offline') return 'bg-red-500';
    return 'bg-zinc-600';
  };

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Server list */}
      <div className="w-72 border-r border-zinc-800 flex flex-col bg-zinc-950">
        <div className="flex items-center justify-between p-3 border-b border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-300 flex items-center gap-1.5">
            <Server size={14} /> Máy chủ
          </h2>
          <button onClick={() => setShowAdd(!showAdd)}
            className="text-zinc-400 hover:text-white hover:bg-zinc-800 p-1 rounded transition">
            <Plus size={16} />
          </button>
        </div>

        {showAdd && (
          <div className="p-3 border-b border-zinc-800 space-y-2">
            <input placeholder="Tên" value={formName} onChange={e => setFormName(e.target.value)}
              className="w-full bg-zinc-900 text-white rounded px-2.5 py-1.5 text-xs border border-zinc-700 focus:border-blue-500 outline-none" />
            <input placeholder="IP / Hostname" value={formHost} onChange={e => setFormHost(e.target.value)}
              className="w-full bg-zinc-900 text-white rounded px-2.5 py-1.5 text-xs border border-zinc-700 focus:border-blue-500 outline-none" />
            <div className="grid grid-cols-2 gap-2">
              <input placeholder="Port" value={formPort} onChange={e => setFormPort(e.target.value)}
                className="bg-zinc-900 text-white rounded px-2.5 py-1.5 text-xs border border-zinc-700 outline-none" />
              <input placeholder="User" value={formUser} onChange={e => setFormUser(e.target.value)}
                className="bg-zinc-900 text-white rounded px-2.5 py-1.5 text-xs border border-zinc-700 outline-none" />
            </div>
            <input placeholder="Mật khẩu" type="password" value={formPass} onChange={e => setFormPass(e.target.value)}
              className="w-full bg-zinc-900 text-white rounded px-2.5 py-1.5 text-xs border border-zinc-700 outline-none" />
            <select value={formEnv} onChange={e => setFormEnv(e.target.value)}
              className="w-full bg-zinc-900 text-white rounded px-2.5 py-1.5 text-xs border border-zinc-700 outline-none">
              <option value="dev">Development</option>
              <option value="staging">Staging</option>
              <option value="production">Production</option>
            </select>
            <button onClick={addServer}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white py-1.5 rounded text-xs font-medium transition">
              Thêm máy chủ
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {servers.map(s => (
            <div key={s.id}
              className={`rounded-lg p-2.5 cursor-pointer transition group ${
                selectedServer?.id === s.id
                  ? 'bg-blue-600/15 border border-blue-500/40'
                  : 'hover:bg-zinc-900/80 border border-transparent'
              }`}
              onClick={() => selectServer(s)}>
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDot(s.id)}`} />
                <span className="text-sm font-medium text-white truncate flex-1">{s.name}</span>
                <button onClick={(e) => { e.stopPropagation(); deleteServer(s.id, e); }}
                  className="text-zinc-600 hover:text-red-400 p-0.5 opacity-0 group-hover:opacity-100 transition">
                  <Trash2 size={11} />
                </button>
              </div>
              <div className="flex items-center gap-2 mt-1 ml-4">
                <span className="text-[10px] text-zinc-500 font-mono">{s.host}</span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded border ${envColor(s.environment)}`}>
                  {s.environment}
                </span>
              </div>
            </div>
          ))}
          {servers.length === 0 && (
            <div className="text-center py-16 text-zinc-700 text-xs">
              <Server size={28} className="mx-auto mb-2 opacity-20" />
              <p>Chưa có máy chủ</p>
              <p className="mt-1 text-[10px]">Thêm server để bắt đầu quản lý bằng AI</p>
            </div>
          )}
        </div>
      </div>

      {/* Chat panel */}
      <div className="flex-1 flex flex-col bg-zinc-950">
        {selectedServer ? (
          <>
            <div className="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800">
              <div className={`w-2.5 h-2.5 rounded-full ${statusDot(selectedServer.id)}`} />
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-white">{selectedServer.name}</h3>
                <p className="text-[10px] text-zinc-500 font-mono">{selectedServer.host}:{selectedServer.port}</p>
              </div>
              <span className={`text-[10px] px-2 py-0.5 rounded border ${envColor(selectedServer.environment)}`}>
                {selectedServer.environment}
              </span>
            </div>

            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.length === 0 && (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center max-w-md">
                    <div className="w-12 h-12 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mx-auto mb-4">
                      <Server size={20} className="text-blue-400" />
                    </div>
                    <p className="text-base font-medium text-zinc-300">{selectedServer.name}</p>
                    <p className="text-xs text-zinc-500 mt-1 mb-5">AI có full quyền quản lý server này. Hỏi bất kỳ điều gì hoặc chọn:</p>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {QUICK_ACTIONS.map(({ icon: Icon, label, prompt }) => (
                        <button key={label} onClick={() => sendMessage(prompt)}
                          className="flex flex-col items-center gap-1.5 p-3 rounded-lg bg-zinc-900/50 border border-zinc-800 hover:border-blue-500/40 hover:bg-blue-500/5 transition text-center group">
                          <Icon size={16} className="text-zinc-500 group-hover:text-blue-400 transition" />
                          <span className="text-[11px] text-zinc-400 group-hover:text-zinc-200 transition">{label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {messages.map(msg => (
                <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-blue-600 text-white'
                      : 'bg-zinc-900 text-zinc-200 border border-zinc-800'
                  }`}>
                    <div className="whitespace-pre-wrap break-words">{msg.content || ''}</div>
                  </div>
                </div>
              ))}
              {toolActivity && (
                <div className="flex items-center gap-2 text-xs">
                  <div className="flex gap-0.5">
                    <div className="w-1 h-1 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <div className="w-1 h-1 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <div className="w-1 h-1 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                  <span className="text-zinc-500">{toolActivity}</span>
                </div>
              )}
            </div>

            <div className="border-t border-zinc-800 p-3">
              <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 rounded-2xl px-4 py-2.5 focus-within:border-blue-500/50 transition">
                <input
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
                  placeholder={`Hỏi AI về ${selectedServer.name}...`}
                  className="flex-1 bg-transparent text-white text-sm outline-none placeholder-zinc-600"
                  disabled={isStreaming}
                />
                <button onClick={() => sendMessage()} disabled={isStreaming || !input.trim()}
                  className="text-blue-500 hover:text-blue-400 disabled:text-zinc-700 transition p-0.5">
                  <Send size={16} />
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="w-16 h-16 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mx-auto mb-4">
                <Server size={24} className="text-zinc-600" />
              </div>
              <p className="text-sm text-zinc-400 font-medium">Chọn máy chủ</p>
              <p className="text-xs text-zinc-600 mt-1">AI sẽ quản lý toàn bộ server cho bạn</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
