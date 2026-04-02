'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { FolderOpen, Plus, Trash2, X, Upload, FileText, Pencil, MessageSquare } from 'lucide-react';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';

interface ProjectFile {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  created_at: string;
}

interface Project {
  id: string;
  name: string;
  icon: string | null;
  description: string | null;
  instructions: string | null;
  files?: ProjectFile[];
  created_at: string;
  updated_at: string;
}

export default function ProjectsPage() {
  const router = useRouter();
  const { setActiveConversationId, setMessages } = useStore();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [detailProject, setDetailProject] = useState<Project | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formIcon, setFormIcon] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formInstructions, setFormInstructions] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadProjects = useCallback(async () => {
    try {
      const data = await api.getProjects();
      setProjects(data || []);
    } catch (err) {
      console.error('Failed to load projects:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const resetForm = () => {
    setFormName('');
    setFormIcon('');
    setFormDescription('');
    setFormInstructions('');
    setEditingProject(null);
    setError('');
  };

  const openEdit = (project: Project) => {
    setEditingProject(project);
    setFormName(project.name);
    setFormIcon(project.icon || '');
    setFormDescription(project.description || '');
    setFormInstructions(project.instructions || '');
    setShowForm(true);
  };

  const openDetail = async (project: Project) => {
    try {
      const detail = await api.getProject(project.id);
      setDetailProject(detail);
    } catch {
      setDetailProject(project);
    }
  };

  const handleSubmit = async () => {
    if (!formName.trim()) {
      setError('Tên dự án là bắt buộc');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const payload: Record<string, unknown> = {
        name: formName,
        icon: formIcon || null,
        description: formDescription || null,
        instructions: formInstructions || null,
      };

      if (editingProject) {
        await api.updateProject(editingProject.id, payload);
      } else {
        await api.createProject(payload);
      }
      setShowForm(false);
      resetForm();
      loadProjects();
      if (detailProject && editingProject && detailProject.id === editingProject.id) {
        const updated = await api.getProject(editingProject.id);
        setDetailProject(updated);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Lỗi khi lưu');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Xóa dự án này?')) return;
    try {
      await api.deleteProject(id);
      if (detailProject?.id === id) setDetailProject(null);
      loadProjects();
    } catch (err) {
      console.error('Failed to delete project:', err);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!detailProject || !e.target.files?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(e.target.files)) {
        await api.uploadProjectFile(detailProject.id, file);
      }
      const updated = await api.getProject(detailProject.id);
      setDetailProject(updated);
    } catch (err) {
      console.error('Upload failed:', err);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDeleteFile = async (fileId: string) => {
    if (!detailProject) return;
    try {
      await api.deleteProjectFile(detailProject.id, fileId);
      const updated = await api.getProject(detailProject.id);
      setDetailProject(updated);
    } catch (err) {
      console.error('Failed to delete file:', err);
    }
  };

  const handleNewChat = () => {
    if (!detailProject) return;
    setActiveConversationId(null);
    setMessages([]);
    router.push(`/chat?project=${detailProject.id}`);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Project List */}
      <div className={`${detailProject ? 'w-80 border-r border-zinc-800' : 'flex-1'} flex flex-col overflow-hidden`}>
        <div className="p-4 md:p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <FolderOpen size={24} className="text-blue-400" />
              <h1 className="text-xl md:text-2xl font-bold text-white">Dự án</h1>
              <span className="text-sm text-zinc-500">({projects.length})</span>
            </div>
            <button
              onClick={() => { resetForm(); setShowForm(true); }}
              className="flex items-center gap-2 px-3 md:px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition"
            >
              <Plus size={16} /> <span className="hidden md:inline">Dự án mới</span>
            </button>
          </div>

          {projects.length === 0 ? (
            <div className="text-center py-16">
              <FolderOpen size={48} className="mx-auto text-zinc-600 mb-4" />
              <p className="text-zinc-400">Chưa có dự án nào</p>
              <p className="text-zinc-500 text-sm mt-1">Tạo dự án để tổ chức context và file cho AI</p>
            </div>
          ) : (
            <div className={detailProject ? 'space-y-2' : 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4'}>
              {projects.map(project => (
                <div
                  key={project.id}
                  onClick={() => openDetail(project)}
                  className={`bg-zinc-900 border rounded-xl p-4 cursor-pointer transition ${
                    detailProject?.id === project.id
                      ? 'border-blue-500 bg-blue-950/20'
                      : 'border-zinc-800 hover:border-zinc-700'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-lg">{project.icon || '📁'}</span>
                      <h3 className="text-white font-medium truncate">{project.name}</h3>
                    </div>
                    {!detailProject && (
                      <div className="flex items-center gap-1 shrink-0 ml-2">
                        <button
                          onClick={(e) => { e.stopPropagation(); openEdit(project); }}
                          className="p-1.5 rounded hover:bg-zinc-700 text-zinc-400 hover:text-blue-400 transition"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete(project.id); }}
                          className="p-1.5 rounded hover:bg-zinc-700 text-zinc-400 hover:text-red-400 transition"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    )}
                  </div>
                  {project.description && (
                    <p className="text-sm text-zinc-400 mt-2 line-clamp-2">{project.description}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Detail Panel */}
      {detailProject && (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
            <div className="flex items-center gap-3">
              <span className="text-2xl">{detailProject.icon || '📁'}</span>
              <div>
                <h2 className="text-lg font-semibold text-white">{detailProject.name}</h2>
                {detailProject.description && (
                  <p className="text-sm text-zinc-400">{detailProject.description}</p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleNewChat}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 text-white text-sm transition"
              >
                <MessageSquare size={14} /> Chat
              </button>
              <button
                onClick={() => openEdit(detailProject)}
                className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-blue-400 transition"
              >
                <Pencil size={16} />
              </button>
              <button
                onClick={() => handleDelete(detailProject.id)}
                className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-red-400 transition"
              >
                <Trash2 size={16} />
              </button>
              <button
                onClick={() => setDetailProject(null)}
                className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white transition"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {/* Instructions */}
            <div>
              <h3 className="text-sm font-medium text-zinc-300 mb-2">Hướng dẫn (Instructions)</h3>
              {detailProject.instructions ? (
                <pre className="text-sm text-zinc-400 bg-zinc-900 border border-zinc-800 rounded-lg p-4 whitespace-pre-wrap font-mono">
                  {detailProject.instructions}
                </pre>
              ) : (
                <p className="text-sm text-zinc-500 italic">Chưa có hướng dẫn. Nhấn chỉnh sửa để thêm.</p>
              )}
            </div>

            {/* Files */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-zinc-300">Tệp đính kèm</h3>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm transition disabled:opacity-50"
                >
                  <Upload size={14} />
                  {uploading ? 'Đang tải...' : 'Tải lên'}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleFileUpload}
                />
              </div>

              {detailProject.files && detailProject.files.length > 0 ? (
                <div className="space-y-2">
                  {detailProject.files.map(file => (
                    <div key={file.id} className="flex items-center justify-between bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-2.5">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <FileText size={16} className="text-zinc-400 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm text-white truncate">{file.filename}</p>
                          <p className="text-xs text-zinc-500">{formatSize(file.size)}</p>
                        </div>
                      </div>
                      <button
                        onClick={() => handleDeleteFile(file.id)}
                        className="p-1.5 rounded hover:bg-zinc-700 text-zinc-400 hover:text-red-400 transition shrink-0"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 bg-zinc-900 border border-zinc-800 border-dashed rounded-lg">
                  <FileText size={24} className="mx-auto text-zinc-600 mb-2" />
                  <p className="text-sm text-zinc-500">Chưa có tệp nào</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Create/Edit Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-white">
                {editingProject ? 'Sửa dự án' : 'Dự án mới'}
              </h2>
              <button onClick={() => { setShowForm(false); resetForm(); }} className="text-zinc-400 hover:text-white">
                <X size={20} />
              </button>
            </div>

            {error && <div className="mb-4 p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-400 text-sm">{error}</div>}

            <div className="space-y-4">
              <div className="flex gap-3">
                <div className="w-20">
                  <label className="block text-sm text-zinc-400 mb-1">Icon</label>
                  <input
                    value={formIcon}
                    onChange={e => setFormIcon(e.target.value)}
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-center text-lg focus:border-blue-500 focus:outline-none"
                    placeholder="📁"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-sm text-zinc-400 mb-1">Tên dự án</label>
                  <input
                    value={formName}
                    onChange={e => setFormName(e.target.value)}
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
                    placeholder="Tên dự án"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">Mô tả</label>
                <input
                  value={formDescription}
                  onChange={e => setFormDescription(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
                  placeholder="Mô tả ngắn về dự án"
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">Hướng dẫn (Instructions)</label>
                <textarea
                  value={formInstructions}
                  onChange={e => setFormInstructions(e.target.value)}
                  rows={6}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none resize-none font-mono"
                  placeholder="Hướng dẫn cho AI khi làm việc trong dự án này..."
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => { setShowForm(false); resetForm(); }}
                className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition"
              >
                Hủy
              </button>
              <button
                onClick={handleSubmit}
                disabled={saving}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition disabled:opacity-50"
              >
                {saving ? 'Đang lưu...' : editingProject ? 'Cập nhật' : 'Tạo mới'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
