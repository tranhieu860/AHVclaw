'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Activity, Target, Zap, Brain, TrendingUp, Plus, Check, X,
  RefreshCw, ChevronRight, BarChart2
} from 'lucide-react';
import { api } from '@/lib/api';

interface AutonomousStatus {
  enabled: boolean;
  last_run_at: string | null;
  runs_today: number;
  current_mood: string | null;
  recent_actions?: AutonomousAction[];
  config: {
    interval_minutes: number;
    quiet_hours_start: string;
    quiet_hours_end: string;
    max_actions_per_hour: number;
  };
}

interface Goal {
  id: string;
  title: string;
  description: string | null;
  progress: number;
  status: string;
  created_at: string;
}

interface AutonomousAction {
  id: string;
  action_type: string;
  description: string;
  status: string;
  created_at: string;
}

interface Pattern {
  id: string;
  pattern_type: string;
  description: string;
  confidence: number;
  status: string;
}

interface Reflection {
  date: string;
  mood: string;
  summary: string;
  emotion_breakdown: Record<string, number>;
}


interface CognitiveStats {
  total_embeddings: number;
  embeddings_by_type: Record<string, number>;
  total_cross_refs: number;
  last_consolidation: string | null;
}

const cardCls = 'bg-zinc-900 border border-zinc-800 rounded-xl p-4';

function timeAgo(iso: string | null): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function statusColor(s: string): string {
  if (s === 'completed' || s === 'done') return 'bg-green-900/40 text-green-400';
  if (s === 'failed' || s === 'rejected') return 'bg-red-900/40 text-red-400';
  if (s === 'active' || s === 'running') return 'bg-blue-900/40 text-blue-400';
  return 'bg-zinc-800 text-zinc-400';
}

