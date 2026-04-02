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

  async deleteConversation(conversationId: string) {
    return this.fetchJSON(`/api/conversations/${conversationId}`, { method: 'DELETE' });
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
  // Bots
  async getBots() { return this.fetchJSON('/api/bots'); }
  async createBot(data: Record<string, unknown>) { return this.fetchJSON('/api/bots', { method: 'POST', body: JSON.stringify(data) }); }
  async updateBot(id: string, data: Record<string, unknown>) { return this.fetchJSON(`/api/bots/${id}`, { method: 'PUT', body: JSON.stringify(data) }); }
  async deleteBot(id: string) { return this.fetchJSON(`/api/bots/${id}`, { method: 'DELETE' }); }
  async startBot(id: string) { return this.fetchJSON(`/api/bots/${id}/start`, { method: 'POST' }); }
  async stopBot(id: string) { return this.fetchJSON(`/api/bots/${id}/stop`, { method: 'POST' }); }

  // Inbox
  async getInbox(params?: Record<string, string>) { const qs = params ? '?' + new URLSearchParams(params).toString() : ''; return this.fetchJSON(`/api/inbox${qs}`); }
  async getInboxConversation(id: string) { return this.fetchJSON(`/api/inbox/${id}`); }
  async replyToConversation(id: string, content: string) { return this.fetchJSON(`/api/inbox/${id}/reply`, { method: 'POST', body: JSON.stringify({ content }) }); }
  async takeoverConversation(id: string) { return this.fetchJSON(`/api/inbox/${id}/takeover`, { method: 'POST' }); }
  async releaseConversation(id: string) { return this.fetchJSON(`/api/inbox/${id}/release`, { method: 'POST' }); }

  // Contacts
  async getContacts(search?: string) { const qs = search ? `?search=${encodeURIComponent(search)}` : ''; return this.fetchJSON(`/api/contacts${qs}`); }
  async updateContact(id: string, data: Record<string, unknown>) { return this.fetchJSON(`/api/contacts/${id}`, { method: 'PUT', body: JSON.stringify(data) }); }
  async deleteContact(id: string) { return this.fetchJSON(`/api/contacts/${id}`, { method: 'DELETE' }); }
  async mergeContacts(sourceId: string, targetId: string) { return this.fetchJSON('/api/contacts/merge', { method: 'POST', body: JSON.stringify({ source_id: sourceId, target_id: targetId }) }); }

  // Settings
  async getSettings() { return this.fetchJSON('/api/settings'); }
  async updateSettings(data: Record<string, unknown>) { return this.fetchJSON('/api/settings', { method: 'PUT', body: JSON.stringify(data) }); }
  async changePassword(oldPw: string, newPw: string) { return this.fetchJSON('/api/settings/password', { method: 'POST', body: JSON.stringify({ old_password: oldPw, new_password: newPw }) }); }
  async regenerateApiKey() { return this.fetchJSON('/api/settings/api-key', { method: 'POST' }); }
  async getStorage() { return this.fetchJSON('/api/settings/storage'); }

  // Providers
  async getProviders() { return this.fetchJSON('/api/providers'); }
  async createProvider(data: Record<string, unknown>) { return this.fetchJSON('/api/providers', { method: 'POST', body: JSON.stringify(data) }); }
  async deleteProvider(id: string) { return this.fetchJSON(`/api/providers/${id}`, { method: 'DELETE' }); }

  // Upload
  async uploadFile(file: File) {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`${API_URL}/api/upload`, { method: 'POST', headers: { 'Authorization': `Bearer ${this.accessToken}` }, body: formData });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    return res.json();
  }

  // Admin
  async getAdminUsers() { return this.fetchJSON('/api/admin/users'); }
  async updateUserRole(id: string, role: string) { return this.fetchJSON(`/api/admin/users/${id}/role`, { method: 'PUT', body: JSON.stringify({ role }) }); }
  async deleteUser(id: string) { return this.fetchJSON(`/api/admin/users/${id}`, { method: 'DELETE' }); }

  // Event WebSocket

  async createEventSocket(): Promise<WebSocket> {
    const wsUrl = API_URL.replace("http", "ws");
    try {
      const ticket = await this.getWSTicket();
      return new WebSocket(`${wsUrl}/ws/events?ticket=${ticket}`);
    } catch {
      return new WebSocket(`${wsUrl}/ws/events?token=${this.accessToken}`);
    }
  }
}

export const api = new ApiClient();
