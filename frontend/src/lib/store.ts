import { create } from 'zustand';
import { api } from './api';

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
}

interface Conversation {
  id: string;
  title: string | null;
  model?: string | null;
  pinned?: boolean;
  updated_at: string;
  channel?: string | null;
}

interface Message {
  id: string;
  role: string;
  content: string | null;
  tool_calls?: unknown;
  created_at: string;
  source?: string;
  thinking?: string;
  attachments?: Array<{ id: string; filename: string; mime_type: string; url: string }>;
}

interface AppStore {
  user: User | null;
  setUser: (user: User | null) => void;
  logout: () => void;
  conversations: Conversation[];
  setConversations: (convos: Conversation[]) => void;
  loadConversations: () => Promise<void>;
  removeConversation: (id: string) => void;
  activeConversationId: string | null;
  setActiveConversationId: (id: string | null) => void;
  messages: Message[];
  setMessages: (msgs: Message[]) => void;
  appendMessage: (msg: Message) => void;
  updateLastAssistantContent: (content: string) => void;
  selectedModel: string;
  setSelectedModel: (model: string) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  rightPanelOpen: boolean;
  setRightPanelOpen: (open: boolean) => void;
  toggleRightPanel: () => void;
}

export const useStore = create<AppStore>((set) => ({
  user: null,
  setUser: (user) => set({ user }),

  logout: () => {
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
    api.setToken(null);
    set({ user: null, conversations: [], messages: [], activeConversationId: null });
  },

  conversations: [],
  setConversations: (conversations) => set({ conversations }),

  loadConversations: async () => {
    try {
      const data = await api.getConversations();
      set({ conversations: data || [] });
    } catch (err) {
      console.error('Failed to load conversations:', err);
    }
  },

  removeConversation: (id) => set((s) => ({
    conversations: s.conversations.filter(c => c.id !== id),
    activeConversationId: s.activeConversationId === id ? null : s.activeConversationId,
    messages: s.activeConversationId === id ? [] : s.messages,
  })),

  activeConversationId: null,
  setActiveConversationId: (id) => set({ activeConversationId: id }),

  messages: [],
  setMessages: (messages) => set({ messages }),
  appendMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  updateLastAssistantContent: (content) =>
    set((s) => {
      const msgs = [...s.messages];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant') {
          msgs[i] = { ...msgs[i], content: (msgs[i].content || '') + content };
          break;
        }
      }
      return { messages: msgs };
    }),

  selectedModel: 'AHV-Holding-TroLy',
  setSelectedModel: (model) => set({ selectedModel: model }),

  sidebarOpen: typeof window !== 'undefined' && window.innerWidth >= 768,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  rightPanelOpen: false,
  setRightPanelOpen: (open) => set({ rightPanelOpen: open }),
  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
}));

// Alias for convenience
export const useAppStore = useStore;