export default function DashboardPage() {
  const [status, setStatus] = useState<AutonomousStatus | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [actions, setActions] = useState<AutonomousAction[]>([]);
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [reflection, setReflection] = useState<Reflection | null>(null);
  const [loading, setLoading] = useState(true);
  const [cogStats, setCogStats] = useState<CognitiveStats | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [showGoalForm, setShowGoalForm] = useState(false);
  const [goalTitle, setGoalTitle] = useState('');
  const [goalDesc, setGoalDesc] = useState('');
  const [savingGoal, setSavingGoal] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [statusData, goalsData, patternsData] = await Promise.allSettled([
        api.getAutonomousStatus(),
        api.getGoals(),
        api.getPatterns(),
      ]);
      if (statusData.status === 'fulfilled') {
        const s = statusData.value;
        setStatus(s);
        if (s?.recent_actions) setActions(s.recent_actions);
      }
      if (goalsData.status === 'fulfilled') {
        const d = goalsData.value;
        setGoals(Array.isArray(d) ? d : d?.goals ?? []);
      }
      if (patternsData.status === 'fulfilled') {
        const d = patternsData.value;
        setPatterns(Array.isArray(d) ? d : d?.patterns ?? []);
      }
      try {
        const cogData = await api.cognitiveStats().catch(() => null);
        if (cogData) setCogStats(cogData);
      } catch {}
      try {
        const today = new Date().toISOString().slice(0, 10);
        const ref = await api.getReflection(today);
        setReflection(ref);
      } catch {}
    } catch (e) {
      console.error('Dashboard load error', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleToggle = async () => {
    if (!status || toggling) return;
    setToggling(true);
    try {
      if (status.enabled) {
        await api.stopAutonomous();
      } else {
        await api.resumeAutonomous();
      }
      await loadData();
    } catch (e) {
      console.error('Toggle error', e);
    } finally {
      setToggling(false);
    }
  };

  const handleCreateGoal = async () => {
    if (!goalTitle.trim()) return;
    setSavingGoal(true);
    try {
      await api.createGoal({ title: goalTitle.trim(), description: goalDesc.trim() || null });
      setGoalTitle('');
      setGoalDesc('');
      setShowGoalForm(false);
      const data = await api.getGoals();
      setGoals(Array.isArray(data) ? data : data?.goals ?? []);
    } catch (e) {
      console.error('Create goal error', e);
    } finally {
      setSavingGoal(false);
    }
  };

  const handlePatternAction = async (id: string, action: 'accept' | 'reject') => {
    try {
      if (action === 'accept') await api.acceptPattern(id);
      else await api.rejectPattern(id);
      setPatterns(prev => prev.filter(p => p.id !== id));
    } catch (e) {
      console.error('Pattern action error', e);
    }
  };


  const handleBackfill = async () => {
    setBackfilling(true);
    try {
      await api.cognitiveBackfill();
      const cogData = await api.cognitiveStats().catch(() => null);
      if (cogData) setCogStats(cogData);
    } catch (e) {
      console.error("Backfill error", e);
    } finally {
      setBackfilling(false);
    }
  };

  const inputCls = 'w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none';

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <RefreshCw size={20} className="text-zinc-500 animate-spin" />
      </div>
    );
  }

  const pendingPatterns = patterns.filter(p => p.status === 'pending' || !p.status);

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-white flex items-center gap-2">
          <Brain size={20} className="text-purple-400" />
          Autonomous Dashboard
        </h1>
        <button onClick={loadData} className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-white transition" title="Refresh">
          <RefreshCw size={15} />
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Heartbeat Status */}
        <div className={cardCls}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-white flex items-center gap-2">
              <Activity size={15} className="text-green-400" /> Heartbeat
            </h2>
            <button
              onClick={handleToggle}
              disabled={toggling}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${
                status?.enabled ? 'bg-green-600' : 'bg-zinc-700'
              } ${toggling ? 'opacity-50' : ''}`}
            >
              <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition ${
                status?.enabled ? 'translate-x-6' : 'translate-x-1'
              }`} />
            </button>
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-500">Status</span>
              <span className={status?.enabled ? 'text-green-400' : 'text-zinc-500'}>
                {status?.enabled ? 'Running' : 'Paused'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Last run</span>
              <span className="text-zinc-300">{timeAgo(status?.last_run_at ?? null)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Runs today</span>
              <span className="text-zinc-300">{status?.runs_today ?? 0}</span>
            </div>
            {status?.current_mood && (
              <div className="flex justify-between">
                <span className="text-zinc-500">Current mood</span>
                <span className="text-purple-300 capitalize">{status.current_mood}</span>
              </div>
            )}
            {status?.config && (
              <div className="flex justify-between">
                <span className="text-zinc-500">Interval</span>
                <span className="text-zinc-300">{status.config.interval_minutes}m</span>
              </div>
            )}
          </div>
        </div>

        {/* Goals */}
        <div className={cardCls}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-white flex items-center gap-2">
              <Target size={15} className="text-blue-400" /> Goals
            </h2>
            <button
              onClick={() => setShowGoalForm(!showGoalForm)}
              className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-white transition"
            >
              <Plus size={14} />
            </button>
          </div>
          {showGoalForm && (
            <div className="mb-3 space-y-2 bg-zinc-800/50 rounded-lg p-3">
              <input
                value={goalTitle}
                onChange={e => setGoalTitle(e.target.value)}
                placeholder="Goal title"
                className={inputCls}
              />
              <input
                value={goalDesc}
                onChange={e => setGoalDesc(e.target.value)}
                placeholder="Description (optional)"
                className={inputCls}
              />
              <div className="flex gap-2">
                <button
                  onClick={handleCreateGoal}
                  disabled={savingGoal || !goalTitle.trim()}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs rounded px-3 py-1.5"
                >
                  {savingGoal ? 'Saving...' : 'Create'}
                </button>
                <button
                  onClick={() => setShowGoalForm(false)}
                  className="px-3 py-1.5 text-xs rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          <div className="space-y-2 max-h-52 overflow-y-auto">
            {goals.length === 0 ? (
              <p className="text-zinc-600 text-xs text-center py-4">No goals yet. Create one!</p>
            ) : (
              goals.slice(0, 6).map(g => (
                <div key={g.id} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-zinc-300 truncate flex-1 mr-2">{g.title}</span>
                    <span className={`inline-block text-xs px-2 py-0.5 rounded-full ${statusColor(g.status)}`}>{g.status}</span>
                  </div>
                  <div className="w-full bg-zinc-800 rounded-full h-1.5">
                    <div
                      className="bg-blue-500 h-1.5 rounded-full transition-all"
                      style={{ width: `${Math.min(g.progress ?? 0, 100)}%` }}
                    />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Recent Actions */}
        <div className={cardCls}>
          <h2 className="text-sm font-medium text-white flex items-center gap-2 mb-3">
            <Zap size={15} className="text-yellow-400" /> Recent Actions
          </h2>
          <div className="space-y-2 max-h-52 overflow-y-auto">
            {actions.length === 0 ? (
              <p className="text-zinc-600 text-xs text-center py-4">No actions recorded today.</p>
            ) : (
              actions.map((a, i) => (
                <div key={a.id ?? i} className="flex items-start gap-2">
                  <ChevronRight size={12} className="text-zinc-600 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-zinc-300 truncate">{a.description || a.action_type}</p>
                    <p className="text-[10px] text-zinc-600">{timeAgo(a.created_at)}</p>
                  </div>
                  <span className={`inline-block text-xs px-2 py-0.5 rounded-full ${statusColor(a.status)}`}>{a.status}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Detected Patterns */}
        <div className={cardCls}>
          <h2 className="text-sm font-medium text-white flex items-center gap-2 mb-3">
            <TrendingUp size={15} className="text-orange-400" /> Detected Patterns
          </h2>
          <div className="space-y-2 max-h-52 overflow-y-auto">
            {pendingPatterns.length === 0 ? (
              <p className="text-zinc-600 text-xs text-center py-4">No pending patterns.</p>
            ) : (
              pendingPatterns.map(p => (
                <div key={p.id} className="bg-zinc-800/50 rounded-lg p-2.5 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-zinc-300 flex-1 min-w-0 truncate">{p.description}</span>
                    <span className="text-[10px] text-zinc-500 shrink-0">{Math.round((p.confidence ?? 0) * 100)}%</span>
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => handlePatternAction(p.id, 'accept')}
                      className="flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-green-900/30 text-green-400 hover:bg-green-900/60 transition"
                    >
                      <Check size={10} /> Accept
                    </button>
                    <button
                      onClick={() => handlePatternAction(p.id, 'reject')}
                      className="flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-red-900/30 text-red-400 hover:bg-red-900/60 transition"
                    >
                      <X size={10} /> Reject
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Mood Chart */}
        <div className={`${cardCls} lg:col-span-2`}>
          <h2 className="text-sm font-medium text-white flex items-center gap-2 mb-3">
            <BarChart2 size={15} className="text-purple-400" /> Today&apos;s Mood
          </h2>
          {reflection ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <span className="text-zinc-500 text-sm">Overall mood:</span>
                <span className="text-purple-300 capitalize font-medium">{reflection.mood}</span>
              </div>
              {reflection.summary && (
                <p className="text-xs text-zinc-400 leading-relaxed">{reflection.summary}</p>
              )}
              {reflection.emotion_breakdown && Object.keys(reflection.emotion_breakdown).length > 0 && (
                <div className="space-y-1.5">
                  {Object.entries(reflection.emotion_breakdown).map(([emotion, value]) => (
                    <div key={emotion} className="flex items-center gap-3">
                      <span className="text-xs text-zinc-500 w-20 capitalize">{emotion}</span>
                      <div className="flex-1 bg-zinc-800 rounded-full h-2">
                        <div
                          className="bg-purple-500 h-2 rounded-full transition-all"
                          style={{ width: `${Math.min(Number(value) * 100, 100)}%` }}
                        />
                      </div>
                      <span className="text-xs text-zinc-500 w-8 text-right">{Math.round(Number(value) * 100)}%</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="text-zinc-600 text-xs text-center py-4">No reflection data for today.</p>
          )}
        </div>

        {/* Cognitive Memory / Knowledge Graph */}
        <div className={`${cardCls} lg:col-span-2`}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-white flex items-center gap-2">
              <Brain size={15} className="text-cyan-400" /> Bộ nhớ Nhận thức
            </h2>
            <button
              onClick={handleBackfill}
              disabled={backfilling}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-cyan-900/30 text-cyan-400 hover:bg-cyan-900/60 disabled:opacity-50 transition"
            >
              <RefreshCw size={11} className={backfilling ? "animate-spin" : ""} />
              {backfilling ? "Đang đồng bộ..." : "Đồng bộ hóa"}
            </button>
          </div>
          {cogStats ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-zinc-800/50 rounded-lg p-3">
                  <p className="text-xs text-zinc-500 mb-1">Embedding</p>
                  <p className="text-2xl font-semibold text-cyan-400">{(cogStats.total_embeddings ?? 0).toLocaleString()}</p>
                </div>
                <div className="bg-zinc-800/50 rounded-lg p-3">
                  <p className="text-xs text-zinc-500 mb-1">Tham chiếu chéo</p>
                  <p className="text-2xl font-semibold text-purple-400">{(cogStats.total_cross_refs ?? 0).toLocaleString()}</p>
                </div>
              </div>
              {cogStats.embeddings_by_type && Object.keys(cogStats.embeddings_by_type).length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs text-zinc-500">Phân loại</p>
                  <div className="flex flex-wrap gap-2">
                    {[
                      { key: "message", color: "bg-blue-900/40 text-blue-400" },
                      { key: "memory", color: "bg-green-900/40 text-green-400" },
                      { key: "reflection", color: "bg-purple-900/40 text-purple-400" },
                      { key: "pattern", color: "bg-orange-900/40 text-orange-400" },
                      { key: "goal", color: "bg-cyan-900/40 text-cyan-400" },
                    ].map(({ key, color }) =>
                      cogStats.embeddings_by_type[key] !== undefined ? (
                        <span key={key} className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full ${color}`}>
                          <span className="capitalize">{key}</span>
                          <span className="font-medium">{cogStats.embeddings_by_type[key]}</span>
                        </span>
                      ) : null
                    )}
                  </div>
                </div>
              )}
              {cogStats.last_consolidation && (
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-500">Lần đồng bộ cuối</span>
                  <span className="text-zinc-300">{timeAgo(cogStats.last_consolidation)}</span>
                </div>
              )}
            </div>
          ) : (
            <p className="text-zinc-600 text-xs text-center py-4">Chưa có dữ liệu nhận thức.</p>
          )}
        </div>


      </div>
    </div>
  );
}
