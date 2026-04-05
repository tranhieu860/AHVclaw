'use client';

import { useEffect, useState } from 'react';
import { Network, Plus, ExternalLink, RefreshCw, Trash2, Cpu, Check, Search } from 'lucide-react';
import { ConnectionList } from '@/components/ConnectionList';
import { ConnectionForm } from '@/components/ConnectionForm';
import { ComboForm } from '@/components/ComboForm';
import HealthDashboard from '@/components/HealthDashboard';
import { api } from '@/lib/api';
import { ModelCombo } from '@/lib/providerRegistry';

export default function ConnectionsPage() {
  const [showConnForm, setShowConnForm] = useState(false);
  const [editConn, setEditConn] = useState<any>(null);
  const [showComboForm, setShowComboForm] = useState(false);
  const [editCombo, setEditCombo] = useState<ModelCombo | null>(null);
  const [combos, setCombos] = useState<ModelCombo[]>([]);
  const [connRefresh, setConnRefresh] = useState(0);

  // OAuth states
  const [oauthConnecting, setOauthConnecting] = useState<string | null>(null);
  const [showPasteUrl, setShowPasteUrl] = useState(false);
  const [pasteUrl, setPasteUrl] = useState('');
  const [pasteError, setPasteError] = useState('');
  const [pasteLoading, setPasteLoading] = useState(false);
  const [openaiAuthUrl, setOpenaiAuthUrl] = useState('');
  const [modelPickerConn, setModelPickerConn] = useState<string | null>(null);
  const [remoteModels, setRemoteModels] = useState<{ id: string; owned_by: string }[]>([]);
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsSaving, setModelsSaving] = useState(false);

  const loadCombos = async () => {
    try {
      const data = await api.getCombos();
      setCombos(Array.isArray(data) ? data : []);
    } catch { setCombos([]); }
  };

  useEffect(() => { loadCombos(); }, []);

  // Listen for OAuth popup success
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'oauth_success') {
        setShowPasteUrl(false);
        setOauthConnecting(null);
        // After OAuth success, open model picker
        api.getConnections().then(conns => {
          if (conns.length > 0) {
            const newest = conns.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
            openModelPicker(newest.id);
          } else {
            setConnRefresh(r => r + 1);
          }
        });
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const openModelPicker = async (connId: string) => {
    setModelPickerConn(connId);
    setModelsLoading(true);
    setSelectedModels(new Set());
    setRemoteModels([]);
    try {
      const data = await api.fetchRemoteModels(connId);
      setRemoteModels(data.models || []);
    } catch (err) {
      console.error('Failed to fetch models:', err);
    } finally {
      setModelsLoading(false);
    }
  };

  const toggleModel = (id: string) => {
    setSelectedModels(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const saveSelectedModels = async () => {
    if (!modelPickerConn || selectedModels.size === 0) return;
    setModelsSaving(true);
    try {
      await api.updateConnection(modelPickerConn, { models: Array.from(selectedModels) });
      setModelPickerConn(null);
      setConnRefresh(r => r + 1);
    } catch (err) {
      console.error('Failed to save models:', err);
    } finally {
      setModelsSaving(false);
    }
  };

  const handleOAuthConnect = async (provider: string) => {
    setOauthConnecting(provider);
    setPasteError('');
    try {
      const data = await api.startOAuth(provider);
      if (data.paste_url) {
        // OpenAI: show modal with link (don't auto-open, better for mobile)
        setOpenaiAuthUrl(data.auth_url);
        setShowPasteUrl(true);
        setPasteUrl('');
      } else {
        // Claude/Gemini: open popup directly
        const w = 600, h = 700;
        const left = window.screenX + (window.innerWidth - w) / 2;
        const top = window.screenY + (window.innerHeight - h) / 2;
        window.open(data.auth_url, 'oauth_popup', `width=${w},height=${h},left=${left},top=${top}`);
      }
    } catch (err) {
      console.error('OAuth start failed:', err);
      setOauthConnecting(null);
    }
  };

  const handlePasteSubmit = async () => {
    if (!pasteUrl.trim()) return;
    setPasteLoading(true);
    setPasteError('');
    try {
      await api.exchangeOAuth(pasteUrl.trim());
      setShowPasteUrl(false);
      setPasteUrl('');
      setOauthConnecting(null);
      setConnRefresh(r => r + 1);
    } catch (err: any) {
      setPasteError(err?.message || 'Không thể kết nối. Kiểm tra lại URL.');
    } finally {
      setPasteLoading(false);
    }
  };

  const handleConnSaved = () => {
    setShowConnForm(false);
    setEditConn(null);
    setConnRefresh(r => r + 1);
  };

  const handleComboSaved = () => {
    setShowComboForm(false);
    setEditCombo(null);
    loadCombos();
  };

  const deleteCombo = async (id: string) => {
    if (!confirm('Xóa combo này?')) return;
    try {
      await api.deleteCombo(id);
      loadCombos();
    } catch {}
  };

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <h1 className="text-xl font-semibold text-white flex items-center gap-2 mb-6">
        <Network size={20} /> Kết nối AI
      </h1>

      <div className="max-w-3xl space-y-6">
        {/* Connection Form overlay */}
        {(showConnForm || editConn) ? (
          <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-4">
            <ConnectionForm
              editConn={editConn}
              onSave={handleConnSaved}
              onCancel={() => { setShowConnForm(false); setEditConn(null); }}
            />
          </div>
        ) : (
          <>
            {/* Health Dashboard */}
            <HealthDashboard />

            {/* OAuth Quick Connect */}
            <div className="p-4 bg-zinc-900/50 border border-zinc-800 rounded-lg">
              <h3 className="text-sm font-medium text-white mb-1">Kết nối nhanh qua OAuth</h3>
              <p className="text-xs text-zinc-500 mb-3">Đăng nhập tài khoản AI của bạn — không cần API key. Có thể kết nối nhiều tài khoản cùng nhà cung cấp.</p>
              <div className="flex flex-wrap gap-2">
                {[
                  { id: 'claude', label: 'Claude', icon: '🟠' },
                  { id: 'openai', label: 'OpenAI', icon: '🟢' },
                  { id: 'gemini', label: 'Gemini', icon: '🔵' },
                ].map(p => (
                  <button
                    key={p.id}
                    onClick={() => handleOAuthConnect(p.id)}
                    disabled={oauthConnecting === p.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border bg-zinc-800 hover:bg-zinc-700 border-zinc-700 text-white disabled:opacity-50 text-xs font-medium transition"
                  >
                    <span>{p.icon}</span>
                    {oauthConnecting === p.id ? (
                      <><RefreshCw size={11} className="animate-spin" /> Đang kết nối...</>
                    ) : (
                      <><ExternalLink size={11} /> {p.label}</>
                    )}
                  </button>
                ))}
              </div>


            </div>

            {/* Connection List */}
            <ConnectionList
              onAdd={() => setShowConnForm(true)}
              onEdit={(conn) => { setEditConn(conn); setShowConnForm(false); }}
              refreshTrigger={connRefresh}
            />
          </>
        )}

        {/* Combos section */}
        <div className="border-t border-zinc-800 pt-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-white font-medium text-sm">Combo model</h3>
              <p className="text-xs text-zinc-500 mt-0.5">Nhóm nhiều model với chiến lược dự phòng hoặc luân phiên</p>
            </div>
          </div>

          {showComboForm || editCombo ? (
            <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-4">
              <ComboForm
                editCombo={editCombo}
                onSave={handleComboSaved}
                onCancel={() => { setShowComboForm(false); setEditCombo(null); }}
              />
            </div>
          ) : (
            <div className="space-y-2">
              {combos.length === 0 ? (
                <div className="text-center py-6 text-zinc-500">
                  <div className="text-2xl mb-1">🔀</div>
                  <p className="text-sm">Chưa có combo nào.</p>
                </div>
              ) : (
                combos.map(combo => {
                  let modelList: string[] = [];
                  try { modelList = JSON.parse(combo.models) || []; } catch {}
                  return (
                    <div key={combo.id} className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
                      <div className="flex items-center gap-2">
                        <span className="text-base">🔀</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-white">{combo.name}</span>
                            <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                              {combo.strategy === 'fallback' ? 'dự phòng' : 'luân phiên'}
                            </span>
                            {!combo.is_active && (
                              <span className="text-xs text-zinc-600">tắt</span>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {modelList.slice(0, 5).map((m: string, i: number) => (
                              <span key={i} className="text-xs text-zinc-500">
                                {i > 0 && <span className="text-zinc-700 mr-1">{combo.strategy === 'fallback' ? '→' : '↻'}</span>}
                                {m}
                              </span>
                            ))}
                            {modelList.length > 5 && <span className="text-xs text-zinc-600">+{modelList.length - 5}</span>}
                          </div>
                        </div>
                        <div className="flex gap-1">
                          <button onClick={() => setEditCombo(combo)}
                            className="p-1.5 rounded hover:bg-zinc-700 text-zinc-400 hover:text-white transition">
                            <Cpu size={13} />
                          </button>
                          <button onClick={() => deleteCombo(combo.id)}
                            className="p-1.5 rounded hover:bg-zinc-700 text-red-400 hover:text-red-300 transition">
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
              <button
                onClick={() => setShowComboForm(true)}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-dashed border-zinc-700 text-zinc-400 hover:border-blue-500 hover:text-blue-400 transition text-sm"
              >
                <Plus size={14} /> Tạo combo mới
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Model Picker Modal */}
      {modelPickerConn && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-zinc-900 border border-emerald-700/50 rounded-xl p-5 w-full max-w-lg shadow-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-base font-semibold text-white">Chọn model</h3>
                <p className="text-xs text-zinc-400 mt-0.5">Chọn các model bạn muốn sử dụng</p>
              </div>
              <span className="text-xs text-zinc-500">{selectedModels.size} đã chọn</span>
            </div>
            {modelsLoading ? (
              <div className="flex-1 flex items-center justify-center py-8">
                <RefreshCw size={20} className="animate-spin text-emerald-500" />
                <span className="ml-2 text-zinc-400 text-sm">Đang tải danh sách model...</span>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto space-y-1 pr-1">
                {remoteModels.length === 0 ? (
                  <p className="text-zinc-500 text-sm text-center py-4">Không tìm thấy model nào</p>
                ) : remoteModels.map(m => (
                  <button
                    key={m.id}
                    onClick={() => toggleModel(m.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition text-sm ${
                      selectedModels.has(m.id)
                        ? 'bg-emerald-900/40 border border-emerald-600/50 text-white'
                        : 'bg-zinc-800/50 border border-transparent hover:bg-zinc-800 text-zinc-300'
                    }`}
                  >
                    <div className={`w-5 h-5 rounded flex items-center justify-center flex-shrink-0 ${
                      selectedModels.has(m.id) ? 'bg-emerald-600' : 'bg-zinc-700'
                    }`}>
                      {selectedModels.has(m.id) && <Check size={13} className="text-white" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="font-mono text-xs">{m.id}</span>
                    </div>
                    <span className="text-[10px] text-zinc-500 flex-shrink-0">{m.owned_by}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="flex gap-2 mt-4 pt-3 border-t border-zinc-800">
              <button
                onClick={saveSelectedModels}
                disabled={modelsSaving || selectedModels.size === 0}
                className="flex-1 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition"
              >
                {modelsSaving ? 'Đang lưu...' : `Thêm ${selectedModels.size} model`}
              </button>
              <button
                onClick={() => setModelPickerConn(null)}
                className="px-4 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded-lg text-sm transition"
              >
                Hủy
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Paste URL Modal - fixed overlay for mobile */}
      {showPasteUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-zinc-900 border border-emerald-700/50 rounded-xl p-5 w-full max-w-md shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <span className="text-2xl">🟢</span>
              <div>
                <h3 className="text-base font-semibold text-white">Kết nối OpenAI</h3>
                <p className="text-xs text-zinc-400 mt-0.5">Bước 2/2</p>
              </div>
            </div>
            <div className="bg-zinc-800/50 rounded-lg p-3 mb-4 text-xs text-zinc-300 space-y-2">
              <p className="font-medium text-white text-sm mb-2">Các bước:</p>
              <p>1. Bấm nút bên dưới để mở trang đăng nhập OpenAI</p>
              <p>2. Đăng nhập tài khoản OpenAI</p>
              <p>3. Sau đăng nhập, trang chuyển đến <code className="text-emerald-400 bg-zinc-800 px-1 rounded">localhost...</code> (bình thường)</p>
              <p>4. Copy toàn bộ URL từ thanh địa chỉ</p>
              <p>5. Quay lại đây và dán vào ô bên dưới</p>
            </div>
            {openaiAuthUrl && (
              <a
                href={openaiAuthUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full px-4 py-3 mb-4 bg-emerald-700 hover:bg-emerald-600 text-white rounded-lg text-sm font-medium transition"
              >
                <ExternalLink size={16} /> Mở trang đăng nhập OpenAI
              </a>
            )}
            <textarea
              value={pasteUrl}
              onChange={e => { setPasteUrl(e.target.value); setPasteError(''); }}
              placeholder="Dán URL vào đây..."
              rows={3}
              className="w-full bg-zinc-800 text-white rounded-lg px-3 py-2.5 text-sm border border-zinc-700 focus:border-emerald-500 outline-none font-mono resize-none"
              autoFocus
            />
            {pasteError && <p className="text-red-400 text-xs mt-2">{pasteError}</p>}
            <div className="flex gap-2 mt-3">
              <button
                onClick={handlePasteSubmit}
                disabled={pasteLoading || !pasteUrl.trim()}
                className="flex-1 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition"
              >
                {pasteLoading ? 'Đang xử lý...' : 'Kết nối'}
              </button>
              <button
                onClick={() => { setShowPasteUrl(false); setOauthConnecting(null); setPasteError(''); }}
                className="px-4 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded-lg text-sm transition"
              >
                Hủy
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
