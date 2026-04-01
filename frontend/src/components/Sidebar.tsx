'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { MessageSquare, Plus, Settings, Server, Puzzle, Bot, LogOut } from 'lucide-react';
import { useStore } from '@/lib/store';
import { api } from '@/lib/api';

export function Sidebar() {
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

  useEffect(() => {
    loadConversations();
  }, []);

  const handleNewChat = () => {
    setActiveConversationId(null);
    setMessages([]);
  };

  const handleSelectConversation = async (id: string) => {
    setActiveConversationId(id);
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

  return (
    <aside className="w-64 border-r border-zinc-800 bg-zinc-900 flex flex-col h-full">
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

      <nav className="flex-1 overflow-y-auto p-2 space-y-1 mt-2">
        {conversations.map((conv) => (
          <button
            key={conv.id}
            onClick={() => handleSelectConversation(conv.id)}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left truncate transition ${
              activeConversationId === conv.id
                ? 'bg-zinc-800 text-white'
                : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
            }`}
          >
            <MessageSquare size={14} className="shrink-0" />
            <span className="truncate">{conv.title || 'New Chat'}</span>
          </button>
        ))}
      </nav>

      <div className="p-2 border-t border-zinc-800 space-y-1">
        <SidebarLink icon={<Bot size={16} />} label="Agents" />
        <SidebarLink icon={<Puzzle size={16} />} label="Skills" />
        <SidebarLink icon={<Server size={16} />} label="Servers" />
        <SidebarLink icon={<Settings size={16} />} label="Settings" />
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-red-400 hover:bg-zinc-800/50 transition"
        >
          <LogOut size={16} />
          Logout
        </button>
      </div>

      {user && (
        <div className="border-t border-zinc-800 p-3">
          <p className="text-xs text-zinc-400 truncate">{user.email}</p>
        </div>
      )}
    </aside>
  );
}

function SidebarLink({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <button className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200 transition">
      {icon}
      {label}
    </button>
  );
}
