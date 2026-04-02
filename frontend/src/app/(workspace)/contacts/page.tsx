'use client';

import { useEffect, useState } from 'react';
import { Users, Search, X, Save, Trash2 } from 'lucide-react';

interface Contact {
  id: string;
  name: string;
  tags: string[];
  channels: string[];
  notes?: string;
  last_seen?: string;
  created_at: string;
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Contact | null>(null);
  const [editName, setEditName] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editTags, setEditTags] = useState('');
  const [mergeTarget, setMergeTarget] = useState('');

  const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3101';
  const headers = () => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${localStorage.getItem('access_token')}`,
  });

  const loadContacts = async () => {
    try {
      const params = search ? `?search=${encodeURIComponent(search)}` : '';
      const res = await fetch(`${baseUrl}/api/contacts${params}`, { headers: headers() });
      if (res.ok) setContacts(await res.json());
    } catch {}
  };

  useEffect(() => { loadContacts(); }, [search]);

  const selectContact = (c: Contact) => {
    setSelected(c);
    setEditName(c.name || '');
    setEditNotes(c.notes || '');
    setEditTags((c.tags || []).join(', '));
    setMergeTarget('');
  };

  const saveContact = async () => {
    if (!selected) return;
    try {
      await fetch(`${baseUrl}/api/contacts/${selected.id}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({
          name: editName,
          notes: editNotes,
          tags: editTags.split(',').map(t => t.trim()).filter(Boolean),
        }),
      });
      setSelected(null);
      loadContacts();
    } catch {}
  };

  const deleteContact = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Xóa contact này?')) return;
    try {
      await fetch(`${baseUrl}/api/contacts/${id}`, { method: 'DELETE', headers: headers() });
      if (selected?.id === id) setSelected(null);
      loadContacts();
    } catch {}
  };

  const mergeContacts = async () => {
    if (!selected || !mergeTarget) return;
    if (!confirm('Gộp contact này? Hành động không thể hoàn tác.')) return;
    try {
      await fetch(`${baseUrl}/api/contacts/merge`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ source_id: selected.id, target_id: mergeTarget }),
      });
      setSelected(null);
      setMergeTarget('');
      loadContacts();
    } catch {}
  };

  const tagColor = (tag: string) => {
    const colors = ['bg-blue-900/30 text-blue-400', 'bg-green-900/30 text-green-400', 'bg-purple-900/30 text-purple-400', 'bg-yellow-900/30 text-yellow-400', 'bg-pink-900/30 text-pink-400'];
    let hash = 0;
    for (const c of tag) hash = c.charCodeAt(0) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  };

  const channelIcon = (ch: string) => {
    const icons: Record<string, string> = { telegram: 'TG', zalo: 'ZL', discord: 'DC' };
    return icons[ch] || ch.substring(0, 2).toUpperCase();
  };

  const timeAgo = (date?: string) => {
    if (!date) return 'Không rõ';
    const diff = Date.now() - new Date(date).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-white flex items-center gap-2">
          <Users size={20} /> Danh bạ
        </h1>
      </div>

      <div className="relative mb-4">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Tìm kiếm liên hệ..."
          className="w-full bg-zinc-800 text-white text-sm rounded-lg pl-9 pr-3 py-2 border border-zinc-700 focus:border-blue-500 outline-none" />
      </div>

      {selected && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-white font-medium">Sửa liên hệ</h3>
            <button onClick={() => setSelected(null)} className="text-zinc-500 hover:text-white"><X size={16} /></button>
          </div>
          <div className="space-y-3">
            <input value={editName} onChange={e => setEditName(e.target.value)} placeholder="Tên"
              className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
            <input value={editTags} onChange={e => setEditTags(e.target.value)} placeholder="Nhãn (phân cách bằng dấu phẩy)"
              className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none" />
            <textarea value={editNotes} onChange={e => setEditNotes(e.target.value)} placeholder="Ghi chú..." rows={3}
              className="w-full bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 focus:border-blue-500 outline-none resize-none" />
            <div className="text-xs text-zinc-500">Channels: {(selected.channels || []).join(', ') || 'None'}</div>
            <button onClick={saveContact} className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded text-sm flex items-center gap-1">
              <Save size={14} /> Save
            </button>
            <div className="mt-4 pt-4 border-t border-zinc-800">
              <h4 className="text-sm text-zinc-400 mb-2">Gộp contact</h4>
              <div className="flex gap-2">
                <select value={mergeTarget} onChange={e => setMergeTarget(e.target.value)}
                  className="flex-1 bg-zinc-800 text-white rounded px-3 py-2 text-sm border border-zinc-700 outline-none">
                  <option value="">Chọn contact để gộp vào...</option>
                  {contacts.filter(c => c.id !== selected?.id).map(c => (
                    <option key={c.id} value={c.id}>{c.name || 'Không rõ'}</option>
                  ))}
                </select>
                <button onClick={mergeContacts} disabled={!mergeTarget}
                  className="bg-yellow-600 hover:bg-yellow-700 disabled:opacity-30 text-white px-3 py-2 rounded text-sm">
                  Gộp
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-zinc-500 text-xs">
              <th className="text-left px-4 py-3 font-medium">Name</th>
              <th className="text-left px-4 py-3 font-medium">Tags</th>
              <th className="text-left px-4 py-3 font-medium">Channels</th>
              <th className="text-left px-4 py-3 font-medium">Lần cuối</th>
              <th className="text-left px-4 py-3 font-medium">Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map(c => (
              <tr key={c.id} onClick={() => selectContact(c)}
                className="border-b border-zinc-800/50 hover:bg-zinc-800/50 cursor-pointer transition">
                <td className="px-4 py-3 text-white">{c.name || 'Không rõ'}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {(c.tags || []).map(tag => (
                      <span key={tag} className={`text-[10px] px-1.5 py-0.5 rounded ${tagColor(tag)}`}>{tag}</span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-1">
                    {(c.channels || []).map(ch => (
                      <span key={ch} className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">{channelIcon(ch)}</span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3 text-zinc-500 text-xs">{timeAgo(c.last_seen)}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={(e) => deleteContact(c.id, e)} className="text-zinc-500 hover:text-red-400 transition">
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {contacts.length === 0 && (
          <div className="text-center py-12 text-zinc-500">
            <Users size={32} className="mx-auto mb-3 opacity-50" />
            <p>Không tìm thấy liên hệ nào.</p>
          </div>
        )}
      </div>
    </div>
  );
}
