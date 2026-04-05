'use client';

import { useEffect, useState } from 'react';
import { Database, Plus, Trash2, FileText, Search, X, BookOpen, Upload, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';

interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  documents_count?: number;
  created_at: string;
}

interface Document {
  id: string;
  filename: string;
  size?: number;
  content?: string;
  created_at: string;
}

interface SearchResult {
  content: string;
  score?: number;
  document_id?: string;
  filename?: string;
}

export default function KnowledgePage() {
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [selectedKb, setSelectedKb] = useState<KnowledgeBase | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  // Create KB modal
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDesc, setCreateDesc] = useState('');

  // Add document
  const [showAddDoc, setShowAddDoc] = useState(false);
  const [docFilename, setDocFilename] = useState('');
  const [docContent, setDocContent] = useState('');

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);

  const loadKbs = async () => {
    try {
      const data = await api.getKnowledgeBases();
      setKbs(Array.isArray(data) ? data : []);
    } catch {}
  };

  const loadDocuments = async (kbId: string) => {
    try {
      const data = await api.getDocuments(kbId);
      setDocuments(Array.isArray(data) ? data : []);
    } catch {}
  };

  useEffect(() => { loadKbs(); }, []);

  useEffect(() => {
    if (selectedKb) {
      loadDocuments(selectedKb.id);
      setSearchResults([]);
      setSearchQuery('');
    }
  }, [selectedKb]);

  const handleCreateKb = async () => {
    if (!createName.trim()) return;
    setLoading(true);
    try {
      await api.createKnowledgeBase({ name: createName, description: createDesc });
      setShowCreate(false);
      setCreateName('');
      setCreateDesc('');
      await loadKbs();
    } catch {} finally { setLoading(false); }
  };

  const handleDeleteKb = async (kb: KnowledgeBase) => {
    if (!confirm('Xóa kho kiến thức "' + kb.name + '"? Hành động này không thể hoàn tác.')) return;
    try {
      await api.deleteKnowledgeBase(kb.id);
      if (selectedKb?.id === kb.id) {
        setSelectedKb(null);
        setDocuments([]);
      }
      await loadKbs();
    } catch {}
  };

  const handleAddDocument = async () => {
    if (!selectedKb || !docFilename.trim() || !docContent.trim()) return;
    setLoading(true);
    try {
      await api.createDocument(selectedKb.id, { filename: docFilename, content: docContent });
      setShowAddDoc(false);
      setDocFilename('');
      setDocContent('');
      await loadDocuments(selectedKb.id);
      await loadKbs();
    } catch {} finally { setLoading(false); }
  };

  const handleSearch = async () => {
    if (!selectedKb || !searchQuery.trim()) return;
    setSearching(true);
    try {
      const data = await api.searchKnowledgeBase(selectedKb.id, searchQuery);
      setSearchResults(Array.isArray(data) ? data : data?.results || []);
    } catch {
      setSearchResults([]);
    } finally { setSearching(false); }
  };

  const formatSize = (bytes?: number) => {
    if (!bytes) return '\u2014';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const formatDate = (d: string) => {
    try {
      return new Date(d).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch { return d; }
  };

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-white flex items-center gap-2">
          <Database size={20} /> Kho Ki\u1EBFn Th\u1EE9c
        </h1>
        <button
          onClick={() => setShowCreate(true)}
          className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm flex items-center gap-1"
        >
          <Plus size={14} /> T\u1EA1o kho m\u1EDBi
        </button>
      </div>

      {/* Create KB Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-6 w-full max-w-md space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-white font-medium text-lg">T\u1EA1o Kho Ki\u1EBFn Th\u1EE9c</h2>
              <button onClick={() => setShowCreate(false)} className="text-zinc-500 hover:text-white">
                <X size={18} />
              </button>
            </div>
            <input
              placeholder="T\u00EAn kho ki\u1EBFn th\u1EE9c"
              value={createName}
              onChange={e => setCreateName(e.target.value)}
              className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none"
              autoFocus
            />
            <textarea
              placeholder="M\u00F4 t\u1EA3 (t\u00F9y ch\u1ECDn)"
              value={createDesc}
              onChange={e => setCreateDesc(e.target.value)}
              rows={3}
              className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none resize-none"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowCreate(false)} className="px-4 py-2 rounded text-sm text-zinc-400 hover:text-white hover:bg-zinc-800">
                H\u1EE7y
              </button>
              <button
                onClick={handleCreateKb}
                disabled={loading || !createName.trim()}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded text-sm"
              >
                {loading ? '\u0110ang t\u1EA1o...' : 'T\u1EA1o'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col lg:flex-row gap-6">
        {/* Left: KB List */}
        <div className="w-full lg:w-80 flex-shrink-0 space-y-3">
          {kbs.map(kb => (
            <div
              key={kb.id}
              onClick={() => setSelectedKb(kb)}
              className={`bg-zinc-900 border rounded-lg p-4 cursor-pointer transition group ${
                selectedKb?.id === kb.id
                  ? 'border-blue-600 ring-1 ring-blue-600/30'
                  : 'border-zinc-800 hover:border-zinc-700'
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <Database size={16} className="text-blue-400 flex-shrink-0" />
                  <h3 className="text-white font-medium text-sm truncate">{kb.name}</h3>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); handleDeleteKb(kb); }}
                  className="p-1 text-zinc-600 hover:text-red-400 hover:bg-zinc-800 rounded opacity-0 group-hover:opacity-100 transition"
                  title="X\u00F3a"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {kb.description && (
                <p className="text-xs text-zinc-500 mt-1.5 line-clamp-2">{kb.description}</p>
              )}
              <div className="flex items-center gap-3 mt-2 text-xs text-zinc-500">
                <span className="flex items-center gap-1">
                  <FileText size={12} /> {kb.documents_count ?? 0} t\u00E0i li\u1EC7u
                </span>
                <span>{formatDate(kb.created_at)}</span>
              </div>
            </div>
          ))}

          {kbs.length === 0 && (
            <div className="text-center py-16 text-zinc-500">
              <BookOpen size={40} className="mx-auto mb-4 opacity-40" />
              <p className="text-sm">Ch\u01B0a c\u00F3 kho ki\u1EBFn th\u1EE9c n\u00E0o.</p>
              <p className="text-xs mt-1 text-zinc-600">T\u1EA1o kho ki\u1EBFn th\u1EE9c \u0111\u1EC3 l\u01B0u tr\u1EEF v\u00E0 t\u00ECm ki\u1EBFm t\u00E0i li\u1EC7u b\u1EB1ng AI.</p>
              <button
                onClick={() => setShowCreate(true)}
                className="mt-4 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded text-sm inline-flex items-center gap-1"
              >
                <Plus size={14} /> T\u1EA1o kho \u0111\u1EA7u ti\u00EAn
              </button>
            </div>
          )}
        </div>

        {/* Right: Selected KB detail */}
        <div className="flex-1 min-w-0">
          {selectedKb ? (
            <div className="space-y-4">
              {/* KB Header */}
              <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-white font-semibold text-lg">{selectedKb.name}</h2>
                    {selectedKb.description && (
                      <p className="text-sm text-zinc-400 mt-1">{selectedKb.description}</p>
                    )}
                  </div>
                  <button
                    onClick={() => setShowAddDoc(true)}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm flex items-center gap-1"
                  >
                    <Upload size={14} /> Th\u00EAm t\u00E0i li\u1EC7u
                  </button>
                </div>
              </div>

              {/* Search */}
              <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
                <h3 className="text-white text-sm font-medium mb-3 flex items-center gap-2">
                  <Search size={14} /> T\u00ECm ki\u1EBFm trong kho
                </h3>
                <div className="flex gap-2">
                  <input
                    placeholder="Nh\u1EADp c\u00E2u h\u1ECFi ho\u1EB7c t\u1EEB kh\u00F3a..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSearch()}
                    className="flex-1 bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none"
                  />
                  <button
                    onClick={handleSearch}
                    disabled={searching || !searchQuery.trim()}
                    className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded text-sm flex items-center gap-1"
                  >
                    {searching ? '\u0110ang t\u00ECm...' : 'T\u00ECm ki\u1EBFm'}
                  </button>
                </div>

                {/* Search Results */}
                {searchResults.length > 0 && (
                  <div className="mt-4 space-y-2">
                    <p className="text-xs text-zinc-500 mb-2">T\u00ECm th\u1EA5y {searchResults.length} k\u1EBFt qu\u1EA3</p>
                    {searchResults.map((result, i) => (
                      <div key={i} className="bg-zinc-800 border border-zinc-700 rounded-lg p-3">
                        <div className="flex items-center justify-between mb-2">
                          {result.filename && (
                            <span className="text-xs text-blue-400 flex items-center gap-1">
                              <FileText size={12} /> {result.filename}
                            </span>
                          )}
                          {result.score !== undefined && (
                            <span className="text-xs text-zinc-500">
                              \u0110\u1ED9 li\u00EAn quan: {(result.score * 100).toFixed(0)}%
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed">{result.content}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Add Document Form */}
              {showAddDoc && (
                <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-white text-sm font-medium">Th\u00EAm t\u00E0i li\u1EC7u m\u1EDBi</h3>
                    <button onClick={() => setShowAddDoc(false)} className="text-zinc-500 hover:text-white">
                      <X size={16} />
                    </button>
                  </div>
                  <input
                    placeholder="T\u00EAn t\u1EC7p (VD: huong-dan-san-pham.txt)"
                    value={docFilename}
                    onChange={e => setDocFilename(e.target.value)}
                    className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none"
                  />
                  <textarea
                    placeholder="D\u00E1n n\u1ED9i dung t\u00E0i li\u1EC7u v\u00E0o \u0111\u00E2y..."
                    value={docContent}
                    onChange={e => setDocContent(e.target.value)}
                    rows={8}
                    className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none resize-none font-mono"
                  />
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setShowAddDoc(false)} className="px-4 py-2 rounded text-sm text-zinc-400 hover:text-white hover:bg-zinc-800">
                      H\u1EE7y
                    </button>
                    <button
                      onClick={handleAddDocument}
                      disabled={loading || !docFilename.trim() || !docContent.trim()}
                      className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white px-4 py-2 rounded text-sm"
                    >
                      {loading ? '\u0110ang l\u01B0u...' : 'L\u01B0u t\u00E0i li\u1EC7u'}
                    </button>
                  </div>
                </div>
              )}

              {/* Document List */}
              <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
                <h3 className="text-white text-sm font-medium mb-3 flex items-center gap-2">
                  <FileText size={14} /> T\u00E0i li\u1EC7u ({documents.length})
                </h3>
                {documents.length > 0 ? (
                  <div className="space-y-2">
                    {documents.map(doc => (
                      <div key={doc.id} className="flex items-center justify-between bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 hover:border-zinc-600 transition">
                        <div className="flex items-center gap-3 min-w-0">
                          <FileText size={16} className="text-zinc-400 flex-shrink-0" />
                          <div className="min-w-0">
                            <p className="text-sm text-white truncate">{doc.filename}</p>
                            <div className="flex items-center gap-3 text-xs text-zinc-500">
                              <span>{formatSize(doc.size)}</span>
                              <span>{formatDate(doc.created_at)}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-8 text-zinc-500">
                    <FileText size={24} className="mx-auto mb-2 opacity-40" />
                    <p className="text-sm">Ch\u01B0a c\u00F3 t\u00E0i li\u1EC7u n\u00E0o trong kho n\u00E0y.</p>
                    <p className="text-xs mt-1 text-zinc-600">Th\u00EAm t\u00E0i li\u1EC7u \u0111\u1EC3 AI c\u00F3 th\u1EC3 t\u00ECm ki\u1EBFm v\u00E0 tr\u1EA3 l\u1EDDi c\u00E2u h\u1ECFi.</p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-64 text-zinc-500">
              <div className="text-center">
                <ChevronRight size={32} className="mx-auto mb-3 opacity-40" />
                <p className="text-sm">Ch\u1ECDn m\u1ED9t kho ki\u1EBFn th\u1EE9c \u0111\u1EC3 xem chi ti\u1EBFt</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
