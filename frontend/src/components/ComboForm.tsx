'use client';

import { useEffect, useState } from 'react';
import { X, Plus, ArrowUp, ArrowDown, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { ModelCombo, AvailableModel } from '@/lib/providerRegistry';

interface ComboFormProps {
  editCombo?: ModelCombo | null;
  onSave: () => void;
  onCancel: () => void;
}

interface ComboModel {
  id: string;
  name: string;
  provider_type?: string;
}

export function ComboForm({ editCombo, onSave, onCancel }: ComboFormProps) {
  const [name, setName] = useState(editCombo?.name || '');
  const [strategy, setStrategy] = useState(editCombo?.strategy || 'fallback');
  const [comboModels, setComboModels] = useState<ComboModel[]>([]);
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [customModel, setCustomModel] = useState('');

  useEffect(() => {
    api.getAvailableModels().then(models => {
      setAvailableModels(Array.isArray(models) ? models : []);
    }).catch(() => {});

    if (editCombo) {
      try {
        const parsed = JSON.parse(editCombo.models);
        if (Array.isArray(parsed)) {
          setComboModels(parsed.map((m: any) => (typeof m === 'string' ? { id: m, name: m } : m)));
        }
      } catch {}
    }
  }, []);

  const addModel = (model: AvailableModel) => {
    if (comboModels.find(m => m.id === model.id)) return;
    setComboModels(prev => [...prev, { id: model.id, name: model.name, provider_type: model.provider_type }]);
  };

  const addCustomModel = () => {
    const m = customModel.trim();
    if (!m) return;
    if (comboModels.find(cm => cm.id === m)) return;
    setComboModels(prev => [...prev, { id: m, name: m }]);
    setCustomModel('');
  };

  const removeModel = (id: string) => {
    setComboModels(prev => prev.filter(m => m.id !== id));
  };

  const moveModel = (idx: number, dir: 'up' | 'down') => {
    const newArr = [...comboModels];
    const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= newArr.length) return;
    [newArr[idx], newArr[swapIdx]] = [newArr[swapIdx], newArr[idx]];
    setComboModels(newArr);
  };

  const handleSave = async () => {
    setError('');
    if (!name.trim()) { setError('Tên combo là bắt buộc'); return; }
    if (comboModels.length === 0) { setError('Cần ít nhất 1 model'); return; }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        strategy,
        models: JSON.stringify(comboModels.map(m => m.id)),
      };
      if (editCombo) {
        await api.updateCombo(editCombo.id, payload);
      } else {
        await api.createCombo(payload);
      }
      onSave();
    } catch (e: any) {
      setError(e.message || 'Lưu thất bại');
    } finally {
      setSaving(false);
    }
  };

  const inputCls = "w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none";

  const providerColors: Record<string, string> = {
    openai: 'text-green-400',
    anthropic: 'text-orange-400',
    gemini: 'text-blue-400',
    minimax: 'text-yellow-400',
    deepseek: 'text-cyan-400',
    glm: 'text-purple-400',
    combo: 'text-pink-400',
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-white font-medium text-sm">
          {editCombo ? `Chỉnh sửa combo: ${editCombo.name}` : 'Tạo combo model'}
        </h3>
        <button onClick={onCancel} className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-white">
          <X size={14} />
        </button>
      </div>

      <div className="space-y-4">
        <div>
          <label className="text-xs text-zinc-500 block mb-1">Tên combo</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="VD: GPT-Claude-Fallback" className={inputCls} />
        </div>

        <div>
          <label className="text-xs text-zinc-500 block mb-1.5">Chiến lược</label>
          <div className="flex gap-4">
            {[
              { value: 'fallback', label: 'Dự phòng', desc: 'Thử lần lượt khi có lỗi' },
              { value: 'round_robin', label: 'Luân phiên', desc: 'Phân bổ đều các model' },
            ].map(s => (
              <label key={s.value} className="flex items-start gap-2 cursor-pointer group">
                <input type="radio" name="strategy" value={s.value} checked={strategy === s.value}
                  onChange={() => setStrategy(s.value)} className="accent-blue-500 mt-0.5" />
                <div>
                  <span className="text-sm text-zinc-300 group-hover:text-white">{s.label}</span>
                  <p className="text-xs text-zinc-600">{s.desc}</p>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs text-zinc-500 block mb-1.5">Models trong combo ({comboModels.length})</label>
          {comboModels.length === 0 ? (
            <p className="text-xs text-zinc-600 py-2">Chưa có model nào. Thêm từ danh sách bên dưới.</p>
          ) : (
            <div className="space-y-1 mb-2">
              {comboModels.map((m, idx) => (
                <div key={m.id} className="flex items-center gap-2 p-2 rounded bg-zinc-800 border border-zinc-700">
                  <span className="text-xs text-zinc-400 w-5 text-center font-mono">{idx + 1}</span>
                  <span className="flex-1 text-sm text-white truncate">{m.name}</span>
                  {m.provider_type && (
                    <span className={`text-xs ${providerColors[m.provider_type] || 'text-zinc-500'}`}>
                      {m.provider_type}
                    </span>
                  )}
                  <div className="flex gap-0.5">
                    <button onClick={() => moveModel(idx, 'up')} disabled={idx === 0}
                      className="p-1 rounded hover:bg-zinc-700 text-zinc-500 hover:text-white disabled:opacity-30">
                      <ArrowUp size={11} />
                    </button>
                    <button onClick={() => moveModel(idx, 'down')} disabled={idx === comboModels.length - 1}
                      className="p-1 rounded hover:bg-zinc-700 text-zinc-500 hover:text-white disabled:opacity-30">
                      <ArrowDown size={11} />
                    </button>
                    <button onClick={() => removeModel(m.id)}
                      className="p-1 rounded hover:bg-zinc-700 text-red-400 hover:text-red-300">
                      <X size={11} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {availableModels.length > 0 && (
            <div>
              <p className="text-xs text-zinc-600 mb-1">Thêm từ kết nối đang hoạt động:</p>
              <div className="flex flex-wrap gap-1">
                {availableModels.filter(m => !comboModels.find(cm => cm.id === m.id)).slice(0, 12).map(m => (
                  <button key={m.id} onClick={() => addModel(m)}
                    className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 transition">
                    + {m.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-2 mt-2">
            <input
              value={customModel}
              onChange={e => setCustomModel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustomModel(); } }}
              placeholder="Hoặc nhập model thủ công..."
              className={`${inputCls} flex-1`}
            />
            <button onClick={addCustomModel}
              className="px-3 py-2 rounded bg-zinc-700 hover:bg-zinc-600 text-white text-sm">
              <Plus size={14} />
            </button>
          </div>
        </div>

        {error && <p className="text-red-400 text-xs">{error}</p>}
        <div className="flex gap-2">
          <button onClick={handleSave} disabled={saving}
            className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white py-2 rounded text-sm transition">
            {saving ? 'Đang lưu...' : editCombo ? 'Cập nhật' : 'Tạo combo'}
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
