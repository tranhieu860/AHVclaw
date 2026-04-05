'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Shield, RefreshCw, Users, MessageSquare, Brain, Target,
  Activity, Wrench, Cpu, Database, Settings, Zap, Clock,
  Plus, Pencil, Trash2, X, Check
} from 'lucide-react';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';

type Tab = 'overview' | 'users' | 'system' | 'heartbeat' | 'activity' | 'database' | 'settings' | 'security';

const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
  { key: 'overview', label: 'Tổng quan', icon: <Activity size={14} /> },
  { key: 'users', label: 'Người dùng', icon: <Users size={14} /> },
  { key: 'system', label: 'Hệ thống', icon: <Cpu size={14} /> },
  { key: 'heartbeat', label: 'AGI Engine', icon: <Zap size={14} /> },
  { key: 'activity', label: 'Hoạt động', icon: <Clock size={14} /> },
  { key: 'database', label: 'Database', icon: <Database size={14} /> },
  { key: 'security', label: 'Bảo mật', icon: <Shield size={14} /> },
  { key: 'settings', label: 'Cài đặt', icon: <Settings size={14} /> },
];

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatTime(ts: string): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('vi-VN');
  } catch {
    return ts;
  }
}

function RoleBadge({ role }: { role: string }) {
  const cls =
    role === 'admin' ? 'bg-red-900/30 text-red-400' :
    role === 'dev' ? 'bg-blue-900/30 text-blue-400' :
    'bg-zinc-800 text-zinc-400';
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{role}</span>;
}

function StatusBadge({ ok }: { ok: boolean }) {
  return ok
    ? <span className="px-2 py-0.5 rounded text-xs bg-green-900/30 text-green-400">OK</span>
    : <span className="px-2 py-0.5 rounded text-xs bg-red-900/30 text-red-400">Lỗi</span>;
}

