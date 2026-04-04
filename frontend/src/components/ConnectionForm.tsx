'use client';

import { useEffect, useState } from 'react';
import { Eye, EyeOff, X, ChevronLeft, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { ProviderTypeDef, ProviderConnection, PROVIDER_ICONS, PROVIDER_COLORS } from '@/lib/providerRegistry';

interface ConnectionFormProps {
  editConn?: ProviderConnection | null;
  onSave: () => void;
  onCancel: () => void;
}

export function ConnectionForm({ editConn, onSave, onCancel }: ConnectionFormProps) {
  const [step, setStep] = useState<'type' | 'config'>(editConn ? 'config' : 'type');
  const [providerTypes, setProviderTypes] = useState<ProviderTypeDef[]>([]);
  const [selectedType, setSelectedType] = useState<ProviderTypeDef | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showKey, setShowKey] = useState(false);

  // Form fields
  const [name, setName] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [authType, setAuthType] = useState('api_key');
  const [apiKey, setApiKey] = useState('');
  const [priority, setPriority] = useState(1);
  const [models, setModels] = useState<string[]>([]);
  const [modelInput, setModelInput] = useState('');

  useEffect(() => {
    api.getProviderTypes().then(types => {
      setProviderTypes(Array.isArray(types) ? types : []);
      if (editConn) {
        const t = (Array.isArray(types) ? types : []).find((x: ProviderTypeDef) => x.type === editConn.provider_type);
        setSelectedType(t || null);
        initFromConn(editConn);
      }
    }).catch(() => {});
  }, []);

  const initFromConn = (conn: ProviderConnection) => {
    setName(conn.name);
    setApiUrl(conn.api_url);
    setAuthType(conn.auth_type);
    setPriority(conn.priority);
    try { setModels(JSON.parse(conn.models) || []); } catch { setModels([]); }
  };

  const selectType = (type: ProviderTypeDef) => {
    setSelectedType(type);
    setName(type.name);
    setApiUrl(type.default_url);
    setAuthType(type.auth_types[0] || 'api_key');
    setModels([...type.known_models]);
    setPriority(1);
    setApiKey('');
    setStep('config');
  };

  const addModel = () => {
    const m = modelInput.trim();
    if (m && !models.includes(m)) {
      setModels(prev => [...prev, m]);
      setModelInput('');
    }
  };

  const removeModel = (m: string) => {
    setModels(prev => prev.filter(x => x !== m));
  };

  const handleSave = async () => {
    setError('');
    if (!name.trim()) { setError('Tên là bắt buộc'); return; }
    if (!editConn && !apiKey.trim()) { setError('API Key là bắt buộc'); return; }
    if (!editConn && !selectedType) { setError('Chọn loại nhà cung cấp'); return; }

    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        api_url: apiUrl.trim(),
        auth_type: authType,
        priority,
        models: JSON.stringify(models),
      };
      if (apiKey.trim()) payload.api_key = apiKey.trim();
      if (!editConn && selectedType) payload.provider_type = selectedType.type;

      if (editConn) {
        await api.updateConnection(editConn.id, payload);
      } else {
        await api.createConnection(payload);
      }
      onSave();
    } catch (e: any) {
      setError(e.message || 'Lưu thất bại');
    } finally {
      setSaving(false);
    }
  };

  const inputCls = "w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none";

  if (step === 'type') {
    return (
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-white font-medium text-sm">Chọn loại nhà cung cấp</h3>
          <button onClick={onCancel} className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-white">
            <X size={14} />
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {providerTypes.map(type => {
            const icon = PROVIDER_ICONS[type.type] || '⚙️';
            const color = PROVIDER_COLORS[type.type] || '#6b7280';
            return (
              <button
                key={type.type}
                onClick={() => selectType(type)}
                className="flex flex-col items-start gap-2 p-3 rounded-lg bg-zinc-900 border border-zinc-800 hover:border-blue-500 transition text-left group"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xl">{icon}</span>
                  <span className="text-sm font-medium text-white group-hover:text-blue-400 transition">{type.name}</span>
                </div>
                <p className="text-xs text-zinc-500 leading-snug">{type.description}</p>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        {!editConn && (
          <button onClick={() => setStep('type')} className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-white">
            <ChevronLeft size={16} />
          </button>
        )}
        <div className="flex items-center gap-2 flex-1">
          {selectedType && <span className="text-lg">{PROVIDER_ICONS[selectedType.type] || '⚙️'}</span>}
          <h3 className="text-white font-medium text-sm">
            {editConn ? `Chỉnh sửa: ${editConn.name}` : `Thêm ${selectedType?.name || ''}`}
          </h3>
        </div>
        <button onClick={onCancel} className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-white">
          <X size={14} />
        </button>
      </div>

      <div className="space-y-3">
        <div>
          <label className="text-xs text-zinc-500 block mb-1">Tên kết nối</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Tên kết nối" className={inputCls} />
        </div>
        <div>
          <label className="text-xs text-zinc-500 block mb-1">API URL</label>
          <input value={apiUrl} onChange={e => setApiUrl(e.target.value)} placeholder="https://api.example.com/v1" className={inputCls} />
        </div>
        {selectedType && selectedType.auth_types.length > 1 && (
          <div>
            <label className="text-xs text-zinc-500 block mb-1.5">Loại xác thực</label>
            <div className="flex gap-3">
              {selectedType.auth_types.map(at => (
                <label key={at} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="auth_type"
                    value={at}
                    checked={authType === at}
                    onChange={() => setAuthType(at)}
                    className="accent-blue-500"
                  />
                  <span className="text-sm text-zinc-300">{at === 'api_key' ? 'API Key' : 'OAuth'}</span>
                </label>
              ))}
            </div>
          </div>
        )}
        <div>
          <label className="text-xs text-zinc-500 block mb-1">
            API Key {editConn && <span className="text-zinc-600">(để trống nếu không đổi)</span>}
          </label>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={editConn ? '••••••••' : 'sk-...'}
              className={`${inputCls} pr-9`}
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white"
            >
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
        <div>
          <label className="text-xs text-zinc-500 block mb-1">Ưu tiên (số nhỏ = ưu tiên cao)</label>
          <input type="number" min={1} max={100} value={priority} onChange={e => setPriority(Number(e.target.value))} className={inputCls} />
        </div>
        <div>
          <label className="text-xs text-zinc-500 block mb-1.5">Models</label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {models.map(m => (
              <span key={m} className="flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-zinc-800 text-zinc-300">
                {m}
                <button onClick={() => removeModel(m)} className="text-zinc-500 hover:text-red-400">
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={modelInput}
              onChange={e => setModelInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addModel(); } }}
              placeholder="Thêm model..."
              className={`${inputCls} flex-1`}
            />
            <button onClick={addModel} className="px-3 py-2 rounded bg-zinc-700 hover:bg-zinc-600 text-white text-sm">
              <Plus size={14} />
            </button>
          </div>
        </div>

        {error && <p className="text-red-400 text-xs">{error}</p>}
        <div className="flex gap-2 pt-1">
          <button onClick={handleSave} disabled={saving}
            className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white py-2 rounded text-sm transition">
            {saving ? 'Đang lưu...' : editConn ? 'Cập nhật' : 'Tạo kết nối'}
          </button>
          <button onClick={onCancel}
            className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm transition">
            Hủy
          </button>
        </div>
      </div>
    </div>
  );
}
