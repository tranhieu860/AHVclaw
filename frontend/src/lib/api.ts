const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3101';

class ApiClient {
  private accessToken: string | null = null;

  setToken(token: string | null) {
    this.accessToken = token;
  }

  private async fetchJSON(path: string, options: RequestInit = {}) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };
    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }
    const res = await fetch(`${API_URL}${path}`, { ...options, headers });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // Keep the old fetch method for backward compat
  async fetch(path: string, options: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };
    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }
    return fetch(`${API_URL}${path}`, { ...options, headers });
  }

  async login(email: string, password: string) {
    return this.fetchJSON('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  }

  async register(email: string, password: string, name: string) {
    return this.fetchJSON('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    });
  }

  async refreshToken(refreshToken: string) {
    return this.fetchJSON('/api/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  }

  async getMe() {
    return this.fetchJSON('/api/auth/me');
  }

  async getConversations() {
    return this.fetchJSON('/api/conversations');
  }

  async getMessages(conversationId: string) {
    return this.fetchJSON(`/api/conversations/${conversationId}`);
  }

  async getModels() {
    return this.fetchJSON('/api/models');
  }

  async getWSTicket(): Promise<string> {
    const data = await this.fetchJSON('/api/ws/ticket', { method: 'POST' });
    return data.ticket;
  }

  async createChatSocket(): Promise<WebSocket> {
    const wsUrl = API_URL.replace('http', 'ws');
    try {
      // Try ticket-based auth first
      const ticket = await this.getWSTicket();
      return new WebSocket(`${wsUrl}/ws/chat?ticket=${ticket}`);
    } catch {
      // Fallback to token
      return new WebSocket(`${wsUrl}/ws/chat?token=${this.accessToken}`);
    }
  }
}

export const api = new ApiClient();
