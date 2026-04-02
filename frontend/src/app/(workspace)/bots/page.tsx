'use client';

import { useEffect, useState, useCallback } from 'react';
import { Radio, Plus, Play, Square, Trash2, Pencil, ChevronDown, ChevronUp, X, Check, Copy, Link, Info } from 'lucide-react';
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
  channel_config?: {
    webhook_secret?: string;
    [key: string]: unknown;
  };
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
  access_settings?: {
    whitelist_enabled?: boolean;
    allowed_user_ids?: string[];
    allow_all?: boolean;
  };
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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };
  return (
    <button onClick={copy} className="p-1 rounded hover:bg-zinc-600 text-zinc-400 hover:text-white" title="Copy">
      {copied ? <span className="text-xs text-green-400 px-1">{'\u0110\u00e3 copy!'}</span> : <Copy size={13} />}
    </button>
  );
}

function WebhookInfoBox({ botId, webhookSecret }: { botId?: string; webhookSecret: string }) {
  const webhookUrl = botId
    ? `https://api.ahvclaw.com/webhook/zalo/${botId}`
    : null;
  return (
    <div className="bg-blue-950/40 border border-blue-800/50 rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-2 text-blue-400 text-sm font-medium">
        <Info size={14} /> C&#7845;u h&#236;nh Zalo OA
      </div>
      <div className="space-y-1.5 text-xs">
        <div>
          <span className="text-zinc-400">Webhook URL: </span>
          {webhookUrl ? (
            <span className="inline-flex items-center gap-1">
              <code className="bg-zinc-800 px-1.5 py-0.5 rounded text-blue-300 break-all">{webhookUrl}</code>
              <CopyButton text={webhookUrl} />
            </span>
          ) : (
            <span className="text-zinc-500 italic">S&#7869; hi&#7879;n sau khi t&#7841;o bot</span>
          )}
        </div>
        <div>
          <span className="text-zinc-400">Secret Token: </span>
          <span className="inline-flex items-center gap-1">
            <code className="bg-zinc-800 px-1.5 py-0.5 rounded text-green-300 break-all">{webhookSecret}</code>
            <CopyButton text={webhookSecret} />
          </span>
        </div>
      </div>
      {!botId && (
        <div className="text-xs text-zinc-400 mt-2 space-y-0.5">
          <p className="font-medium text-zinc-300">H&#432;&#7899;ng d&#7851;n:</p>
          <p>1. L&#7845;y Access Token t&#7915; Zalo Developer Console</p>
          <p>2. D&#225;n v&#224;o &#244; tr&#234;n</p>
          <p>3. T&#7841;o bot</p>
          <p>4. Copy Webhook URL v&#224; Secret Token v&#224;o Zalo OA Admin</p>
        </div>
      )}
    </div>
  );
}

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
        <span>Quy&#7873;n c&#244;ng c&#7909; ({selectedTools.size}/{ALL_TOOLS.length})</span>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {expanded && (
        <div className="p-3 space-y-3 bg-zinc-900/50">
          <div className="flex gap-2">
            <button type="button" onClick={onSelectAll}
              className="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300">
              Ch&#7885;n t&#7845;t c&#7843;
            </button>
            <button type="button" onClick={onDeselectAll}
              className="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300">
              B&#7887; ch&#7885;n t&#7845;t c&#7843;
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
  const [webhookSecret, setWebhookSecret] = useState('');
  const [showWebhookBotId, setShowWebhookBotId] = useState<string | null>(null);
  const [whitelistEnabled, setWhitelistEnabled] = useState(true);
  const [allowedUserIds, setAllowedUserIds] = useState('');
  const [allowAll, setAllowAll] = useState(false);

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
  const [editWhitelistEnabled, setEditWhitelistEnabled] = useState(true);
  const [editAllowedUserIds, setEditAllowedUserIds] = useState('');
  const [editAllowAll, setEditAllowAll] = useState(false);

  const generateSecret = useCallback(() => {
    return crypto.randomUUID().replace(/-/g, '');
  }, []);

  // Generate webhook secret when channel changes to zalo or form opens
  useEffect(() => {
    if (formChannel === 'zalo' && showAdd) {
      if (!webhookSecret) {
        setWebhookSecret(generateSecret());
      }
    }
  }, [formChannel, showAdd, generateSecret, webhookSecret]);

  // Reset secret when form closes
  useEffect(() => {
    if (!showAdd) {
      setWebhookSecret('');
    }
  }, [showAdd]);

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
          channel_config: formChannel === 'zalo'
            ? { access_token: formToken, webhook_secret: webhookSecret }
            : { bot_token: formToken },
          ai_settings: isAllSelected ? {} : { allowed_tools: Array.from(selectedTools) },
          default_agent_id: formAgentId || undefined,
          access_settings: {
            whitelist_enabled: whitelistEnabled,
            allowed_user_ids: allowedUserIds.split(',').map((s: string) => s.trim()).filter(Boolean),
            allow_all: allowAll,
          },
        }),
      });
      setShowAdd(false);
      setFormName(''); setFormToken(''); setFormAgentId('');
      setSelectedTools(new Set(allToolIds));
      setWebhookSecret('');
      setWhitelistEnabled(true);
      setAllowedUserIds('');
      setAllowAll(false);
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

    setEditWhitelistEnabled(bot.access_settings?.whitelist_enabled !== false);
    setEditAllowedUserIds((bot.access_settings?.allowed_user_ids || []).join(', '));
    setEditAllowAll(bot.access_settings?.allow_all || false);

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
          access_settings: {
            whitelist_enabled: editWhitelistEnabled,
            allowed_user_ids: editAllowedUserIds.split(',').map((s: string) => s.trim()).filter(Boolean),
            allow_all: editAllowAll,
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
          <Plus size={14} /> Bot m&#7899;i
        </button>
      </div>

      {showAdd && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-6 space-y-3">
          <input placeholder="T&#234;n bot" value={formName} onChange={e => setFormName(e.target.value)}
            className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
          <select value={formChannel} onChange={e => { setFormChannel(e.target.value); if (e.target.value === 'zalo') setWebhookSecret(generateSecret()); }}
            className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none">
            <option value="telegram">Telegram</option>
            <option value="zalo">Zalo</option>
            <option value="discord">Discord</option>
          </select>
          <input placeholder={formChannel === 'zalo' ? 'Access Token Zalo OA' :  'Token bot'} value={formToken} onChange={e => setFormToken(e.target.value)}
            className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />

          {/* Channel-specific info boxes */}
          {formChannel === 'zalo' && webhookSecret && (
            <WebhookInfoBox webhookSecret={webhookSecret} />
          )}
          {formChannel === 'telegram' && (
            <div className="bg-blue-950/40 border border-blue-800/50 rounded-lg p-3">
              <div className="flex items-center gap-2 text-blue-400 text-sm font-medium">
                <Info size={14} /> Telegram Bot
              </div>
              <p className="text-xs text-zinc-400 mt-1">Kh&#244;ng c&#7847;n c&#7845;u h&#236;nh th&#234;m &#8212; bot Telegram k&#7871;t n&#7889;i t&#7921; &#273;&#7897;ng qua long polling.</p>
            </div>
          )}

          <input placeholder="Agent ID (t&#249;y ch&#7885;n)" value={formAgentId} onChange={e => setFormAgentId(e.target.value)}
            className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
          <ToolPermissions
            selectedTools={selectedTools}
            onToggle={(id) => toggleTool(id, selectedTools, setSelectedTools)}
            onSelectAll={() => setSelectedTools(new Set(ALL_TOOLS.map(t => t.id)))}
            onDeselectAll={() => setSelectedTools(new Set())}
          />

          {/* Access Control */}
          <div className="border border-zinc-700 rounded-lg p-3 space-y-3">
            <h4 className="text-sm font-medium text-zinc-300">Quyền truy cập</h4>
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-sm text-zinc-300">Chỉ cho phép người dùng cụ thể</span>
              <input type="checkbox" checked={whitelistEnabled} onChange={e => { setWhitelistEnabled(e.target.checked); if (e.target.checked) setAllowAll(false); }}
                className="rounded border-zinc-600 bg-zinc-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0" />
            </label>
            {whitelistEnabled && !allowAll && (
              <div>
                <input placeholder="ID người dùng (phân cách bằng dấu phẩy)" value={allowedUserIds} onChange={e => setAllowedUserIds(e.target.value)}
                  className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
                <p className="text-xs text-zinc-500 mt-1">
                  {formChannel === 'telegram' ? 'Nhập Telegram User ID (số). Dùng @userinfobot để lấy ID' :
                   formChannel === 'zalo' ? 'Nhập Zalo User ID' :
                   formChannel === 'discord' ? 'Nhập Discord User ID' : 'Nhập User ID'}
                </p>
              </div>
            )}
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-sm text-zinc-300">Cho phép tất cả (công khai)</span>
              <input type="checkbox" checked={allowAll} onChange={e => { setAllowAll(e.target.checked); if (e.target.checked) setWhitelistEnabled(false); }}
                className="rounded border-zinc-600 bg-zinc-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0" />
            </label>
          </div>

          <button onClick={addBot} className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded text-sm">T&#7841;o bot</button>
        </div>
      )}

      {deleteId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-6 max-w-sm w-full mx-4">
            <h3 className="text-white font-medium mb-2">X&#243;a bot?</h3>
            <p className="text-sm text-zinc-400 mb-4">H&#224;nh &#273;&#7897;ng n&#224;y kh&#244;ng th&#7875; ho&#224;n t&#225;c. Bot s&#7869; b&#7883; d&#7915;ng v&#224; x&#243;a.</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleteId(null)} className="px-3 py-1.5 rounded text-sm text-zinc-400 hover:text-white">H&#7911;y</button>
              <button onClick={() => deleteBot(deleteId)} className="bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded text-sm">X&#243;a</button>
            </div>
          </div>
        </div>
      )}

      {/* Webhook info popup for existing Zalo bots */}
      {showWebhookBotId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowWebhookBotId(null)}>
          <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-4 max-w-md w-full mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-white font-medium text-sm">Zalo Webhook Info</h3>
              <button onClick={() => setShowWebhookBotId(null)} className="text-zinc-400 hover:text-white"><X size={16} /></button>
            </div>
            {(() => {
              const bot = bots.find(b => b.id === showWebhookBotId);
              if (!bot) return null;
              const secret = bot.channel_config?.webhook_secret || 'N/A';
              return <WebhookInfoBox botId={bot.id} webhookSecret={secret} />;
            })()}
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editBot && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-700 rounded-lg w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-zinc-800 sticky top-0 bg-zinc-900 z-10">
              <h3 className="text-white font-medium">S&#7917;a bot: {editBot.name}</h3>
              <button onClick={() => setEditBot(null)} className="text-zinc-400 hover:text-white"><X size={18} /></button>
            </div>
            <div className="p-4 space-y-4">
              {/* Webhook info for Zalo bots in edit modal */}
              {editBot.channel === 'zalo' && (
                <WebhookInfoBox botId={editBot.id} webhookSecret={editBot.channel_config?.webhook_secret || 'N/A'} />
              )}

              {/* Basic */}
              <div>
                <label className="text-xs text-zinc-500 uppercase tracking-wider mb-1 block">T&#234;n bot</label>
                <input value={editName} onChange={e => setEditName(e.target.value)}
                  className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
              </div>
              <div>
                <label className="text-xs text-zinc-500 uppercase tracking-wider mb-1 block">Agent ID m&#7863;c &#273;&#7883;nh</label>
                <input value={editAgentId} onChange={e => setEditAgentId(e.target.value)} placeholder="Optional"
                  className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
              </div>

              {/* C&#224;i &#273;&#7863;t AI */}
              <div className="border-t border-zinc-800 pt-4">
                <h4 className="text-sm font-medium text-zinc-300 mb-3">C&#224;i &#273;&#7863;t AI</h4>
                <ModelSearch value={editModel} onChange={setEditModel} label="Model" placeholder="Default model" />
                <div className="mt-3">
                  <ModelFallback value={editFallback} onChange={setEditFallback} />
                </div>
              </div>

              {/* Quy&#7873;n c&#244;ng c&#7909; */}
              <div className="border-t border-zinc-800 pt-4">
                <h4 className="text-sm font-medium text-zinc-300 mb-3">Quy&#7873;n c&#244;ng c&#7909;</h4>
                <ToolPermissions
                  selectedTools={editTools}
                  onToggle={(id) => toggleTool(id, editTools, setEditTools)}
                  onSelectAll={() => setEditTools(new Set(ALL_TOOLS.map(t => t.id)))}
                  onDeselectAll={() => setEditTools(new Set())}
                />
              </div>

              {/* C&#224;i &#273;&#7863;t ph&#7843;n h&#7891;i */}
              <div className="border-t border-zinc-800 pt-4">
                <h4 className="text-sm font-medium text-zinc-300 mb-3">C&#224;i &#273;&#7863;t ph&#7843;n h&#7891;i</h4>
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-zinc-500 uppercase tracking-wider mb-1 block">&#272;&#7897; d&#224;i t&#7889;i &#273;a</label>
                      <input type="number" value={editMaxLength} onChange={e => setEditMaxLength(e.target.value)} placeholder="4096"
                        className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
                    </div>
                    <div>
                      <label className="text-xs text-zinc-500 uppercase tracking-wider mb-1 block">Ng&#244;n ng&#7919;</label>
                      <input value={editLanguage} onChange={e => setEditLanguage(e.target.value)} placeholder="Auto"
                        className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-zinc-500 uppercase tracking-wider mb-1 block">Tin nh&#7855;n ch&#224;o m&#7915;ng</label>
                    <textarea value={editWelcome} onChange={e => setEditWelcome(e.target.value)} placeholder="G&#7917;i khi b&#7855;t &#273;&#7847;u cu&#7897;c tr&#242; chuy&#7879;n m&#7899;i" rows={2}
                      className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none resize-none" />
                  </div>
                  <div>
                    <label className="text-xs text-zinc-500 uppercase tracking-wider mb-1 block">Tin nh&#7855;n l&#7895;i</label>
                    <textarea value={editError} onChange={e => setEditError(e.target.value)} placeholder="G&#7917;i khi c&#243; l&#7895;i x&#7843;y ra" rows={2}
                      className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none resize-none" />
                  </div>
                </div>
              </div>

              {/* Access Control */}
              <div className="border-t border-zinc-800 pt-4">
                <h4 className="text-sm font-medium text-zinc-300 mb-3">Quyền truy cập</h4>
                <div className="space-y-3">
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-sm text-zinc-300">Chỉ cho phép người dùng cụ thể</span>
                    <input type="checkbox" checked={editWhitelistEnabled} onChange={e => { setEditWhitelistEnabled(e.target.checked); if (e.target.checked) setEditAllowAll(false); }}
                      className="rounded border-zinc-600 bg-zinc-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0" />
                  </label>
                  {editWhitelistEnabled && !editAllowAll && (
                    <div>
                      <input placeholder="ID người dùng (phân cách bằng dấu phẩy)" value={editAllowedUserIds} onChange={e => setEditAllowedUserIds(e.target.value)}
                        className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
                      <p className="text-xs text-zinc-500 mt-1">
                        {editBot?.channel === 'telegram' ? 'Nhập Telegram User ID (số). Dùng @userinfobot để lấy ID' :
                         editBot?.channel === 'zalo' ? 'Nhập Zalo User ID' :
                         editBot?.channel === 'discord' ? 'Nhập Discord User ID' : 'Nhập User ID'}
                      </p>
                    </div>
                  )}
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-sm text-zinc-300">Cho phép tất cả (công khai)</span>
                    <input type="checkbox" checked={editAllowAll} onChange={e => { setEditAllowAll(e.target.checked); if (e.target.checked) setEditWhitelistEnabled(false); }}
                      className="rounded border-zinc-600 bg-zinc-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0" />
                  </label>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 p-4 border-t border-zinc-800 sticky bottom-0 bg-zinc-900">
              <button onClick={() => setEditBot(null)} className="px-4 py-2 rounded text-sm text-zinc-400 hover:text-white">H&#7911;y</button>
              <button onClick={saveEdit} disabled={saving}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded text-sm flex items-center gap-1">
                <Check size={14} /> {saving ? '&#272;ang l&#432;u...' : 'L&#432;u thay &#273;&#7893;i'}
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
                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                    bot.access_settings?.allow_all ? 'bg-green-900/30 text-green-400' : 'bg-yellow-900/30 text-yellow-400'
                  }`}>
                    {bot.access_settings?.allow_all ? '🌐 Công khai' : '🔒 Riêng tư'}
                  </span>
                </div>
              </div>
              <span className={`flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full ${
                bot.running ? 'bg-green-900/30 text-green-400' : 'bg-zinc-800 text-zinc-500'
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${bot.running ? 'bg-green-400' : 'bg-zinc-500'}`} />
                {bot.running ? '&#272;ang ch&#7841;y' : '&#272;&#227; d&#7915;ng'}
              </span>
            </div>
            <div className="flex items-center justify-between mt-4">
              <span className="text-xs text-zinc-500">K&#7871;t n&#7889;i l&#7847;n cu&#7889;i: {timeAgo(bot.updated_at)}</span>
              <div className="flex items-center gap-1">
                {bot.channel === 'zalo' && (
                  <button onClick={() => setShowWebhookBotId(bot.id)} className="p-1.5 rounded hover:bg-zinc-800 text-blue-400 hover:text-blue-300" title="Webhook Info">
                    <Link size={14} />
                  </button>
                )}
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
            <p>Ch&#432;a c&#243; bot n&#224;o. T&#7841;o bot &#273;&#7875; k&#7871;t n&#7889;i &#273;&#7871;n c&#225;c k&#234;nh nh&#7855;n tin.</p>
          </div>
        )}
      </div>
    </div>
  );
}
