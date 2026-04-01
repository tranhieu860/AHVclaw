'use client';

import { useEffect, useState } from 'react';
import { Bot, Plus } from 'lucide-react';

interface Agent {
  id: string;
  name: string;
  model: string;
  system_prompt: string;
  memory_scope: string;
  is_public: boolean;
  created_at: string;
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [formName, setFormName] = useState('');
  const [formModel, setFormModel] = useState('AHV-Holding-TroLy');
  const [formPrompt, setFormPrompt] = useState('');

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

  useEffect(() => { loadAgents(); }, []);

  const addAgent = async () => {
    if (!formName || !formPrompt) return;
    try {
      await fetch(`${baseUrl}/api/agents`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          name: formName,
          model: formModel,
          system_prompt: formPrompt,
          memory_scope: 'shared',
        }),
      });
      setShowAdd(false);
      setFormName(''); setFormPrompt('');
      loadAgents();
    } catch {}
  };

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-white flex items-center gap-2">
          <Bot size={20} /> Agents
        </h1>
        <button onClick={() => setShowAdd(!showAdd)} className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm flex items-center gap-1">
          <Plus size={14} /> New Agent
        </button>
      </div>

      {showAdd && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-6 space-y-3">
          <input placeholder="Agent Name" value={formName} onChange={e => setFormName(e.target.value)}
            className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
          <input placeholder="Model (e.g. AHV-Holding-TroLy)" value={formModel} onChange={e => setFormModel(e.target.value)}
            className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
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
    </div>
  );
}
