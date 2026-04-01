'use client';

import { useEffect, useState } from 'react';
import { Radio, Plus, Play, Square, Trash2, Pencil, ChevronDown, ChevronUp, X, Check } from 'lucide-react';
import { ModelSearch } from '@/components/ModelSearch';
import { ModelFallback } from '@/components/ModelFallback';

interface Bot {
  id: string;
  name: string;
  channel: string;
  is_active: boolean;
  updated_at?: string;
  created_at: string;
  running?: boolean;
  ai_settings?: {
    model?: string;
    fallback_models?: string;
    allowed_tools?: string[];
    blocked_tools?: string[];
  };
  response_settings?: {
    max_length?: number;
    language?: string;
    welcome_message?: string;
    error_message?: string;
  };
  default_agent_id?: string;
}

const ALL_TOOLS = [
  { id: 'file_read', name: 'Read Files', group: 'Files' },
  { id: 'file_write', name: 'Write Files', group: 'Files' },
  { id: 'file_list', name: 'List Files', group: 'Files' },
  { id: 'file_delete', name: 'Delete Files', group: 'Files' },
  { id: 'file_search', name: 'Search Files', group: 'Files' },
  { id: 'terminal_exec', name: 'Run Commands', group: 'Terminal' },
  { id: 'browser_navigate', name: 'Browse Web', group: 'Browser' },
  { id: 'browser_screenshot', name: 'Take Screenshots', group: 'Browser' },
  { id: 'browser_click', name: 'Click Elements', group: 'Browser' },
  { id: 'browser_type', name: 'Type in Browser', group: 'Browser' },
  { id: 'browser_extract', name: 'Extract Page Data', group: 'Browser' },
  { id: 'http_request', name: 'HTTP Requests', group: 'Network' },
  { id: 'memory_save', name: 'Save Memories', group: 'Memory' },
  { id: 'memory_search', name: 'Search Memories', group: 'Memory' },
  { id: 'server_ssh_exec', name: 'Server Commands', group: 'Server' },
  { id: 'server_status', name: 'Server Status', group: 'Server' },
  { id: 'knowledge_search', name: 'Search Knowledge', group: 'Knowledge' },
  { id: 'delegate_agent', name: 'Delegate to Agent', group: 'Agents' },
];

const TOOL_GROUPS = [...new Set(ALL_TOOLS.map(t => t.group))];

