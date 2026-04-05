'use client';

import { useEffect, useState, useCallback } from 'react';
import { Plus, Trash2, RefreshCw, Zap, AlertTriangle, ChevronDown, ChevronRight, Edit2, List } from 'lucide-react';
import { api } from '@/lib/api';
import { ProviderConnection, ProviderTypeDef, PROVIDER_ICONS, PROVIDER_COLORS, parseModels, getStatusDot, getStatusColor } from '@/lib/providerRegistry';

interface ConnectionListProps {
  onAdd: () => void;
  onEdit: (conn: ProviderConnection) => void;
  onPickModels?: (connId: string) => void;
  refreshTrigger?: number;
}

export function ConnectionList({ onAdd, onEdit, onPickModels, refreshTrigger }: ConnectionListProps) {
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [providerTypes, setProviderTypes] = useState<ProviderTypeDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string }>>({});

  const load = useCallback(async () => {
    try {
      const [conns, types] = await Promise.all([api.getConnections(), api.getProviderTypes()]);
      setConnections(Array.isArray(conns) ? conns : []);
      setProviderTypes(Array.isArray(types) ? types : []);
      // Auto-expand all groups
      const groups = new Set<string>((Array.isArray(conns) ? conns : []).map((c: ProviderConnection) => c.provider_type));
      setExpandedGroups(groups);
    } catch {
      setConnections([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshTrigger]);

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const result = await api.testConnection(id);
      setTestResults(prev => ({ ...prev, [id]: { success: result.success, message: result.success ? 'Kết nối thành công' : (result.message || 'Kết nối thất bại') } }));
      await load();
    } catch (e: any) {
      setTestResults(prev => ({ ...prev, [id]: { success: false, message: e.message || 'Lỗi kết nối' } }));
    } finally {
      setTestingId(null);
    }
  };

  const handleReset = async (id: string) => {
    setResettingId(id);
    try {
      await api.resetConnection(id);
      await load();
    } catch {} finally {
      setResettingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Xóa kết nối này?')) return;
    setDeletingId(id);
    try {
      await api.deleteConnection(id);
      await load();
    } catch {} finally {
      setDeletingId(null);
    }
  };

  const toggleGroup = (type: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  // Group connections by provider_type
  const groups = connections.reduce<Record<string, ProviderConnection[]>>((acc, conn) => {
    if (!acc[conn.provider_type]) acc[conn.provider_type] = [];
    acc[conn.provider_type].push(conn);
    return acc;
  }, {});

  const getTypeName = (type: string) => {
    const def = providerTypes.find(t => t.type === type);
    return def ? def.name : type;
  };

  if (loading) {
    return <div className="text-zinc-500 text-sm py-6 text-center">Đang tải kết nối...</div>;
  }

  return (
    <div className="space-y-3">
      {connections.length === 0 ? (
        <div className="text-center py-8 text-zinc-500">
          <div className="text-3xl mb-2">🔌</div>
          <p className="text-sm">Chưa có kết nối nào. Thêm kết nối đầu tiên!</p>
        </div>
      ) : (
        Object.entries(groups).map(([type, conns]) => {
          const icon = PROVIDER_ICONS[type] || '⚙️';
          const color = PROVIDER_COLORS[type] || '#6b7280';
          const expanded = expandedGroups.has(type);
          return (
            <div key={type} className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
              <button
                onClick={() => toggleGroup(type)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-zinc-800/50 transition"
              >
                <span className="text-lg">{icon}</span>
                <span className="font-medium text-white text-sm flex-1 text-left">{getTypeName(type)}</span>
                <span className="text-xs text-zinc-500 px-2 py-0.5 rounded-full bg-zinc-800">{conns.length}</span>
                {expanded ? <ChevronDown size={14} className="text-zinc-500" /> : <ChevronRight size={14} className="text-zinc-500" />}
              </button>

              {expanded && (
                <div className="border-t border-zinc-800 divide-y divide-zinc-800/50">
                  {conns.map(conn => {
                    const models = parseModels(conn.models);
                    const testResult = testResults[conn.id];
                    return (
                      <div key={conn.id} className="px-4 py-3">
                        <div className="flex items-start gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-medium text-white truncate">{conn.name}</span>
                              <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">{conn.auth_type}</span>
                              <span className="text-xs" title={`Trạng thái: ${conn.test_status}`}>
                                {getStatusDot(conn.test_status)}
                              </span>
                              <span className={`text-xs ${getStatusColor(conn.test_status)}`}>{conn.test_status}</span>
                              {conn.backoff_level > 0 && (
                                <span className="flex items-center gap-1 text-xs text-yellow-400" title={`Backoff level: ${conn.backoff_level}`}>
                                  <AlertTriangle size={10} /> backoff {conn.backoff_level}
                                </span>
                              )}
                              <span className="text-xs text-zinc-600">ưu tiên: {conn.priority}</span>
                            </div>
                            <p className="text-xs text-zinc-600 mt-0.5 truncate">{conn.api_url}</p>
                            {models.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-1.5">
                                {models.slice(0, 4).map(m => (
                                  <span key={m} className="text-xs px-1.5 py-0.5 rounded bg-zinc-800/70 text-zinc-500">{m}</span>
                                ))}
                                {models.length > 4 && <span className="text-xs text-zinc-600">+{models.length - 4}</span>}
                              </div>
                            )}
                            {conn.last_error && (
                              <p className="text-xs text-red-400/70 mt-1 truncate" title={conn.last_error}>
                                Lỗi: {conn.last_error.substring(0, 80)}
                              </p>
                            )}
                            {testResult && (
                              <p className={`text-xs mt-1 ${testResult.success ? 'text-green-400' : 'text-red-400'}`}>
                                {testResult.message}
                              </p>
                            )}
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              onClick={() => handleTest(conn.id)}
                              disabled={testingId === conn.id}
                              title="Kiểm tra kết nối"
                              className="p-1.5 rounded hover:bg-zinc-700 text-blue-400 hover:text-blue-300 disabled:opacity-50 transition"
                            >
                              <Zap size={13} />
                            </button>
                            <button
                              onClick={() => handleReset(conn.id)}
                              disabled={resettingId === conn.id}
                              title="Reset backoff"
                              className="p-1.5 rounded hover:bg-zinc-700 text-yellow-400 hover:text-yellow-300 disabled:opacity-50 transition"
                            >
                              <RefreshCw size={13} className={resettingId === conn.id ? 'animate-spin' : ''} />
                            </button>
                            {onPickModels && (
                              <button
                                onClick={() => onPickModels(conn.id)}
                                title="Chọn model"
                                className="p-1.5 rounded hover:bg-zinc-700 text-blue-400 hover:text-blue-300 transition"
                              >
                                <List size={13} />
                              </button>
                            )}
                            <button
                              onClick={() => onEdit(conn)}
                              title="Chỉnh sửa"
                              className="p-1.5 rounded hover:bg-zinc-700 text-zinc-400 hover:text-white transition"
                            >
                              <Edit2 size={13} />
                            </button>
                            <button
                              onClick={() => handleDelete(conn.id)}
                              disabled={deletingId === conn.id}
                              title="Xóa kết nối"
                              className="p-1.5 rounded hover:bg-zinc-700 text-red-400 hover:text-red-300 disabled:opacity-50 transition"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })
      )}
      <button
        onClick={onAdd}
        className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-dashed border-zinc-700 text-zinc-400 hover:border-blue-500 hover:text-blue-400 transition text-sm"
      >
        <Plus size={14} /> Thêm kết nối
      </button>
    </div>
  );
}
