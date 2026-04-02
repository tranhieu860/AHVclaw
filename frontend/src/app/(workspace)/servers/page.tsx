'use client';

import { useEffect, useState } from 'react';
import { Server, Plus, Trash2, Terminal, Activity } from 'lucide-react';

interface ServerItem {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  environment: string;
  last_connected_at: string | null;
}

export default function ServersPage() {
  const [servers, setServers] = useState<ServerItem[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedServer, setSelectedServer] = useState<string | null>(null);
  const [command, setCommand] = useState('');
  const [output, setOutput] = useState('');
  const [loading, setLoading] = useState(false);

  // Form state
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

  const addServer = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/servers`, {
        method: 'POST',
        headers: headers(),
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

  const deleteServer = async (id: string) => {
    if (!confirm('Xóa máy chủ này?')) return;
    await fetch(`${baseUrl}/api/servers/${id}`, { method: 'DELETE', headers: headers() });
    loadServers();
  };

  const execCommand = async () => {
    if (!selectedServer || !command) return;
    setLoading(true);
    setOutput('Đang chạy...');
    try {
      const res = await fetch(`${baseUrl}/api/servers/${selectedServer}/exec`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ command }),
      });
      const data = await res.json();
      setOutput(data.output || data.error || 'Không có đầu ra');
    } catch {
      setOutput('Không thể thực thi lệnh');
    } finally {
      setLoading(false);
    }
  };

  const getStatus = async (id: string) => {
    setSelectedServer(id);
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/servers/${id}/status`, { headers: headers() });
      const data = await res.json();
      setOutput(data.status || data.error || 'No status');
    } catch {
      setOutput('Không thể lấy trạng thái');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col p-4 overflow-hidden">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-white flex items-center gap-2">
          <Server size={20} /> Máy chủ
        </h1>
        <button onClick={() => setShowAdd(!showAdd)} className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm flex items-center gap-1">
          <Plus size={14} /> Thêm máy chủ
        </button>
      </div>

      {showAdd && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-4 grid grid-cols-2 gap-3">
          <input placeholder="Tên" value={formName} onChange={e => setFormName(e.target.value)} className="bg-zinc-800 text-white rounded px-3 py-1.5 text-sm border border-zinc-700" />
          <input placeholder="Máy chủ (IP)" value={formHost} onChange={e => setFormHost(e.target.value)} className="bg-zinc-800 text-white rounded px-3 py-1.5 text-sm border border-zinc-700" />
          <input placeholder="Cổng" value={formPort} onChange={e => setFormPort(e.target.value)} className="bg-zinc-800 text-white rounded px-3 py-1.5 text-sm border border-zinc-700" />
          <input placeholder="Tên đăng nhập" value={formUser} onChange={e => setFormUser(e.target.value)} className="bg-zinc-800 text-white rounded px-3 py-1.5 text-sm border border-zinc-700" />
          <input placeholder="Mật khẩu" type="password" value={formPass} onChange={e => setFormPass(e.target.value)} className="bg-zinc-800 text-white rounded px-3 py-1.5 text-sm border border-zinc-700" />
          <select value={formEnv} onChange={e => setFormEnv(e.target.value)} className="bg-zinc-800 text-white rounded px-3 py-1.5 text-sm border border-zinc-700">
            <option value="dev">Phát triển</option>
            <option value="staging">Dàn dựng</option>
            <option value="production">Sản xuất</option>
          </select>
          <button onClick={addServer} className="bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded text-sm col-span-2">Lưu máy chủ</button>
        </div>
      )}

      <div className="flex flex-1 gap-4 overflow-hidden">
        {/* Server list */}
        <div className="w-72 overflow-y-auto space-y-2">
          {servers.map(s => (
            <div key={s.id} className={`bg-zinc-900 border rounded-lg p-3 cursor-pointer ${selectedServer === s.id ? 'border-blue-500' : 'border-zinc-800 hover:border-zinc-700'}`}
                 onClick={() => setSelectedServer(s.id)}>
              <div className="flex items-center justify-between">
                <span className="text-white font-medium text-sm">{s.name}</span>
                <div className="flex gap-1">
                  <button onClick={(e) => { e.stopPropagation(); getStatus(s.id); }} className="text-zinc-400 hover:text-green-400"><Activity size={14} /></button>
                  <button onClick={(e) => { e.stopPropagation(); deleteServer(s.id); }} className="text-zinc-400 hover:text-red-400"><Trash2 size={14} /></button>
                </div>
              </div>
              <p className="text-xs text-zinc-500 mt-1">{s.username}@{s.host}:{s.port}</p>
              <span className={`text-xs px-1.5 py-0.5 rounded mt-1 inline-block ${
                s.environment === 'production' ? 'bg-red-900/50 text-red-300' :
                s.environment === 'staging' ? 'bg-yellow-900/50 text-yellow-300' :
                'bg-green-900/50 text-green-300'
              }`}>{s.environment}</span>
            </div>
          ))}
          {servers.length === 0 && <p className="text-zinc-500 text-sm text-center py-8">Chưa có máy chủ nào</p>}
        </div>

        {/* Command / Output panel */}
        <div className="flex-1 flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          {selectedServer ? (
            <>
              <div className="flex items-center border-b border-zinc-800 p-2 gap-2">
                <span className="text-green-400 text-sm">$</span>
                <input
                  value={command}
                  onChange={e => setCommand(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && execCommand()}
                  placeholder="Nhập lệnh..."
                  className="flex-1 bg-transparent text-white text-sm outline-none"
                  disabled={loading}
                />
                <button onClick={execCommand} disabled={loading}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded text-xs disabled:opacity-50">
                  Run
                </button>
              </div>
              <pre className="flex-1 overflow-auto p-3 text-sm text-green-400 font-mono whitespace-pre-wrap">{output || 'Chọn máy chủ và chạy lệnh'}</pre>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
              Chọn máy chủ để quản lý
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
