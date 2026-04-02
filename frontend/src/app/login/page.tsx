'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';

export default function LoginPage() {
  const router = useRouter();
  const setUser = useStore((s) => s.setUser);
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      let data;
      if (isRegister) {
        data = await api.register(email, password, name);
      } else {
        data = await api.login(email, password);
      }

      // Save tokens
      localStorage.setItem('access_token', data.access_token);
      localStorage.setItem('refresh_token', data.refresh_token);
      api.setToken(data.access_token);

      // Set user in store
      setUser(data.user);

      router.push('/chat');
    } catch (err: any) {
      setError(err.message || 'Đăng nhập thất bại');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white">AHVclaw</h1>
          <p className="text-zinc-400 mt-2">Nền tảng AI Agent</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-zinc-900 rounded-lg p-6 border border-zinc-800">
          <h2 className="text-xl font-semibold text-white mb-6">
            {isRegister ? 'Tạo tài khoản' : 'Đăng nhập'}
          </h2>

          {error && (
            <div className="bg-red-900/50 text-red-300 px-4 py-2 rounded mb-4 text-sm">
              {error}
            </div>
          )}

          {isRegister && (
            <div className="mb-4">
              <label className="block text-sm text-zinc-400 mb-1">Tên</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-zinc-800 text-white rounded px-3 py-2 border border-zinc-700 focus:border-blue-500 focus:outline-none"
                placeholder="Tên của bạn"
                required
              />
            </div>
          )}

          <div className="mb-4">
            <label className="block text-sm text-zinc-400 mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-zinc-800 text-white rounded px-3 py-2 border border-zinc-700 focus:border-blue-500 focus:outline-none"
              placeholder="email@example.com"
              required
            />
          </div>

          <div className="mb-6">
            <label className="block text-sm text-zinc-400 mb-1">Mật khẩu</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-zinc-800 text-white rounded px-3 py-2 border border-zinc-700 focus:border-blue-500 focus:outline-none"
              placeholder="********"
              required
              minLength={8}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2 rounded font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Vui lòng chờ...' : isRegister ? 'Tạo tài khoản' : 'Đăng nhập'}
          </button>

          <p className="text-center text-sm text-zinc-400 mt-4">
            {isRegister ? 'Đã có tài khoản?' : 'Chưa có tài khoản?'}{' '}
            <button
              type="button"
              onClick={() => {
                setIsRegister(!isRegister);
                setError('');
              }}
              className="text-blue-400 hover:text-blue-300"
            >
              {isRegister ? 'Đăng nhập' : 'Đăng ký'}
            </button>
          </p>
        </form>
      </div>
    </div>
  );
}