function ToolPermissions({ selectedTools, onToggle, onSelectAll, onDeselectAll }: {
  selectedTools: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-zinc-700 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 bg-zinc-800 hover:bg-zinc-750 text-sm text-zinc-300"
      >
        <span>Tool Permissions ({selectedTools.size}/{ALL_TOOLS.length})</span>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {expanded && (
        <div className="p-3 space-y-3 bg-zinc-900/50">
          <div className="flex gap-2">
            <button type="button" onClick={onSelectAll}
              className="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300">
              Select All
            </button>
            <button type="button" onClick={onDeselectAll}
              className="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300">
              Deselect All
            </button>
          </div>
          {TOOL_GROUPS.map(group => (
            <div key={group}>
              <p className="text-xs font-medium text-zinc-500 mb-1.5 uppercase tracking-wider">{group}</p>
              <div className="grid grid-cols-2 gap-1">
                {ALL_TOOLS.filter(t => t.group === group).map(tool => (
                  <label key={tool.id} className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer hover:text-white py-0.5">
                    <input
                      type="checkbox"
                      checked={selectedTools.has(tool.id)}
                      onChange={() => onToggle(tool.id)}
                      className="rounded border-zinc-600 bg-zinc-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                    />
                    {tool.name}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function BotsPage() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [formName, setFormName] = useState('');
  const [formChannel, setFormChannel] = useState('telegram');
  const [formToken, setFormToken] = useState('');
  const [formAgentId, setFormAgentId] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set(ALL_TOOLS.map(t => t.id)));

  // Edit modal state
  const [editBot, setEditBot] = useState<Bot | null>(null);
  const [editName, setEditName] = useState('');
  const [editAgentId, setEditAgentId] = useState('');
  const [editTools, setEditTools] = useState<Set<string>>(new Set());
  const [editModel, setEditModel] = useState('');
  const [editFallback, setEditFallback] = useState('');
  const [editMaxLength, setEditMaxLength] = useState('');
  const [editLanguage, setEditLanguage] = useState('');
  const [editWelcome, setEditWelcome] = useState('');
  const [editError, setEditError] = useState('');
  const [saving, setSaving] = useState(false);

  const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3101';
  const headers = () => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${localStorage.getItem('access_token')}`,
  });

  const loadBots = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/bots`, { headers: headers() });
      if (res.ok) {
        const data = await res.json();
        const withStatus = await Promise.all((data || []).map(async (bot: Bot) => {
          try {
            const sr = await fetch(baseUrl + "/api/bots/" + bot.id + "/status", { headers: headers() });
            if (sr.ok) { const s = await sr.json(); return { ...bot, running: !!s.running }; }
          } catch {}
          return { ...bot, running: bot.is_active };
        }));
        setBots(withStatus);
      }
    } catch {}
  };

  useEffect(() => { loadBots(); }, []);

  const toggleTool = (id: string, set: Set<string>, setter: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    setter(next);
  };

  const addBot = async () => {
    if (!formName || !formToken) return;
    const allToolIds = ALL_TOOLS.map(t => t.id);
    const isAllSelected = selectedTools.size === allToolIds.length;
    try {
      await fetch(`${baseUrl}/api/bots`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          name: formName,
          channel: formChannel,
          channel_config: { bot_token: formToken },
          ai_settings: isAllSelected ? {} : { allowed_tools: Array.from(selectedTools) },
          default_agent_id: formAgentId || undefined,
        }),
      });
      setShowAdd(false);
      setFormName(''); setFormToken(''); setFormAgentId('');
      setSelectedTools(new Set(allToolIds));
      loadBots();
    } catch {}
  };

  const openEdit = (bot: Bot) => {
    setEditBot(bot);
    setEditName(bot.name);
    setEditAgentId(bot.default_agent_id || '');
    setEditModel(bot.ai_settings?.model || '');
    setEditFallback(bot.ai_settings?.fallback_models || '');
    setEditMaxLength(bot.response_settings?.max_length?.toString() || '');
    setEditLanguage(bot.response_settings?.language || '');
    setEditWelcome(bot.response_settings?.welcome_message || '');
    setEditError(bot.response_settings?.error_message || '');

    if (bot.ai_settings?.allowed_tools && bot.ai_settings.allowed_tools.length > 0) {
      setEditTools(new Set(bot.ai_settings.allowed_tools));
    } else {
      setEditTools(new Set(ALL_TOOLS.map(t => t.id)));
    }
  };

  const saveEdit = async () => {
    if (!editBot) return;
    setSaving(true);
    const allToolIds = ALL_TOOLS.map(t => t.id);
    const isAllSelected = editTools.size === allToolIds.length;
    try {
      await fetch(`${baseUrl}/api/bots/${editBot.id}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({
          name: editName || undefined,
          default_agent_id: editAgentId || undefined,
          ai_settings: {
            ...(editModel ? { model: editModel } : {}),
            ...(editFallback ? { fallback_models: editFallback } : {}),
            ...(isAllSelected ? {} : { allowed_tools: Array.from(editTools) }),
          },
          response_settings: {
            ...(editMaxLength ? { max_length: parseInt(editMaxLength) } : {}),
            ...(editLanguage ? { language: editLanguage } : {}),
            ...(editWelcome ? { welcome_message: editWelcome } : {}),
            ...(editError ? { error_message: editError } : {}),
          },
        }),
      });
      setEditBot(null);
      loadBots();
    } catch {}
    setSaving(false);
  };

  const startBot = async (id: string) => {
    try {
      await fetch(`${baseUrl}/api/bots/${id}/start`, { method: 'POST', headers: headers() });
      loadBots();
    } catch {}
  };

  const stopBot = async (id: string) => {
    try {
      await fetch(`${baseUrl}/api/bots/${id}/stop`, { method: 'POST', headers: headers() });
      loadBots();
    } catch {}
  };

  const deleteBot = async (id: string) => {
    try {
      await fetch(`${baseUrl}/api/bots/${id}`, { method: 'DELETE', headers: headers() });
      setDeleteId(null);
      loadBots();
    } catch {}
  };

  const timeAgo = (date?: string) => {
    if (!date) return 'Never';
    const diff = Date.now() - new Date(date).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-white flex items-center gap-2">
          <Radio size={20} /> Bots
        </h1>
        <button onClick={() => setShowAdd(!showAdd)} className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm flex items-center gap-1">
          <Plus size={14} /> New Bot
        </button>
      </div>

      {showAdd && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-6 space-y-3">
          <input placeholder="Bot Name" value={formName} onChange={e => setFormName(e.target.value)}
            className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
          <select value={formChannel} onChange={e => setFormChannel(e.target.value)}
            className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none">
            <option value="telegram">Telegram</option>
            <option value="zalo">Zalo</option>
            <option value="discord">Discord</option>
          </select>
          <input placeholder="Bot Token" value={formToken} onChange={e => setFormToken(e.target.value)}
            className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
          <input placeholder="Agent ID (optional)" value={formAgentId} onChange={e => setFormAgentId(e.target.value)}
            className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
          <ToolPermissions
            selectedTools={selectedTools}
            onToggle={(id) => toggleTool(id, selectedTools, setSelectedTools)}
            onSelectAll={() => setSelectedTools(new Set(ALL_TOOLS.map(t => t.id)))}
            onDeselectAll={() => setSelectedTools(new Set())}
          />
          <button onClick={addBot} className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded text-sm">Create Bot</button>
        </div>
      )}

      {deleteId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-6 max-w-sm w-full mx-4">
            <h3 className="text-white font-medium mb-2">Delete Bot?</h3>
            <p className="text-sm text-zinc-400 mb-4">This action cannot be undone. The bot will be stopped and removed.</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleteId(null)} className="px-3 py-1.5 rounded text-sm text-zinc-400 hover:text-white">Cancel</button>
              <button onClick={() => deleteBot(deleteId)} className="bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded text-sm">Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editBot && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-700 rounded-lg w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-zinc-800 sticky top-0 bg-zinc-900 z-10">
              <h3 className="text-white font-medium">Edit Bot: {editBot.name}</h3>
              <button onClick={() => setEditBot(null)} className="text-zinc-400 hover:text-white"><X size={18} /></button>
            </div>
            <div className="p-4 space-y-4">
              {/* Basic */}
              <div>
                <label className="text-xs text-zinc-500 uppercase tracking-wider mb-1 block">Bot Name</label>
                <input value={editName} onChange={e => setEditName(e.target.value)}
                  className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
              </div>
              <div>
                <label className="text-xs text-zinc-500 uppercase tracking-wider mb-1 block">Default Agent ID</label>
                <input value={editAgentId} onChange={e => setEditAgentId(e.target.value)} placeholder="Optional"
                  className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
              </div>

              {/* AI Settings */}
              <div className="border-t border-zinc-800 pt-4">
                <h4 className="text-sm font-medium text-zinc-300 mb-3">AI Settings</h4>
                <ModelSearch value={editModel} onChange={setEditModel} label="Model" placeholder="Default model" />
                <div className="mt-3">
                  <ModelFallback value={editFallback} onChange={setEditFallback} />
                </div>
              </div>

              {/* Tool Permissions */}
              <div className="border-t border-zinc-800 pt-4">
                <h4 className="text-sm font-medium text-zinc-300 mb-3">Tool Permissions</h4>
                <ToolPermissions
                  selectedTools={editTools}
                  onToggle={(id) => toggleTool(id, editTools, setEditTools)}
                  onSelectAll={() => setEditTools(new Set(ALL_TOOLS.map(t => t.id)))}
                  onDeselectAll={() => setEditTools(new Set())}
                />
              </div>

              {/* Response Settings */}
              <div className="border-t border-zinc-800 pt-4">
                <h4 className="text-sm font-medium text-zinc-300 mb-3">Response Settings</h4>
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-zinc-500 uppercase tracking-wider mb-1 block">Max Length</label>
                      <input type="number" value={editMaxLength} onChange={e => setEditMaxLength(e.target.value)} placeholder="4096"
                        className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
                    </div>
                    <div>
                      <label className="text-xs text-zinc-500 uppercase tracking-wider mb-1 block">Language</label>
                      <input value={editLanguage} onChange={e => setEditLanguage(e.target.value)} placeholder="Auto"
                        className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-zinc-500 uppercase tracking-wider mb-1 block">Welcome Message</label>
                    <textarea value={editWelcome} onChange={e => setEditWelcome(e.target.value)} placeholder="Sent when a new conversation starts" rows={2}
                      className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none resize-none" />
                  </div>
                  <div>
                    <label className="text-xs text-zinc-500 uppercase tracking-wider mb-1 block">Error Message</label>
                    <textarea value={editError} onChange={e => setEditError(e.target.value)} placeholder="Sent when an error occurs" rows={2}
                      className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none resize-none" />
                  </div>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 p-4 border-t border-zinc-800 sticky bottom-0 bg-zinc-900">
              <button onClick={() => setEditBot(null)} className="px-4 py-2 rounded text-sm text-zinc-400 hover:text-white">Cancel</button>
              <button onClick={saveEdit} disabled={saving}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded text-sm flex items-center gap-1">
                <Check size={14} /> {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {bots.map(bot => (
          <div key={bot.id} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 hover:border-zinc-700 transition">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-blue-600/20 flex items-center justify-center">
                  <Radio size={20} className="text-blue-400" />
                </div>
                <div>
                  <h3 className="text-white font-medium">{bot.name}</h3>
                  <p className="text-xs text-zinc-500 capitalize">{bot.channel}</p>
                </div>
              </div>
              <span className={`flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full ${
                bot.running ? 'bg-green-900/30 text-green-400' : 'bg-zinc-800 text-zinc-500'
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${bot.running ? 'bg-green-400' : 'bg-zinc-500'}`} />
                {bot.running ? 'Running' : 'Stopped'}
              </span>
            </div>
            <div className="flex items-center justify-between mt-4">
              <span className="text-xs text-zinc-500">Last connected: {timeAgo(bot.updated_at)}</span>
              <div className="flex items-center gap-1">
                <button onClick={() => openEdit(bot)} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-white" title="Edit">
                  <Pencil size={14} />
                </button>
                {!bot.running ? (
                  <button onClick={() => startBot(bot.id)} className="p-1.5 rounded hover:bg-zinc-800 text-green-400" title="Start">
                    <Play size={14} />
                  </button>
                ) : (
                  <button onClick={() => stopBot(bot.id)} className="p-1.5 rounded hover:bg-zinc-800 text-yellow-400" title="Stop">
                    <Square size={14} />
                  </button>
                )}
                <button onClick={() => setDeleteId(bot.id)} className="p-1.5 rounded hover:bg-zinc-800 text-red-400" title="Delete">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          </div>
        ))}
        {bots.length === 0 && !showAdd && (
          <div className="col-span-full text-center py-12 text-zinc-500">
            <Radio size={32} className="mx-auto mb-3 opacity-50" />
            <p>No bots configured. Create a bot to connect to messaging channels.</p>
          </div>
        )}
      </div>
    </div>
  );
}
