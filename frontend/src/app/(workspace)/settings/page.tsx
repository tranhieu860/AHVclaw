'use client';

import { useEffect, useState } from 'react';
import { Settings, User, Palette, HardDrive, Shield, Cpu, Plus, Trash2, Copy, Eye, EyeOff, Check, Zap } from 'lucide-react';
import { ModelSearch } from '@/components/ModelSearch';
import { useStore } from '@/lib/store';

interface Provider {
  id: string;
  name: string;
  api_url: string;
  api_key?: string;
}

interface StorageInfo {
  used: number;
  quota: number;
}

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

const baseTabsConfig = [
  { id: 'profile', label: 'Hồ sơ', icon: User },
  { id: 'preferences', label: 'Tùy chọn', icon: Palette },
  { id: 'storage', label: 'Lưu trữ', icon: HardDrive },
  { id: 'security', label: 'Bảo mật', icon: Shield },
  { id: 'providers', label: 'Nhà cung cấp model', icon: Cpu },
  { id: 'autonomous', label: 'Tự động', icon: Zap },
] as const;

type BaseTabId = typeof baseTabsConfig[number]['id'];

export default function SettingsPage() {
  const { user } = useStore();
  const [activeTab, setActiveTab] = useState<BaseTabId | 'admin'>('profile');
  const [settings, setSettings] = useState<Record<string, string | undefined>>({});
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [showApiKey, setShowApiKey] = useState(false);
  const [copied, setCopied] = useState(false);

  // Admin state
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);

  // Security form
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwMsg, setPwMsg] = useState('');

  // Provider form
  const [provName, setProvName] = useState('');
  const [provUrl, setProvUrl] = useState('');
  const [provKey, setProvKey] = useState('');
  // Autonomous config state
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoInterval, setAutoInterval] = useState(30);
  const [autoQuietStart, setAutoQuietStart] = useState('23:00');
  const [autoQuietEnd, setAutoQuietEnd] = useState('07:00');
  const [autoMaxActions, setAutoMaxActions] = useState(5);
  const [autoReflectionTime, setAutoReflectionTime] = useState('22:00');
  const [autoDigestTime, setAutoDigestTime] = useState('08:00');
  const [trustPermissions, setTrustPermissions] = useState<Array<{id: string; name: string; trust_score: number}>>([]);
  const [autoSaving, setAutoSaving] = useState(false);
  const [autoSaveMsg, setAutoSaveMsg] = useState('');

  // Preferences
  const [defaultModel, setDefaultModel] = useState('');
  const [theme, setTheme] = useState('dark');
  const [language, setLanguage] = useState('vi');
  const [saveSuccess, setSaveSuccess] = useState(false);

  const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3101';
  const headers = () => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${localStorage.getItem('access_token')}`,
  });

  // Build tabs array dynamically
  const tabs = [
    ...baseTabsConfig,
    ...(user?.role === 'admin' ? [{ id: 'admin' as const, label: 'Quản trị', icon: Shield }] : []),
  ];

  const loadSettings = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/settings`, { headers: headers() });
      if (res.ok) {
        const data = await res.json();
        setSettings(data);
        const s = (typeof data.settings === 'object' && data.settings) ? data.settings : {};
        setDefaultModel(s.default_model || '');
        setTheme(s.theme || 'dark');
        setLanguage(s.language || 'vi');
      }
    } catch {}
  };

  const loadStorage = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/settings/storage`, { headers: headers() });
      if (res.ok) setStorage(await res.json());
    } catch {}
  };

  const loadProviders = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/providers`, { headers: headers() });
      if (res.ok) setProviders(await res.json());
    } catch {}
  };

  const loadAdminUsers = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/admin/users`, { headers: headers() });
      if (res.ok) setAdminUsers(await res.json());
    } catch {}
  };

  useEffect(() => {
    loadSettings();
    loadStorage();
    loadProviders();
  }, []);

  const loadAutonomous = async () => {
    try {
      const baseUrl2 = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3101';
      const h = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('access_token')}` };
      const res = await fetch(`${baseUrl2}/api/autonomous/status`, { headers: h });
      if (res.ok) {
        const d = await res.json();
        setAutoEnabled(d.enabled ?? false);
        if (d.config) {
          setAutoInterval(d.config.interval_minutes ?? 30);
          setAutoQuietStart(d.config.quiet_hours_start ?? '23:00');
          setAutoQuietEnd(d.config.quiet_hours_end ?? '07:00');
          setAutoMaxActions(d.config.max_actions_per_hour ?? 5);
          setAutoReflectionTime(d.config.reflection_time ?? '22:00');
          setAutoDigestTime(d.config.digest_time ?? '08:00');
        }
      }
      const tr = await fetch(`${baseUrl2}/api/trust`, { headers: h });
      if (tr.ok) {
        const td = await tr.json();
        setTrustPermissions(Array.isArray(td) ? td : td?.permissions ?? []);
      }
    } catch {}
  };

  useEffect(() => {
    if (activeTab === 'admin') {
      loadAdminUsers();
    }
    if (activeTab === 'autonomous') {
      loadAutonomous();
    }
  }, [activeTab]);

  const savePreferences = async () => {
    try {
      await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ settings: JSON.stringify({ default_model: defaultModel, theme, language }) }),
      });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch {}
  };

  const changePassword = async () => {
    if (newPw !== confirmPw) { setPwMsg('Mật khẩu không khớp'); return; }
    if (!oldPw || !newPw) { setPwMsg('Tất cả trường là bắt buộc'); return; }
    try {
      const res = await fetch(`${baseUrl}/api/settings/password`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ old_password: oldPw, new_password: newPw }),
      });
      if (res.ok) {
        setPwMsg('Đổi mật khẩu thành công');
        setOldPw(''); setNewPw(''); setConfirmPw('');
      } else {
        const data = await res.json().catch(() => ({}));
        setPwMsg(data.error || 'Đổi mật khẩu thất bại');
      }
    } catch { setPwMsg('Lỗi khi đổi mật khẩu'); }
  };

  const generateApiKey = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/settings/api-key`, { method: 'POST', headers: headers() });
      if (res.ok) loadSettings();
    } catch {}
  };

  const addProvider = async () => {
    if (!provName || !provUrl) return;
    try {
      await fetch(`${baseUrl}/api/providers`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ name: provName, api_url: provUrl, api_key: provKey || undefined }),
      });
      setProvName(''); setProvUrl(''); setProvKey('');
      loadProviders();
    } catch {}
  };

  const deleteProvider = async (id: string) => {
    try {
      await fetch(`${baseUrl}/api/providers/${id}`, { method: 'DELETE', headers: headers() });
      loadProviders();
    } catch {}
  };

  const updateUserRole = async (id: string, role: string) => {
    try {
      await fetch(`${baseUrl}/api/admin/users/${id}/role`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ role }),
      });
      loadAdminUsers();
    } catch {}
  };

  const deleteUser = async (id: string) => {
    if (!confirm('Xóa user này?')) return;
    try {
      await fetch(`${baseUrl}/api/admin/users/${id}`, { method: 'DELETE', headers: headers() });
      loadAdminUsers();
    } catch {}
  };

  const copyApiKey = () => {
    if (settings.api_key) {
      navigator.clipboard.writeText(settings.api_key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const formatBytes = (b: number) => {
    if (b < 1024) return `${b} B`;
    if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
    return `${(b / 1073741824).toFixed(1)} GB`;
  };

  const inputCls = "w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none";

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <h1 className="text-xl font-semibold text-white flex items-center gap-2 mb-6">
        <Settings size={20} /> Cài đặt
      </h1>

      <div className="flex gap-1 mb-6 border-b border-zinc-800 pb-px">
        {tabs.map(tab => {
          const Icon = tab.icon;
          return (
            <button key={tab.id} onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm rounded-t transition ${
                activeTab === tab.id ? 'text-white border-b-2 border-blue-500' : 'text-zinc-500 hover:text-zinc-300'
              }`}>
              <Icon size={14} /> {tab.label}
            </button>
          );
        })}
      </div>

      <div className="max-w-2xl">
        {activeTab === 'profile' && (
          <div className="space-y-4">
            <div>
              <label className="text-xs text-zinc-500 block mb-1">Name</label>
              <input value={settings.name || ''} readOnly className={`${inputCls} opacity-70`} />
            </div>
            <div>
              <label className="text-xs text-zinc-500 block mb-1">Email</label>
              <input value={settings.email || ''} readOnly className={`${inputCls} opacity-70`} />
            </div>
            <div>
              <label className="text-xs text-zinc-500 block mb-1">Role</label>
              <span className="inline-block text-xs px-2 py-1 rounded bg-blue-900/30 text-blue-400">{settings.role || 'user'}</span>
            </div>
            <div>
              <label className="text-xs text-zinc-500 block mb-1">API Key</label>
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <input value={showApiKey ? (settings.api_key || 'Not set') : '••••••••••••'} readOnly className={inputCls} />
                  <button onClick={() => setShowApiKey(!showApiKey)} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white">
                    {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                <button onClick={copyApiKey} className="p-2 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400">
                  {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'preferences' && (
          <div className="space-y-4">
            <div>
              <label className="text-xs text-zinc-500 block mb-1">Model mặc định</label>
              <input value={defaultModel} onChange={e => setDefaultModel(e.target.value)} placeholder="e.g. AHV-Holding-TroLy" className={inputCls} />
            </div>
            <div>
              <label className="text-xs text-zinc-500 block mb-1">Giao diện</label>
              <select value={theme} onChange={e => setTheme(e.target.value)} className={inputCls}>
                <option value="dark">Tối</option>
                <option value="light">Sáng</option>
                <option value="system">Hệ thống</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-zinc-500 block mb-1">Ngôn ngữ</label>
              <select value={language} onChange={e => setLanguage(e.target.value)} className={inputCls}>
                <option value="en">English</option>
                <option value="vi">Vietnamese</option>
              </select>
            </div>
            {saveSuccess && <p className="text-green-400 text-xs mb-2">Đã lưu!</p>}
            <button onClick={savePreferences} className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded text-sm">Lưu tùy chọn</button>
          </div>
        )}

        {activeTab === 'storage' && (
          <div className="space-y-4">
            {storage ? (
              <>
                <div>
                  <div className="flex justify-between text-sm mb-2">
                    <span className="text-zinc-400">Used: {formatBytes(storage.used)}</span>
                    <span className="text-zinc-400">Quota: {formatBytes(storage.quota)}</span>
                  </div>
                  <div className="w-full bg-zinc-800 rounded-full h-3">
                    <div className="bg-blue-600 h-3 rounded-full transition-all" style={{ width: `${Math.min((storage.used / storage.quota) * 100, 100)}%` }} />
                  </div>
                  <p className="text-xs text-zinc-500 mt-2">
                    {storage.quota > 0 ? `${((storage.used / storage.quota) * 100).toFixed(1)}% used` : 'Chưa đặt hạn mức'}
                  </p>
                </div>
              </>
            ) : (
              <p className="text-zinc-500 text-sm">Đang tải thông tin lưu trữ...</p>
            )}
          </div>
        )}

        {activeTab === 'security' && (
          <div className="space-y-6">
            <div>
              <h3 className="text-white font-medium mb-3">Đổi mật khẩu</h3>
              <div className="space-y-3">
                <input type="password" value={oldPw} onChange={e => setOldPw(e.target.value)} placeholder="Mật khẩu hiện tại" className={inputCls} />
                <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} placeholder="Mật khẩu mới" className={inputCls} />
                <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} placeholder="Xác nhận mật khẩu mới" className={inputCls} />
                {pwMsg && <p className={`text-xs ${pwMsg.includes('success') ? 'text-green-400' : 'text-red-400'}`}>{pwMsg}</p>}
                <button onClick={changePassword} className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded text-sm">Đổi mật khẩu</button>
              </div>
            </div>
            <div className="border-t border-zinc-800 pt-4">
              <h3 className="text-white font-medium mb-3">API Key</h3>
              <p className="text-xs text-zinc-500 mb-3">Tạo API key mới. Key cũ sẽ bị vô hiệu.</p>
              <button onClick={generateApiKey} className="bg-yellow-600 hover:bg-yellow-700 text-white px-4 py-2 rounded text-sm">Tạo API Key mới</button>
            </div>
          </div>
        )}

        {activeTab === 'providers' && (
          <div className="space-y-4">
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
              <h3 className="text-white text-sm font-medium">Thêm nhà cung cấp</h3>
              <input value={provName} onChange={e => setProvName(e.target.value)} placeholder="Tên nhà cung cấp" className={inputCls} />
              <input value={provUrl} onChange={e => setProvUrl(e.target.value)} placeholder="API URL (e.g. https://api.example.com/v1)" className={inputCls} />
              <input value={provKey} onChange={e => setProvKey(e.target.value)} placeholder="API Key (optional)" className={inputCls} />
              <button onClick={addProvider} className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded text-sm flex items-center gap-1">
                <Plus size={14} /> Add Provider
              </button>
            </div>

            <div className="space-y-2">
              {providers.map(p => (
                <div key={p.id} className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 flex items-center justify-between">
                  <div>
                    <h4 className="text-white text-sm font-medium">{p.name}</h4>
                    <p className="text-xs text-zinc-500">{p.api_url}</p>
                  </div>
                  <button onClick={() => deleteProvider(p.id)} className="p-1.5 rounded hover:bg-zinc-800 text-red-400">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              {providers.length === 0 && (
                <p className="text-zinc-500 text-sm text-center py-4">Chưa cấu hình nhà cung cấp nào.</p>
              )}
            </div>
          </div>
        )}

        {activeTab === 'autonomous' && (
          <div className="space-y-6">
            <div>
              <h3 className="text-white font-medium mb-4">Heartbeat Engine</h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-zinc-300">Enable Heartbeat</p>
                    <p className="text-xs text-zinc-500">Run autonomous cycles on a schedule</p>
                  </div>
                  <button
                    onClick={async () => {
                      try {
                        const baseUrl2 = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3101';
                        const h = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('access_token')}` };
                        await fetch(`${baseUrl2}/api/autonomous/${autoEnabled ? 'stop' : 'resume'}`, { method: 'POST', headers: h });
                        setAutoEnabled(!autoEnabled);
                      } catch {}
                    }}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${autoEnabled ? 'bg-green-600' : 'bg-zinc-700'}`}
                  >
                    <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition ${autoEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </div>

                <div>
                  <label className="text-xs text-zinc-500 block mb-1">Interval (minutes)</label>
                  <input type="number" min={1} max={1440} value={autoInterval} onChange={e => setAutoInterval(Number(e.target.value))} className={inputCls} />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-zinc-500 block mb-1">Quiet hours start</label>
                    <input type="time" value={autoQuietStart} onChange={e => setAutoQuietStart(e.target.value)} className={inputCls} />
                  </div>
                  <div>
                    <label className="text-xs text-zinc-500 block mb-1">Quiet hours end</label>
                    <input type="time" value={autoQuietEnd} onChange={e => setAutoQuietEnd(e.target.value)} className={inputCls} />
                  </div>
                </div>

                <div>
                  <label className="text-xs text-zinc-500 block mb-1">Max actions per hour</label>
                  <input type="number" min={1} max={100} value={autoMaxActions} onChange={e => setAutoMaxActions(Number(e.target.value))} className={inputCls} />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-zinc-500 block mb-1">Reflection time</label>
                    <input type="time" value={autoReflectionTime} onChange={e => setAutoReflectionTime(e.target.value)} className={inputCls} />
                  </div>
                  <div>
                    <label className="text-xs text-zinc-500 block mb-1">Digest time</label>
                    <input type="time" value={autoDigestTime} onChange={e => setAutoDigestTime(e.target.value)} className={inputCls} />
                  </div>
                </div>

                {autoSaveMsg && <p className={`text-xs ${autoSaveMsg.includes('saved') ? 'text-green-400' : 'text-red-400'}`}>{autoSaveMsg}</p>}
                <button
                  disabled={autoSaving}
                  onClick={async () => {
                    setAutoSaving(true);
                    setAutoSaveMsg('');
                    try {
                      const baseUrl2 = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3101';
                      const h = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('access_token')}` };
                      await fetch(`${baseUrl2}/api/autonomous/config`, {
                        method: 'PUT',
                        headers: h,
                        body: JSON.stringify({
                          interval_minutes: autoInterval,
                          quiet_hours_start: autoQuietStart,
                          quiet_hours_end: autoQuietEnd,
                          max_actions_per_hour: autoMaxActions,
                          reflection_time: autoReflectionTime,
                          digest_time: autoDigestTime,
                        }),
                      });
                      setAutoSaveMsg('Config saved!');
                      setTimeout(() => setAutoSaveMsg(''), 2000);
                    } catch { setAutoSaveMsg('Save failed'); }
                    finally { setAutoSaving(false); }
                  }}
                  className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded text-sm"
                >
                  {autoSaving ? 'Saving...' : 'Save config'}
                </button>
              </div>
            </div>

            {trustPermissions.length > 0 && (
              <div className="border-t border-zinc-800 pt-4">
                <h3 className="text-white font-medium mb-3">Trust Permissions</h3>
                <div className="space-y-3">
                  {trustPermissions.map(tp => (
                    <div key={tp.id} className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-sm text-zinc-300">{tp.name}</span>
                        <span className="text-xs text-zinc-500">{tp.trust_score}/10</span>
                      </div>
                      <input
                        type="range" min={0} max={10} step={1}
                        value={tp.trust_score}
                        onChange={async e => {
                          const score = Number(e.target.value);
                          setTrustPermissions(prev => prev.map(t => t.id === tp.id ? { ...t, trust_score: score } : t));
                          try {
                            const baseUrl2 = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3101';
                            const h = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('access_token')}` };
                            await fetch(`${baseUrl2}/api/trust/${tp.id}`, { method: 'PUT', headers: h, body: JSON.stringify({ trust_score: score }) });
                          } catch {}
                        }}
                        className="w-full accent-blue-500"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'admin' && (
          <div className="space-y-4">
            <h3 className="text-white font-medium">Quản lý người dùng</h3>
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-500 text-xs">
                    <th className="text-left px-4 py-3">Name</th>
                    <th className="text-left px-4 py-3">Email</th>
                    <th className="text-left px-4 py-3">Role</th>
                    <th className="text-left px-4 py-3 w-24">Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {adminUsers.map(u => (
                    <tr key={u.id} className="border-b border-zinc-800/50">
                      <td className="px-4 py-3 text-white">{u.name}</td>
                      <td className="px-4 py-3 text-zinc-400">{u.email}</td>
                      <td className="px-4 py-3">
                        <select value={u.role} onChange={e => updateUserRole(u.id, e.target.value)}
                          className="bg-zinc-800 text-white text-xs rounded px-2 py-1 border border-zinc-700">
                          <option value="user">User</option>
                          <option value="dev">Dev</option>
                          <option value="admin">Admin</option>
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <button onClick={() => deleteUser(u.id)} disabled={u.id === user?.id}
                          className="text-red-400 hover:text-red-300 disabled:opacity-30 text-xs">Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

