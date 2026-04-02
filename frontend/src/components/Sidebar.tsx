'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MessageSquare, Plus, Settings, Server, Puzzle, Bot, LogOut, Radio, Users } from 'lucide-react';
import { useStore } from '@/lib/store';
import { ThemeToggle } from './ThemeToggle';
import { api } from '@/lib/api';

interface SidebarProps {
  onNavigate?: () => void;
}

export function Sidebar({ onNavigate }: SidebarProps) {
  const {
    conversations,
    activeConversationId,
    setActiveConversationId,
    setMessages,
    loadConversations,
    user,
    logout,
  } = useStore();
  const router = useRouter();
  const [channelFilter, setChannelFilter] = useState('all');

  useEffect(() => {
    loadConversations();
  }, []);

  const handleNewChat = () => {
    setActiveConversationId(null);
    setMessages([]);
    router.push('/chat');
    onNavigate?.();
  };

  const handleSelectConversation = async (id: string) => {
    setActiveConversationId(id);
    router.push('/chat');
    onNavigate?.();
    try {
      const data = await api.getMessages(id);
      setMessages(data.messages || data || []);
    } catch (err) {
      console.error('Failed to load messages:', err);
    }
  };

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  const filteredConversations = conversations.filter(conv => {
    if (channelFilter === 'all') return true;
    if (channelFilter === 'web') return !conv.channel || conv.channel === 'web';
    return conv.channel === channelFilter;
  });

  return (
    <div className="w-64 border-r border-zinc-800 bg-zinc-900 flex flex-col h-full">
      <div className="p-4 border-b border-zinc-800">
        <h1 className="text-lg font-bold text-white">AHVclaw</h1>
        <p className="text-xs text-zinc-500">AI Agent Platform</p>
      </div>

      <button
        onClick={handleNewChat}
        className="mx-3 mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition"
      >
        <Plus size={16} /> New Chat
      </button>

      <div className="flex gap-1 px-3 mt-2 flex-wrap">
        {[
          { key: 'all', label: 'All' },
          { key: 'web', label: '🌐' },
          { key: 'telegram', label: '🔵' },
          { key: 'zalo', label: '🟢' },
          { key: 'discord', label: '🟣' },
        ].map(f => (
          <button key={f.key} onClick={() => setChannelFilter(f.key)}
            className={`px-2 py-1 text-xs rounded transition ${              channelFilter === f.key ? 'bg-blue-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'            }`}>{f.label}</button>
        ))}
      </div>

      <nav className="flex-1 overflow-y-auto p-2 space-y-1 mt-2">
        {filteredConversations.map((conv) => (
          <button
            key={conv.id}
            onClick={() => handleSelectConversation(conv.id)}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left truncate transition ${              activeConversationId === conv.id                ? 'bg-zinc-800 text-white'                : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'            }`}
          >
            <MessageSquare size={14} className="shrink-0" />
            <span className="truncate">{conv.title || 'New Chat'}</span>
            {conv.channel && conv.channel !== 'web' && (
              <span className="text-[9px] px-1 rounded bg-zinc-700 text-zinc-400 ml-1 shrink-0">
                {conv.channel === 'telegram' ? '🔵 TG' : conv.channel === 'zalo' ? '🟢 ZL' : conv.channel === 'discord' ? '🟣 DC' : conv.channel}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="p-2 border-t border-zinc-800 space-y-1">
        <SidebarLink icon={<Bot size={16} />} label="Agents" href="/agents" />
        <SidebarLink icon={<Radio size={16} />} label="Bots" href="/bots" />
        <SidebarLink icon={<Users size={16} />} label="Contacts" href="/contacts" />
        <SidebarLink icon={<Puzzle size={16} />} label="Skills" href="/skills" />
        <SidebarLink icon={<Server size={16} />} label="Servers" href="/servers" />
        <SidebarLink icon={<Settings size={16} />} label="Settings" href="/settings" />
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-red-400 hover:bg-zinc-800/50 transition"
        >
          <LogOut size={16} />
          Logout
        </button>
      </div>

      {user && (
        <div className="border-t border-zinc-800 p-3 flex items-center justify-between">
          <p className="text-xs text-zinc-400 truncate">{user.email}</p>
          <ThemeToggle />
        </div>
      )}
    </div>
  );
}

function SidebarLink({ icon, label, href }: { icon: React.ReactNode; label: string; href: string }) {
  return (
    <Link href={href} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200 transition">
      {icon}
      {label}
    </Link>
  );
}
