'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { StatusBar } from '@/components/StatusBar';
import { useStore } from '@/lib/store';
import { api } from '@/lib/api';

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
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
        // Token expired, try refresh
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
    <div className="flex h-screen w-screen overflow-hidden">
      {sidebarOpen && <Sidebar />}
      <main className="flex flex-col flex-1 min-w-0">
        <div className="flex-1 overflow-hidden">{children}</div>
        <StatusBar />
      </main>
    </div>
  );
}
