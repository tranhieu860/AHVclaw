'use client';

import { useEffect, useState, useCallback } from 'react';
import { Clock, Plus, Play, Pause, Trash2, X, ChevronDown, ChevronUp, RefreshCw, Pencil } from 'lucide-react';
import { api } from '@/lib/api';

interface Task {
  id: string;
  name: string;
  description: string | null;
  prompt: string;
  schedule: string;
  schedule_human: string | null;
  timezone: string;
  delivery_channel: string;
  delivery_chat_id: string | null;
  bot_id: string | null;
  agent_id: string | null;
  is_active: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  run_count: number;
  error_count: number;
  created_at: string;
  last_run_status: string | null;
  last_run_result: string | null;
}

interface TaskRun {
  id: string;
  task_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  result: string | null;
  error: string | null;
  tokens_in: number;
  tokens_out: number;
}

interface Agent {
  id: string;
  name: string;
}

interface Bot {
  id: string;
  name: string;
  channel: string;
}

const SCHEDULE_PRESETS = [
  { label: 'Mỗi giờ', value: '0 * * * *' },
  { label: 'Hàng ngày 9h sáng', value: '0 9 * * *' },
  { label: 'Hàng ngày 18h', value: '0 18 * * *' },
  { label: 'Hàng tuần thứ Hai', value: '0 9 * * 1' },
  { label: 'Mỗi 30 phút', value: '*/30 * * * *' },
  { label: 'Tùy chỉnh', value: 'custom' },
];

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [taskRuns, setTaskRuns] = useState<Record<string, TaskRun[]>>({});
  const [agents, setAgents] = useState<Agent[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);

  // Form state
  const [formName, setFormName] = useState('');
  const [formPrompt, setFormPrompt] = useState('');
  const [formSchedule, setFormSchedule] = useState('0 9 * * *');
  const [formCustomCron, setFormCustomCron] = useState('');
  const [formChannel, setFormChannel] = useState('web');
  const [formAgentId, setFormAgentId] = useState('');
  const [formBotId, setFormBotId] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadTasks = useCallback(async () => {
    try {
      const data = await api.fetch('/api/tasks').then(r => r.json());
      setTasks(data);
    } catch (err) {
      console.error('Failed to load tasks:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAgentsAndBots = useCallback(async () => {
    try {
      const [agentsData, botsData] = await Promise.all([
        api.fetch('/api/agents').then(r => r.json()),
        api.fetch('/api/bots').then(r => r.json()).catch(() => []),
      ]);
      setAgents(agentsData || []);
      setBots(botsData || []);
    } catch (err) {
      console.error('Failed to load agents/bots:', err);
    }
  }, []);

  useEffect(() => {
    loadTasks();
    loadAgentsAndBots();
    const interval = setInterval(loadTasks, 30000);
    return () => clearInterval(interval);
  }, [loadTasks, loadAgentsAndBots]);

  const loadRuns = async (taskId: string) => {
    try {
      const data = await api.fetch(`/api/tasks/${taskId}/runs?limit=10`).then(r => r.json());
      setTaskRuns(prev => ({ ...prev, [taskId]: data }));
    } catch (err) {
      console.error('Failed to load runs:', err);
    }
  };

  const toggleExpand = (taskId: string) => {
    if (expandedTask === taskId) {
      setExpandedTask(null);
    } else {
      setExpandedTask(taskId);
      loadRuns(taskId);
    }
  };

  const resetForm = () => {
    setFormName('');
    setFormPrompt('');
    setFormSchedule('0 9 * * *');
    setFormCustomCron('');
    setFormChannel('web');
    setFormAgentId('');
    setFormBotId('');
    setFormDescription('');
    setEditingTask(null);
    setError('');
  };

  const openEdit = (task: Task) => {
    setEditingTask(task);
    setFormName(task.name);
    setFormPrompt(task.prompt);
    setFormDescription(task.description || '');
    setFormChannel(task.delivery_channel);
    setFormAgentId(task.agent_id || '');
    setFormBotId(task.bot_id || '');
    const preset = SCHEDULE_PRESETS.find(p => p.value === task.schedule);
    if (preset) {
      setFormSchedule(task.schedule);
    } else {
      setFormSchedule('custom');
      setFormCustomCron(task.schedule);
    }
    setShowForm(true);
  };

  const handleSubmit = async () => {
    const schedule = formSchedule === 'custom' ? formCustomCron : formSchedule;
    if (!formName || !formPrompt || !schedule) {
      setError('Tên, prompt và lịch là bắt buộc');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const payload: Record<string, unknown> = {
        name: formName,
        prompt: formPrompt,
        schedule,
        delivery_channel: formChannel,
        description: formDescription || null,
      };
      if (formAgentId) payload.agent_id = formAgentId;
      if (formBotId) payload.bot_id = formBotId;

      if (editingTask) {
        await api.fetch(`/api/tasks/${editingTask.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await api.fetch('/api/tasks', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      setShowForm(false);
      resetForm();
      loadTasks();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save task');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Xóa tác vụ này?')) return;
    try {
      await api.fetch(`/api/tasks/${id}`, { method: 'DELETE' });
      loadTasks();
    } catch (err) {
      console.error('Failed to delete task:', err);
    }
  };

  const handlePauseResume = async (task: Task) => {
    const action = task.is_active ? 'pause' : 'resume';
    try {
      await api.fetch(`/api/tasks/${task.id}/${action}`, { method: 'POST' });
      loadTasks();
    } catch (err) {
      console.error(`Failed to ${action} task:`, err);
    }
  };

  const handleRunNow = async (id: string) => {
    try {
      await api.fetch(`/api/tasks/${id}/run`, { method: 'POST' });
      loadTasks();
    } catch (err) {
      console.error('Failed to run task:', err);
    }
  };

  const getStatusColor = (task: Task) => {
    if (task.last_run_status === 'running') return 'bg-yellow-500';
    if (!task.is_active) return 'bg-zinc-500';
    if (task.last_run_status === 'failed' || task.error_count > 0) return 'bg-red-500';
    return 'bg-green-500';
  };

  const getStatusLabel = (task: Task) => {
    if (task.last_run_status === 'running') return 'Đang chạy';
    if (!task.is_active) return 'Tạm dừng';
    if (task.last_run_status === 'failed') return 'Thất bại';
    return 'Hoạt động';
  };

  const formatTime = (iso: string | null) => {
    if (!iso) return '--';
    const d = new Date(iso);
    return d.toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Clock size={24} className="text-blue-400" />
          <h1 className="text-2xl font-bold text-white">Tác vụ định kỳ</h1>
          <span className="text-sm text-zinc-500">({tasks.length})</span>
        </div>
        <div className="flex gap-2">
          <button onClick={loadTasks} className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition">
            <RefreshCw size={16} />
          </button>
          <button
            onClick={() => { resetForm(); setShowForm(true); }}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition"
          >
            <Plus size={16} /> Tác vụ mới
          </button>
        </div>
      </div>

      {/* Task Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-white">
                {editingTask ? 'Sửa tác vụ' : 'Tác vụ mới'}
              </h2>
              <button onClick={() => { setShowForm(false); resetForm(); }} className="text-zinc-400 hover:text-white">
                <X size={20} />
              </button>
            </div>

            {error && <div className="mb-4 p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-400 text-sm">{error}</div>}

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-zinc-400 mb-1">Tên</label>
                <input
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
                  placeholder="Tên tác vụ"
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">Mô tả (tùy chọn)</label>
                <input
                  value={formDescription}
                  onChange={e => setFormDescription(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
                  placeholder="Mô tả ngắn"
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">Prompt</label>
                <textarea
                  value={formPrompt}
                  onChange={e => setFormPrompt(e.target.value)}
                  rows={4}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none resize-none"
                  placeholder="AI cần làm gì?"
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-2">Lịch chạy</label>
                <div className="flex flex-wrap gap-2 mb-2">
                  {SCHEDULE_PRESETS.map(p => (
                    <button
                      key={p.value}
                      onClick={() => setFormSchedule(p.value)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                        formSchedule === p.value
                          ? 'bg-blue-600 text-white'
                          : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                {formSchedule === 'custom' && (
                  <input
                    value={formCustomCron}
                    onChange={e => setFormCustomCron(e.target.value)}
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none font-mono"
                    placeholder="Cron: min hour dom month dow (e.g. */15 * * * *)"
                  />
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-zinc-400 mb-1">Kênh gửi</label>
                  <select
                    value={formChannel}
                    onChange={e => setFormChannel(e.target.value)}
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
                  >
                    <option value="web">Web</option>
                    <option value="telegram">Telegram</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-zinc-400 mb-1">Agent (tùy chọn)</label>
                  <select
                    value={formAgentId}
                    onChange={e => setFormAgentId(e.target.value)}
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
                  >
                    <option value="">Default</option>
                    {agents.map(a => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              {formChannel === 'telegram' && bots.length > 0 && (
                <div>
                  <label className="block text-sm text-zinc-400 mb-1">Bot Telegram</label>
                  <select
                    value={formBotId}
                    onChange={e => setFormBotId(e.target.value)}
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
                  >
                    <option value="">Chọn bot</option>
                    {bots.filter(b => b.channel === 'telegram').map(b => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => { setShowForm(false); resetForm(); }}
                className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={saving}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition disabled:opacity-50"
              >
                {saving ? 'Đang lưu...' : editingTask ? 'Cập nhật' : 'Tạo mới'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Task List */}
      {tasks.length === 0 ? (
        <div className="text-center py-16">
          <Clock size={48} className="mx-auto text-zinc-600 mb-4" />
          <p className="text-zinc-400">Chưa có tác vụ định kỳ</p>
          <p className="text-zinc-500 text-sm mt-1">Tạo một tác vụ để tự động hóa quy trình AI</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tasks.map(task => (
            <div key={task.id} className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
              <div className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${getStatusColor(task)}`} />
                    <div className="min-w-0">
                      <h3 className="text-white font-medium truncate">{task.name}</h3>
                      <div className="flex items-center gap-2 text-xs text-zinc-500 mt-0.5">
                        <span>{task.schedule_human || task.schedule}</span>
                        <span>|</span>
                        <span>{getStatusLabel(task)}</span>
                        {task.run_count > 0 && (
                          <>
                            <span>|</span>
                            <span>{task.run_count} runs</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 ml-3">
                    <button
                      onClick={() => handleRunNow(task.id)}
                      className="p-1.5 rounded hover:bg-zinc-700 text-zinc-400 hover:text-green-400 transition"
                      title="Run now"
                    >
                      <Play size={14} />
                    </button>
                    <button
                      onClick={() => handlePauseResume(task)}
                      className="p-1.5 rounded hover:bg-zinc-700 text-zinc-400 hover:text-yellow-400 transition"
                      title={task.is_active ? 'Pause' : 'Resume'}
                    >
                      <Pause size={14} />
                    </button>
                    <button
                      onClick={() => openEdit(task)}
                      className="p-1.5 rounded hover:bg-zinc-700 text-zinc-400 hover:text-blue-400 transition"
                      title="Edit"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => handleDelete(task.id)}
                      className="p-1.5 rounded hover:bg-zinc-700 text-zinc-400 hover:text-red-400 transition"
                      title="Delete"
                    >
                      <Trash2 size={14} />
                    </button>
                    <button
                      onClick={() => toggleExpand(task.id)}
                      className="p-1.5 rounded hover:bg-zinc-700 text-zinc-400 transition"
                    >
                      {expandedTask === task.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-4 text-xs text-zinc-500">
                  <span>Next: {formatTime(task.next_run_at)}</span>
                  <span>Last: {formatTime(task.last_run_at)}</span>
                  {task.last_run_result && (
                    <span className="text-zinc-400 truncate max-w-[200px]">
                      Result: {task.last_run_result.slice(0, 80)}...
                    </span>
                  )}
                </div>
              </div>

              {/* Expanded Runs */}
              {expandedTask === task.id && (
                <div className="border-t border-zinc-800 bg-zinc-950 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-medium text-zinc-300">Các lần chạy gần đây</h4>
                    <button onClick={() => loadRuns(task.id)} className="text-xs text-zinc-500 hover:text-zinc-300">
                      Làm mới
                    </button>
                  </div>
                  <div className="text-xs text-zinc-400 mb-2 bg-zinc-900 p-2 rounded font-mono">
                    Prompt: {task.prompt.slice(0, 200)}{task.prompt.length > 200 ? '...' : ''}
                  </div>
                  {taskRuns[task.id]?.length ? (
                    <div className="space-y-2">
                      {taskRuns[task.id].map(run => (
                        <div key={run.id} className="bg-zinc-900 rounded-lg p-3 text-xs">
                          <div className="flex items-center justify-between mb-1">
                            <span className={`font-medium ${
                              run.status === 'success' ? 'text-green-400' :
                              run.status === 'failed' ? 'text-red-400' :
                              'text-yellow-400'
                            }`}>
                              {run.status}
                            </span>
                            <span className="text-zinc-500">{formatTime(run.started_at)}</span>
                          </div>
                          {run.result && (
                            <p className="text-zinc-400 mt-1 whitespace-pre-wrap break-words">
                              {run.result.slice(0, 500)}{run.result.length > 500 ? '...' : ''}
                            </p>
                          )}
                          {run.error && (
                            <p className="text-red-400 mt-1">{run.error}</p>
                          )}
                          <div className="text-zinc-600 mt-1">
                            Tokens: {run.tokens_in}/{run.tokens_out}
                            {run.finished_at && ` | Duration: ${Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000)}s`}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-zinc-500 text-xs">Chưa có lần chạy nào</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
