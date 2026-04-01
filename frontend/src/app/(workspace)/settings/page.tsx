'use client';

import { useEffect, useState } from 'react';
import { Settings, User, Palette, HardDrive, Shield, Cpu, Plus, Trash2, Copy, Eye, EyeOff, Check } from 'lucide-react';
import { ModelSearch } from '@/components/ModelSearch';

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

const tabs = [
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'preferences', label: 'Preferences', icon: Palette },
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'providers', label: 'Model Providers', icon: Cpu },
] as const;

type TabId = typeof tabs[number]['id'];

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<TabId>('profile');
  const [settings, setSettings] = useState<Record<string, string | undefined>>({});
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [showApiKey, setShowApiKey] = useState(false);
  const [copied, setCopied] = useState(false);

  // Security form
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwMsg, setPwMsg] = useState('');

  // Provider form
  const [provName, setProvName] = useState('');
  const [provUrl, setProvUrl] = useState('');
  const [provKey, setProvKey] = useState('');

  // Preferences
  const [defaultModel, setDefaultModel] = useState('');
  const [theme, setTheme] = useState('dark');
  const [language, setLanguage] = useState('vi');

  const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3101';
  const headers = () => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${localStorage.getItem('access_token')}`,
  });

  const loadSettings = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/settings`, { headers: headers() });
      if (res.ok) {
        const data = await res.json();
        setSettings(data);
        setDefaultModel(data.default_model || '');
        setTheme(data.theme || 'dark');
        setLanguage(data.language || 'en');
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

  useEffect(() => {
    loadSettings();
    loadStorage();
    loadProviders();
  }, []);

  const savePreferences = async () => {
    try {
      await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ default_model: defaultModel, theme, language }),
      });
    } catch {}
  };

  const changePassword = async () => {
    if (newPw !== confirmPw) { setPwMsg('Passwords do not match'); return; }
    if (!oldPw || !newPw) { setPwMsg('All fields required'); return; }
    try {
      const res = await fetch(`${baseUrl}/api/settings/password`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ old_password: oldPw, new_password: newPw }),
      });
      if (res.ok) {
        setPwMsg('Password changed successfully');
        setOldPw(''); setNewPw(''); setConfirmPw('');
      } else {
        const data = await res.json().catch(() => ({}));
        setPwMsg(data.error || 'Failed to change password');
      }
    } catch { setPwMsg('Error changing password'); }
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
        <Settings size={20} /> Settings
      </h1>

      <div className="flex gap-1 mb-6 border-b border-zinc-800 pb-px">
        {tabs.map(tab => {
          const Icon = tab.icon;
          return (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
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
              <label className="text-xs text-zinc-500 block mb-1">Default Model</label>
              <input value={defaultModel} onChange={e => setDefaultModel(e.target.value)} placeholder="e.g. AHV-Holding-TroLy" className={inputCls} />
            </div>
            <div>
              <label className="text-xs text-zinc-500 block mb-1">Theme</label>
              <select value={theme} onChange={e => setTheme(e.target.value)} className={inputCls}>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
                <option value="system">System</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-zinc-500 block mb-1">Language</label>
              <select value={language} onChange={e => setLanguage(e.target.value)} className={inputCls}>
                <option value="en">English</option>
                <option value="vi">Vietnamese</option>
              </select>
            </div>
            <button onClick={savePreferences} className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded text-sm">Save Preferences</button>
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
                    {storage.quota > 0 ? `${((storage.used / storage.quota) * 100).toFixed(1)}% used` : 'No quota set'}
                  </p>
                </div>
              </>
            ) : (
              <p className="text-zinc-500 text-sm">Loading storage info...</p>
            )}
          </div>
        )}

        {activeTab === 'security' && (
          <div className="space-y-6">
            <div>
              <h3 className="text-white font-medium mb-3">Change Password</h3>
              <div className="space-y-3">
                <input type="password" value={oldPw} onChange={e => setOldPw(e.target.value)} placeholder="Current password" className={inputCls} />
                <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} placeholder="New password" className={inputCls} />
                <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} placeholder="Confirm new password" className={inputCls} />
                {pwMsg && <p className={`text-xs ${pwMsg.includes('success') ? 'text-green-400' : 'text-red-400'}`}>{pwMsg}</p>}
                <button onClick={changePassword} className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded text-sm">Change Password</button>
              </div>
            </div>
            <div className="border-t border-zinc-800 pt-4">
              <h3 className="text-white font-medium mb-3">API Key</h3>
              <p className="text-xs text-zinc-500 mb-3">Generate a new API key. This will invalidate the existing one.</p>
              <button onClick={generateApiKey} className="bg-yellow-600 hover:bg-yellow-700 text-white px-4 py-2 rounded text-sm">Generate New API Key</button>
            </div>
          </div>
        )}

        {activeTab === 'providers' && (
          <div className="space-y-4">
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
              <h3 className="text-white text-sm font-medium">Add Provider</h3>
              <input value={provName} onChange={e => setProvName(e.target.value)} placeholder="Provider Name" className={inputCls} />
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
                <p className="text-zinc-500 text-sm text-center py-4">No custom providers configured.</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
