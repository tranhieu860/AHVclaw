'use client';

import { useEffect, useState } from 'react';
import { Bot, Plus, Brain, Search, Pencil, Trash2, X, Tag } from 'lucide-react';
import { ModelSearch } from '@/components/ModelSearch';
import { ModelFallback } from '@/components/ModelFallback';

interface Agent {
  id: string;
  name: string;
  model: string;
  fallback_models: string;
  system_prompt: string;
  memory_scope: string;
  is_public: boolean;
  created_at: string;
}

interface Memory {
  id: string;
  type: string;
  key: string;
  content: string;
  created_at: string;
  updated_at: string;
}

const MEMORY_TYPES = ['profile', 'preference', 'knowledge', 'correction'];

const typeBadgeColors: Record<string, string> = {
  profile: 'bg-blue-600/20 text-blue-400 border-blue-600/30',
  preference: 'bg-purple-600/20 text-purple-400 border-purple-600/30',
  knowledge: 'bg-green-600/20 text-green-400 border-green-600/30',
  correction: 'bg-orange-600/20 text-orange-400 border-orange-600/30',
};

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [formName, setFormName] = useState('');
  const [formModel, setFormModel] = useState('AHV-Holding-TroLy');
  const [formFallback, setFormFallback] = useState('');
  const [formPrompt, setFormPrompt] = useState('');

  // Memory state
  const [activeTab, setActiveTab] = useState<'agents' | 'memories'>('agents');
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memorySearch, setMemorySearch] = useState('');
  const [showAddMemory, setShowAddMemory] = useState(false);
  const [memFormType, setMemFormType] = useState('knowledge');
  const [memFormKey, setMemFormKey] = useState('');
  const [memFormContent, setMemFormContent] = useState('');
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null);
  const [editContent, setEditContent] = useState('');

  const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3101';
  const headers = () => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${localStorage.getItem('access_token')}`,
  });

  const loadAgents = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/agents`, { headers: headers() });
      if (res.ok) setAgents(await res.json());
    } catch {}
  };

  const loadMemories = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/memories`, { headers: headers() });
      if (res.ok) {
        const data = await res.json();
        setMemories(Array.isArray(data) ? data : []);
      }
    } catch {}
  };

  const searchMemories = async () => {
    if (!memorySearch.trim()) {
      loadMemories();
      return;
    }
    try {
      const res = await fetch(`${baseUrl}/api/memories/search`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ query: memorySearch }),
      });
      if (res.ok) {
        const data = await res.json();
        setMemories(Array.isArray(data) ? data : []);
      }
    } catch {}
  };

  useEffect(() => { loadAgents(); loadMemories(); }, []);

  const addAgent = async () => {
    if (!formName || !formPrompt) return;
    try {
      await fetch(`${baseUrl}/api/agents`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          name: formName,
          model: formModel,
          fallback_models: formFallback || '',
          system_prompt: formPrompt,
          memory_scope: 'shared',
        }),
      });
      setShowAdd(false);
      setFormName(''); setFormPrompt('');
      loadAgents();
    } catch {}
  };

  const addMemory = async () => {
    if (!memFormKey || !memFormContent) return;
    try {
      await fetch(`${baseUrl}/api/memories`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          type: memFormType,
          key: memFormKey,
          content: memFormContent,
        }),
      });
      setShowAddMemory(false);
      setMemFormKey(''); setMemFormContent(''); setMemFormType('knowledge');
      loadMemories();
    } catch {}
  };

  const updateMemory = async (id: string, content: string) => {
    try {
      await fetch(`${baseUrl}/api/memories/${id}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ content }),
      });
      setEditingMemory(null);
      setEditContent('');
      loadMemories();
    } catch {}
  };

  const deleteMemory = async (id: string) => {
    if (!confirm('Delete this memory?')) return;
    try {
      await fetch(`${baseUrl}/api/memories/${id}`, {
        method: 'DELETE',
        headers: headers(),
      });
      loadMemories();
    } catch {}
  };

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-white flex items-center gap-2">
          <Bot size={20} /> Agents & Memories
        </h1>
        <div className="flex items-center gap-2">
          <div className="flex bg-zinc-800 rounded-lg p-0.5">
            <button
              onClick={() => setActiveTab('agents')}
              className={`px-3 py-1.5 rounded text-sm transition ${activeTab === 'agents' ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-white'}`}
            >
              <Bot size={14} className="inline mr-1" /> Agents
            </button>
            <button
              onClick={() => setActiveTab('memories')}
              className={`px-3 py-1.5 rounded text-sm transition ${activeTab === 'memories' ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-white'}`}
            >
              <Brain size={14} className="inline mr-1" /> Memories
            </button>
          </div>
          {activeTab === 'agents' && (
            <button onClick={() => setShowAdd(!showAdd)} className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm flex items-center gap-1">
              <Plus size={14} /> New Agent
            </button>
          )}
          {activeTab === 'memories' && (
            <button onClick={() => setShowAddMemory(!showAddMemory)} className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm flex items-center gap-1">
              <Plus size={14} /> Add Memory
            </button>
          )}
        </div>
      </div>

      {/* AGENTS TAB */}
      {activeTab === 'agents' && (
        <>
          {showAdd && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-6 space-y-3">
              <input placeholder="Agent Name" value={formName} onChange={e => setFormName(e.target.value)}
                className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
              <ModelSearch value={formModel} onChange={setFormModel} label="Model" placeholder="e.g. AHV-Holding-TroLy" />
              <ModelFallback value={formFallback} onChange={setFormFallback} />
              <textarea placeholder="System prompt — define this agent's personality and capabilities..." value={formPrompt} onChange={e => setFormPrompt(e.target.value)}
                rows={6} className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none resize-none" />
              <button onClick={addAgent} className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded text-sm">Create Agent</button>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {agents.map(agent => (
              <div key={agent.id} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 hover:border-zinc-700 transition">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-purple-600/20 flex items-center justify-center">
                    <Bot size={20} className="text-purple-400" />
                  </div>
                  <div>
                    <h3 className="text-white font-medium">{agent.name}</h3>
                    <p className="text-xs text-zinc-500">{agent.model}</p>
                  </div>
                </div>
                <p className="text-sm text-zinc-400 mt-3 line-clamp-3">{agent.system_prompt}</p>
                <div className="flex items-center gap-3 mt-3 text-xs text-zinc-500">
                  <span>Memory: {agent.memory_scope}</span>
                  <span>{agent.is_public ? 'Public' : 'Private'}</span>
                </div>
              </div>
            ))}
            {agents.length === 0 && !showAdd && (
              <div className="col-span-full text-center py-12 text-zinc-500">
                <Bot size={32} className="mx-auto mb-3 opacity-50" />
                <p>No agents yet. Create a custom AI agent to get started.</p>
              </div>
            )}
          </div>
        </>
      )}

      {/* MEMORIES TAB */}
      {activeTab === 'memories' && (
        <>
          {/* Search bar */}
          <div className="flex gap-2 mb-4">
            <div className="flex-1 relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                placeholder="Search memories..."
                value={memorySearch}
                onChange={e => setMemorySearch(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && searchMemories()}
                className="w-full bg-zinc-800 text-white rounded px-3 py-2 pl-8 text-sm border border-zinc-700 focus:border-blue-500 outline-none"
              />
            </div>
            <button onClick={searchMemories} className="bg-zinc-700 hover:bg-zinc-600 text-white px-3 py-2 rounded text-sm">
              Search
            </button>
          </div>

          {/* Add Memory Form */}
          {showAddMemory && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-white text-sm font-medium">Add Memory</h3>
                <button onClick={() => setShowAddMemory(false)} className="text-zinc-500 hover:text-white">
                  <X size={16} />
                </button>
              </div>
              <select
                value={memFormType}
                onChange={e => setMemFormType(e.target.value)}
                className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none"
              >
                {MEMORY_TYPES.map(t => (
                  <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                ))}
              </select>
              <input
                placeholder="Key (e.g. user_name, preferred_language)"
                value={memFormKey}
                onChange={e => setMemFormKey(e.target.value)}
                className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none"
              />
              <textarea
                placeholder="Content..."
                value={memFormContent}
                onChange={e => setMemFormContent(e.target.value)}
                rows={3}
                className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none resize-none"
              />
              <button onClick={addMemory} className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded text-sm">
                Save Memory
              </button>
            </div>
          )}

          {/* Memory List */}
          <div className="space-y-2">
            {memories.map(mem => (
              <div key={mem.id} className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 hover:border-zinc-700 transition">
                {editingMemory?.id === mem.id ? (
                  <div className="space-y-2">
                    <textarea
                      value={editContent}
                      onChange={e => setEditContent(e.target.value)}
                      rows={3}
                      className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none resize-none"
                    />
                    <div className="flex gap-2">
                      <button onClick={() => updateMemory(mem.id, editContent)} className="bg-green-600 hover:bg-green-700 text-white px-3 py-1 rounded text-xs">Save</button>
                      <button onClick={() => setEditingMemory(null)} className="bg-zinc-700 hover:bg-zinc-600 text-white px-3 py-1 rounded text-xs">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs border ${typeBadgeColors[mem.type] || 'bg-zinc-700 text-zinc-300 border-zinc-600'}`}>
                          <Tag size={10} />
                          {mem.type}
                        </span>
                        <span className="text-zinc-300 text-sm font-medium">{mem.key}</span>
                      </div>
                      <p className="text-sm text-zinc-400 break-words">{mem.content}</p>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => { setEditingMemory(mem); setEditContent(mem.content); }}
                        className="p-1.5 text-zinc-500 hover:text-blue-400 hover:bg-zinc-800 rounded transition"
                        title="Edit"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => deleteMemory(mem.id)}
                        className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-zinc-800 rounded transition"
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {memories.length === 0 && (
              <div className="text-center py-12 text-zinc-500">
                <Brain size={32} className="mx-auto mb-3 opacity-50" />
                <p>No memories yet. The AI will learn and remember information as you chat.</p>
                <p className="text-xs mt-1">You can also add memories manually using the button above.</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
