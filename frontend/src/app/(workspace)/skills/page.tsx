'use client';

import { useEffect, useState } from 'react';
import { Sparkles, Plus, Trash2 } from 'lucide-react';

interface Skill {
  id: string;
  name: string;
  slug: string;
  description: string;
  version: string;
  is_public: boolean;
  installs_count: number;
  created_at: string;
}

export default function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [formName, setFormName] = useState('');
  const [formSlug, setFormSlug] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formPrompt, setFormPrompt] = useState('');

  const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3101';
  const headers = () => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${localStorage.getItem('access_token')}`,
  });

  const loadSkills = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/skills`, { headers: headers() });
      if (res.ok) setSkills(await res.json());
    } catch {}
  };

  useEffect(() => { loadSkills(); }, []);

  const addSkill = async () => {
    if (!formName || !formSlug) return;
    try {
      await fetch(`${baseUrl}/api/skills`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          name: formName,
          slug: formSlug,
          description: formDesc,
          config: { prompt: formPrompt, tools_required: [], triggers: [] },
        }),
      });
      setShowAdd(false);
      setFormName(''); setFormSlug(''); setFormDesc(''); setFormPrompt('');
      loadSkills();
    } catch {}
  };

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-white flex items-center gap-2">
          <Sparkles size={20} /> Kỹ năng
        </h1>
        <button onClick={() => setShowAdd(!showAdd)} className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm flex items-center gap-1">
          <Plus size={14} /> Kỹ năng mới
        </button>
      </div>

      {showAdd && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-6 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Tên" value={formName} onChange={e => setFormName(e.target.value)}
              className="bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
            <input placeholder="Slug (mã duy nhất)" value={formSlug} onChange={e => setFormSlug(e.target.value)}
              className="bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
          </div>
          <input placeholder="Mô tả" value={formDesc} onChange={e => setFormDesc(e.target.value)}
            className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
          <textarea placeholder="System prompt cho kỹ năng này..." value={formPrompt} onChange={e => setFormPrompt(e.target.value)}
            rows={4} className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none resize-none" />
          <button onClick={addSkill} className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded text-sm">Tạo kỹ năng</button>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {skills.map(skill => (
          <div key={skill.id} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 hover:border-zinc-700 transition">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-white font-medium">{skill.name}</h3>
                <p className="text-xs text-zinc-500 mt-0.5">/{skill.slug}</p>
              </div>
              <span className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-400">v{skill.version}</span>
            </div>
            <p className="text-sm text-zinc-400 mt-2 line-clamp-2">{skill.description || 'Chưa có mô tả'}</p>
            <div className="flex items-center justify-between mt-3 text-xs text-zinc-500">
              <span>{skill.is_public ? 'Public' : 'Private'}</span>
              <span>{skill.installs_count} installs</span>
            </div>
          </div>
        ))}
        {skills.length === 0 && !showAdd && (
          <div className="col-span-full text-center py-12 text-zinc-500">
            <Sparkles size={32} className="mx-auto mb-3 opacity-50" />
            <p>Chưa có kỹ năng nào. Tạo kỹ năng đầu tiên để bắt đầu.</p>
          </div>
        )}
      </div>
    </div>
  );
}
