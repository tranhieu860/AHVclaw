'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Menu, X, Globe } from 'lucide-react';
import { Sidebar } from '@/components/Sidebar';
import { StatusBar } from '@/components/StatusBar';
import { BrowserPanel } from '@/components/BrowserPanel';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useStore } from '@/lib/store';
import { api } from '@/lib/api';

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const rightPanelOpen = useStore((s) => s.rightPanelOpen);
  const toggleRightPanel = useStore((s) => s.toggleRightPanel);
  const setUser = useStore((s) => s.setUser);
  const router = useRouter();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('access_token');
    if (!token) {
      router.push('/login');
      return;
    }

    api.setToken(token);
    api.getMe()
      .then((user) => {
        setUser(user);
        setLoading(false);
      })
      .catch(() => {
        const refreshToken = localStorage.getItem('refresh_token');
        if (refreshToken) {
          api.refreshToken(refreshToken)
            .then((data) => {
              localStorage.setItem('access_token', data.access_token);
              localStorage.setItem('refresh_token', data.refresh_token);
              api.setToken(data.access_token);
              setUser(data.user);
              setLoading(false);
            })
            .catch(() => {
              router.push('/login');
            });
        } else {
          router.push('/login');
        }
      });
  }, []);

  if (loading) {
    return (
      <div className="h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-zinc-400">Loading...</div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      {/* Mobile header with menu toggle */}
      <div className="md:hidden flex items-center gap-3 px-3 py-2 border-b border-zinc-800 bg-zinc-900">
        <button onClick={toggleSidebar} className="text-zinc-400 hover:text-white">
          {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
        <span className="text-sm font-semibold flex-1">AHVclaw</span>
        <ThemeToggle />
        <button onClick={toggleRightPanel} className="text-zinc-400 hover:text-white">
          <Globe size={20} />
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden relative">
        {sidebarOpen && (
          <>
            <div
              className="md:hidden fixed inset-0 bg-black/50 z-20"
              onClick={toggleSidebar}
            />
            <aside className="fixed md:static inset-y-0 left-0 z-30 md:z-auto w-64 flex-shrink-0">
              <Sidebar onNavigate={() => {
                if (window.innerWidth < 768) toggleSidebar();
              }} />
            </aside>
          </>
        )}

        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {children}
        </main>

        {rightPanelOpen && (
          <BrowserPanel onClose={() => toggleRightPanel()} />
        )}
      </div>

      <StatusBar />
    </div>
  );
}