export default function AdminPage() {
  const router = useRouter();
  const { user } = useStore();
  const [tab, setTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Data
  const [dashboard, setDashboard] = useState<any>(null);
  const [system, setSystem] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [heartbeat, setHeartbeat] = useState<any[]>([]);
  const [activity, setActivity] = useState<any[]>([]);
  const [dbStats, setDbStats] = useState<any[]>([]);
  const [settings, setSettings] = useState<any[]>([]);
  const [security, setSecurity] = useState<any>(null);

  // Modals
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [createForm, setCreateForm] = useState({ email: '', name: '', password: '', role: 'user' });
  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ name: string; role: string }>({ name: '', role: '' });

  // Guard
  useEffect(() => {
    if (user && user.role !== 'admin') {
      router.push('/dashboard');
    }
  }, [user, router]);

  const loadData = async (t?: Tab) => {
    const target = t || tab;
    try {
      switch (target) {
        case 'overview': {
          const [d, s] = await Promise.all([api.getAdminDashboard(), api.getAdminSystem()]);
          setDashboard(d);
          setSystem(s);
          break;
        }
        case 'users': {
          const u = await api.getAdminUsersDetailed();
          setUsers(Array.isArray(u) ? u : u.users || []);
          break;
        }
        case 'system': {
          const s = await api.getAdminSystem();
          setSystem(s);
          break;
        }
        case 'heartbeat': {
          const h = await api.getAdminHeartbeat();
          setHeartbeat(Array.isArray(h) ? h : h.users || []);
          break;
        }
        case 'activity': {
          const a = await api.getAdminActivity(100);
          setActivity(Array.isArray(a) ? a : a.entries || []);
          break;
        }
        case 'database': {
          const d = await api.getAdminDBStats();
          setDbStats(Array.isArray(d) ? d : d.tables || []);
          break;
        }
        case 'security': {
          const sec = await api.getAdminSecurity();
          setSecurity(sec);
          break;
        }
        case 'settings': {
          const s = await api.getAdminSettings();
          setSettings(Array.isArray(s) ? s : s.settings || []);
          break;
        }
      }
    } catch (err) {
      console.error('Admin load error:', err);
    }
  };

  useEffect(() => {
    if (!user || user.role !== 'admin') return;
    setLoading(true);
    loadData().finally(() => setLoading(false));
  }, [tab, user]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  const handleTabChange = (t: Tab) => {
    setTab(t);
  };

  // User CRUD
  const handleCreateUser = async () => {
    try {
      await api.adminCreateUser(createForm);
      setShowCreateUser(false);
      setCreateForm({ email: '', name: '', password: '', role: 'user' });
      loadData('users');
    } catch (err: any) {
      alert('Lỗi: ' + (err.message || 'Không thể tạo user'));
    }
  };

  const handleUpdateUser = async (id: string) => {
    try {
      await api.adminUpdateUser(id, editForm);
      setEditingUser(null);
      loadData('users');
    } catch (err: any) {
      alert('Lỗi: ' + (err.message || 'Không thể cập nhật'));
    }
  };

  const handleDeleteUser = async (id: string, email: string) => {
    if (!confirm(`Xác nhận xóa user ${email}?`)) return;
    try {
      await api.deleteUser(id);
      loadData('users');
    } catch (err: any) {
      alert('Lỗi: ' + (err.message || 'Không thể xóa'));
    }
  };

  const handleUpdateSetting = async (key: string, value: string) => {
    try {
      await api.updateAdminSetting(key, value);
      loadData('settings');
    } catch (err: any) {
      alert('Lỗi: ' + (err.message || 'Không thể cập nhật'));
    }
  };

  if (!user || user.role !== 'admin') {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500">
        Không có quyền truy cập
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
        <div className="flex items-center gap-3">
          <Shield size={20} className="text-red-400" />
          <h1 className="text-lg font-bold">Admin Control Panel</h1>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition disabled:opacity-50"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          Làm mới
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-6 py-2 border-b border-zinc-800 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => handleTabChange(t.key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition ${
              tab === t.key
                ? 'bg-blue-600 text-white'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center h-64 text-zinc-500">
            Đang tải...
          </div>
        ) : (
          <>
            {tab === 'overview' && <OverviewTab dashboard={dashboard} system={system} />}
            {tab === 'users' && (
              <UsersTab
                users={users}
                showCreateUser={showCreateUser}
                setShowCreateUser={setShowCreateUser}
                createForm={createForm}
                setCreateForm={setCreateForm}
                handleCreateUser={handleCreateUser}
                editingUser={editingUser}
                setEditingUser={setEditingUser}
                editForm={editForm}
                setEditForm={setEditForm}
                handleUpdateUser={handleUpdateUser}
                handleDeleteUser={handleDeleteUser}
              />
            )}
            {tab === 'system' && <SystemTab system={system} />}
            {tab === 'heartbeat' && <HeartbeatTab heartbeat={heartbeat} />}
            {tab === 'activity' && <ActivityTab activity={activity} />}
            {tab === 'database' && <DatabaseTab dbStats={dbStats} />}
            {tab === 'security' && <SecurityTab security={security} />}
            {tab === 'settings' && <SettingsTab settings={settings} onUpdate={handleUpdateSetting} />}
          </>
        )}
      </div>

      {/* Create User Modal */}
      {showCreateUser && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowCreateUser(false)}>
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold">Tạo user mới</h2>
              <button onClick={() => setShowCreateUser(false)} className="text-zinc-500 hover:text-zinc-300">
                <X size={18} />
              </button>
            </div>
            <div className="space-y-3">
              <input
                type="email"
                placeholder="Email"
                value={createForm.email}
                onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
                className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 outline-none w-full"
              />
              <input
                type="text"
                placeholder="Tên"
                value={createForm.name}
                onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 outline-none w-full"
              />
              <input
                type="password"
                placeholder="Mật khẩu"
                value={createForm.password}
                onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 outline-none w-full"
              />
              <select
                value={createForm.role}
                onChange={(e) => setCreateForm({ ...createForm, role: e.target.value })}
                className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 outline-none w-full"
              >
                <option value="user">User</option>
                <option value="dev">Dev</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowCreateUser(false)}
                className="px-4 py-2 rounded text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition"
              >
                Hủy
              </button>
              <button
                onClick={handleCreateUser}
                className="px-4 py-2 rounded text-sm bg-blue-600 hover:bg-blue-500 text-white transition"
              >
                Tạo
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ========== TAB COMPONENTS ========== */

function OverviewTab({ dashboard, system }: { dashboard: any; system: any }) {
  if (!dashboard) return <div className="text-zinc-500">Không có dữ liệu</div>;

  const stats = [
    { icon: <Users size={18} />, label: 'Users', value: dashboard.total_users ?? 0 },
    { icon: <MessageSquare size={18} />, label: 'Hội thoại', value: dashboard.total_conversations ?? 0 },
    { icon: <MessageSquare size={18} />, label: 'Tin nhắn', value: dashboard.total_messages ?? 0 },
    { icon: <Brain size={18} />, label: 'Memory', value: dashboard.total_memory ?? 0 },
    { icon: <Target size={18} />, label: 'Mục tiêu', value: dashboard.total_goals ?? 0 },
    { icon: <Zap size={18} />, label: 'Heartbeat Runs', value: dashboard.total_heartbeat_runs ?? 0 },
    { icon: <Wrench size={18} />, label: 'Tool Calls', value: dashboard.total_tool_calls ?? 0 },
    { icon: <Cpu size={18} />, label: 'AI Connections', value: dashboard.total_connections ?? 0 },
  ];

  const sysItems = system ? [
    { label: 'Disk', value: system.disk_usage || '—' },
    { label: 'RAM', value: system.memory_usage || '—' },
    { label: 'DB Size', value: system.db_size || '—' },
    { label: 'Goroutines', value: system.goroutines ?? '—' },
    { label: 'Go Version', value: system.go_version || '—' },
    { label: 'Uptime', value: system.uptime || '—' },
    { label: 'DB Pool', value: system.db_pool || '—' },
  ] : [];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {stats.map((s, i) => (
          <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <div className="flex items-center gap-2 text-zinc-500 mb-2">
              {s.icon}
              <span className="text-xs">{s.label}</span>
            </div>
            <div className="text-2xl font-bold">{typeof s.value === 'number' ? s.value.toLocaleString() : s.value}</div>
          </div>
        ))}
      </div>

      {system && (
        <div>
          <h3 className="text-sm font-medium text-zinc-400 mb-3">Hệ thống</h3>
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {sysItems.map((item, i) => (
                <div key={i}>
                  <div className="text-xs text-zinc-500 mb-1">{item.label}</div>
                  <div className="text-sm font-mono text-zinc-200">{item.value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function UsersTab({
  users, showCreateUser, setShowCreateUser, createForm, setCreateForm, handleCreateUser,
  editingUser, setEditingUser, editForm, setEditForm, handleUpdateUser, handleDeleteUser,
}: any) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-400">Danh sách người dùng ({users.length})</h3>
        <button
          onClick={() => setShowCreateUser(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-blue-600 hover:bg-blue-500 text-white transition"
        >
          <Plus size={14} />
          Tạo user
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-zinc-500 border-b border-zinc-800">
              <th className="pb-2 pr-4">Tên</th>
              <th className="pb-2 pr-4">Email</th>
              <th className="pb-2 pr-4">Vai trò</th>
              <th className="pb-2 pr-4">Tin nhắn</th>
              <th className="pb-2 pr-4">Memory</th>
              <th className="pb-2 pr-4">Goals</th>
              <th className="pb-2 pr-4">Dung lượng</th>
              <th className="pb-2 pr-4">AGI</th>
              <th className="pb-2">Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u: any) => (
              <tr key={u.id} className="border-b border-zinc-800/50 hover:bg-zinc-900/50">
                <td className="py-2 pr-4">
                  {editingUser === u.id ? (
                    <input
                      value={editForm.name}
                      onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                      className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-100 focus:border-blue-500 outline-none w-32"
                    />
                  ) : (
                    <span className="text-zinc-200">{u.name || '—'}</span>
                  )}
                </td>
                <td className="py-2 pr-4 text-zinc-400 font-mono text-xs">{u.email}</td>
                <td className="py-2 pr-4">
                  {editingUser === u.id ? (
                    <select
                      value={editForm.role}
                      onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}
                      className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-100 focus:border-blue-500 outline-none"
                    >
                      <option value="user">user</option>
                      <option value="dev">dev</option>
                      <option value="admin">admin</option>
                    </select>
                  ) : (
                    <RoleBadge role={u.role} />
                  )}
                </td>
                <td className="py-2 pr-4 text-zinc-400">{u.message_count ?? 0}</td>
                <td className="py-2 pr-4 text-zinc-400">{u.memory_count ?? 0}</td>
                <td className="py-2 pr-4 text-zinc-400">{u.goal_count ?? 0}</td>
                <td className="py-2 pr-4 text-zinc-400 font-mono text-xs">{formatBytes(u.storage_bytes ?? 0)}</td>
                <td className="py-2 pr-4">
                  {u.agi_enabled ? (
                    <span className="px-2 py-0.5 rounded text-xs bg-green-900/30 text-green-400">Bật</span>
                  ) : (
                    <span className="px-2 py-0.5 rounded text-xs bg-zinc-800 text-zinc-500">Tắt</span>
                  )}
                </td>
                <td className="py-2">
                  {editingUser === u.id ? (
                    <div className="flex gap-1">
                      <button
                        onClick={() => handleUpdateUser(u.id)}
                        className="p-1 rounded hover:bg-green-600/20 text-green-400 transition"
                      >
                        <Check size={14} />
                      </button>
                      <button
                        onClick={() => setEditingUser(null)}
                        className="p-1 rounded hover:bg-zinc-700 text-zinc-400 transition"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-1">
                      <button
                        onClick={() => { setEditingUser(u.id); setEditForm({ name: u.name || '', role: u.role }); }}
                        className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => handleDeleteUser(u.id, u.email)}
                        className="p-1 rounded hover:bg-red-600/20 text-zinc-400 hover:text-red-400 transition"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SystemTab({ system }: { system: any }) {
  if (!system) return <div className="text-zinc-500">Không có dữ liệu</div>;

  const entries = Object.entries(system).filter(([k]) => !k.startsWith('_'));

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg divide-y divide-zinc-800">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-center px-4 py-3">
          <span className="text-sm text-zinc-500 w-48 shrink-0">{key}</span>
          <span className="text-sm text-zinc-200 font-mono break-all">
            {typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—')}
          </span>
        </div>
      ))}
    </div>
  );
}

function HeartbeatTab({ heartbeat }: { heartbeat: any[] }) {
  if (!heartbeat.length) return <div className="text-zinc-500">Không có dữ liệu AGI Engine</div>;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {heartbeat.map((h: any, i: number) => (
        <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="font-medium text-zinc-200">{h.user_name || h.user_email || 'User'}</span>
            <div className="flex gap-1.5">
              {h.enabled ? (
                <span className="px-2 py-0.5 rounded text-xs bg-green-900/30 text-green-400">Bật</span>
              ) : (
                <span className="px-2 py-0.5 rounded text-xs bg-zinc-800 text-zinc-500">Tắt</span>
              )}
              {h.paused && (
                <span className="px-2 py-0.5 rounded text-xs bg-yellow-900/30 text-yellow-400">Tạm dừng</span>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="text-zinc-500">Interval: </span>
              <span className="text-zinc-300 font-mono">{h.interval || '—'}</span>
            </div>
            <div>
              <span className="text-zinc-500">Tổng chạy: </span>
              <span className="text-zinc-300">{h.total_runs ?? 0}</span>
            </div>
            <div>
              <span className="text-zinc-500">Actions: </span>
              <span className="text-zinc-300">{h.total_actions ?? 0}</span>
            </div>
            <div>
              <span className="text-zinc-500">Goals: </span>
              <span className="text-zinc-300">{h.active_goals ?? 0}</span>
            </div>
          </div>
          {h.last_run && (
            <div className="text-xs text-zinc-500">
              Lần chạy cuối: {formatTime(h.last_run)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ActivityTab({ activity }: { activity: any[] }) {
  if (!activity.length) return <div className="text-zinc-500">Chưa có hoạt động</div>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-zinc-500 border-b border-zinc-800">
            <th className="pb-2 pr-4">Thời gian</th>
            <th className="pb-2 pr-4">User</th>
            <th className="pb-2 pr-4">Tool</th>
            <th className="pb-2 pr-4">Status</th>
            <th className="pb-2 pr-4">Duration</th>
            <th className="pb-2">Source</th>
          </tr>
        </thead>
        <tbody>
          {activity.map((a: any, i: number) => (
            <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-900/50">
              <td className="py-2 pr-4 text-zinc-400 text-xs font-mono whitespace-nowrap">{formatTime(a.created_at || a.timestamp)}</td>
              <td className="py-2 pr-4 text-zinc-300">{a.user_name || a.user_email || '—'}</td>
              <td className="py-2 pr-4 text-zinc-200 font-mono text-xs">{a.tool || a.action || '—'}</td>
              <td className="py-2 pr-4">
                {a.status === 'success' || a.success ? (
                  <span className="px-2 py-0.5 rounded text-xs bg-green-900/30 text-green-400">OK</span>
                ) : a.status === 'error' || a.error ? (
                  <span className="px-2 py-0.5 rounded text-xs bg-red-900/30 text-red-400">Lỗi</span>
                ) : (
                  <span className="px-2 py-0.5 rounded text-xs bg-zinc-800 text-zinc-400">{a.status || '—'}</span>
                )}
              </td>
              <td className="py-2 pr-4 text-zinc-400 font-mono text-xs">{a.duration_ms ? `${a.duration_ms}ms` : '—'}</td>
              <td className="py-2 text-zinc-500 text-xs">{a.source || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DatabaseTab({ dbStats }: { dbStats: any[] }) {
  if (!dbStats.length) return <div className="text-zinc-500">Không có dữ liệu</div>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-zinc-500 border-b border-zinc-800">
            <th className="pb-2 pr-4">Table</th>
            <th className="pb-2 pr-4">Rows</th>
            <th className="pb-2">Size</th>
          </tr>
        </thead>
        <tbody>
          {dbStats.map((t: any, i: number) => (
            <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-900/50">
              <td className="py-2 pr-4 text-zinc-200 font-mono">{t.table_name || t.name}</td>
              <td className="py-2 pr-4 text-zinc-400">{(t.row_count ?? t.rows ?? 0).toLocaleString()}</td>
              <td className="py-2 text-zinc-400 font-mono text-xs">{t.size || formatBytes(t.size_bytes ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


function SecurityTab({ security }: { security: any }) {
  if (!security) return <div className="text-zinc-500">Đang tải dữ liệu bảo mật...</div>;

  const cards = [
    { label: 'Hành động bị chặn', value: security.denied_actions ?? 0, color: 'text-red-400', bg: 'bg-red-900/20' },
    { label: 'Thực thi trust thấp', value: security.low_trust_executions ?? 0, color: 'text-orange-400', bg: 'bg-orange-900/20' },
    { label: 'Kế hoạch bị dừng', value: security.stalled_plans ?? 0, color: 'text-yellow-400', bg: 'bg-yellow-900/20' },
    { label: 'Kế hoạch đang chạy', value: security.active_plans ?? 0, color: 'text-blue-400', bg: 'bg-blue-900/20' },
    { label: 'Embedding backlog', value: security.embedding_backlog ?? 0, color: 'text-purple-400', bg: 'bg-purple-900/20' },
  ];

  const trend = security.reflection_trend || [];

  return (
    <div className="space-y-6">
      <h3 className="text-sm font-medium text-zinc-400">Bảo mật & Giám sát</h3>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {cards.map((c, i) => (
          <div key={i} className={c.bg + ' border border-zinc-800 rounded-lg p-4'}>
            <div className={'text-2xl font-bold ' + c.color}>{c.value}</div>
            <div className="text-xs text-zinc-500 mt-1">{c.label}</div>
          </div>
        ))}
      </div>

      {trend.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-zinc-400 mb-3">Xu hướng phản ánh (7 ngày)</h4>
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <div className="flex items-end gap-2 h-32">
              {trend.map((t: { date: string; score: number }, i: number) => {
                const height = Math.max(10, (t.score / 10) * 100);
                return (
                  <div key={i} className="flex flex-col items-center flex-1 gap-1">
                    <div
                      className="w-full bg-blue-500/30 rounded-t"
                      style={{ height: height + '%' }}
                      title={t.date + ': ' + t.score}
                    />
                    <span className="text-[10px] text-zinc-600 truncate w-full text-center">{t.date.slice(5)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-400 mb-2">Trạng thái</h4>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-zinc-500">Hành động bị chặn / tu choi</span>
            <span className={security.denied_actions > 0 ? 'text-red-400 font-medium' : 'text-green-400'}>{security.denied_actions > 0 ? 'Cần xem xét' : 'Bình thường'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">Trust thấp đã thực thi</span>
            <span className={security.low_trust_executions > 0 ? 'text-orange-400 font-medium' : 'text-green-400'}>{security.low_trust_executions > 0 ? 'Cảnh báo' : 'An toàn'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">Embedding backlog</span>
            <span className={security.embedding_backlog > 10 ? 'text-yellow-400 font-medium' : 'text-green-400'}>{security.embedding_backlog > 10 ? 'Cần xử lý' : 'Tốt'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsTab({ settings, onUpdate }: { settings: any[]; onUpdate: (key: string, value: string) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  if (!settings.length) return <div className="text-zinc-500">Không có cài đặt</div>;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg divide-y divide-zinc-800">
      {settings.map((s: any) => {
        const key = s.key || s.name;
        const value = s.value ?? '';
        return (
          <div key={key} className="flex items-center px-4 py-3 gap-4">
            <span className="text-sm text-zinc-500 w-56 shrink-0 font-mono">{key}</span>
            {editing === key ? (
              <div className="flex items-center gap-2 flex-1">
                <input
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-100 focus:border-blue-500 outline-none flex-1"
                />
                <button
                  onClick={() => { onUpdate(key, editValue); setEditing(null); }}
                  className="p-1 rounded hover:bg-green-600/20 text-green-400"
                >
                  <Check size={14} />
                </button>
                <button onClick={() => setEditing(null)} className="p-1 rounded hover:bg-zinc-700 text-zinc-400">
                  <X size={14} />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <span className="text-sm text-zinc-200 font-mono truncate flex-1">{value || '—'}</span>
                <button
                  onClick={() => { setEditing(key); setEditValue(String(value)); }}
                  className="p-1 rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-300 shrink-0"
                >
                  <Pencil size={12} />
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
