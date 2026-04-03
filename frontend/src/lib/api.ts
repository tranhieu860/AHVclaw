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
  async archiveConversation(id: string) { return this.fetchJSON(`/api/inbox/${id}/archive`, { method: 'POST' }); }
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


  // Projects
  async getProjects() { return this.fetchJSON("/api/projects"); }
  async createProject(data: Record<string, unknown>) { return this.fetchJSON("/api/projects", { method: "POST", body: JSON.stringify(data) }); }
  async getProject(id: string) { return this.fetchJSON(`/api/projects/${id}`); }
  async updateProject(id: string, data: Record<string, unknown>) { return this.fetchJSON(`/api/projects/${id}`, { method: "PUT", body: JSON.stringify(data) }); }
  async deleteProject(id: string) { return this.fetchJSON(`/api/projects/${id}`, { method: "DELETE" }); }
  async uploadProjectFile(id: string, file: File) {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${API_URL}/api/projects/${id}/files`, { method: "POST", headers: { "Authorization": `Bearer ${this.accessToken}` }, body: formData });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    return res.json();
  }
  async deleteProjectFile(projectId: string, fileId: string) { return this.fetchJSON(`/api/projects/${projectId}/files/${fileId}`, { method: "DELETE" }); }


  // Autonomous Agent
  async getAutonomousStatus() { return this.fetchJSON('/api/autonomous/status'); }
  async updateAutonomousConfig(data: Record<string, unknown>) { return this.fetchJSON('/api/autonomous/config', { method: 'PUT', body: JSON.stringify(data) }); }
  async stopAutonomous() { return this.fetchJSON('/api/autonomous/stop', { method: 'POST' }); }
  async resumeAutonomous() { return this.fetchJSON('/api/autonomous/resume', { method: 'POST' }); }

  // Goals
  async getGoals() { return this.fetchJSON('/api/goals'); }
  async createGoal(data: Record<string, unknown>) { return this.fetchJSON('/api/goals', { method: 'POST', body: JSON.stringify(data) }); }
  async updateGoal(id: string, data: Record<string, unknown>) { return this.fetchJSON(`/api/goals/${id}`, { method: 'PUT', body: JSON.stringify(data) }); }
  async deleteGoal(id: string) { return this.fetchJSON(`/api/goals/${id}`, { method: 'DELETE' }); }

  // Reflections
  async getReflections() { return this.fetchJSON('/api/reflections'); }
  async getReflection(date: string) { return this.fetchJSON(`/api/reflections/${date}`); }

  // Trust
  async getTrustPermissions() { return this.fetchJSON('/api/trust'); }
  async updateTrustScore(id: string, score: number) { return this.fetchJSON(`/api/trust/${id}`, { method: 'PUT', body: JSON.stringify({ trust_score: score }) }); }

  // Patterns
  async getPatterns() { return this.fetchJSON('/api/patterns'); }
  async acceptPattern(id: string) { return this.fetchJSON(`/api/patterns/${id}/accept`, { method: 'POST' }); }
  async rejectPattern(id: string) { return this.fetchJSON(`/api/patterns/${id}/reject`, { method: 'POST' }); }

  // Knowledge Base
  async getKnowledgeBases() { return this.fetchJSON('/api/knowledge'); }
  async createKnowledgeBase(data: Record<string, unknown>) { return this.fetchJSON('/api/knowledge', { method: 'POST', body: JSON.stringify(data) }); }
  async deleteKnowledgeBase(id: string) { return this.fetchJSON(`/api/knowledge/${id}`, { method: 'DELETE' }); }
  async getDocuments(kbId: string) { return this.fetchJSON(`/api/knowledge/${kbId}/documents`); }
  async createDocument(kbId: string, data: Record<string, unknown>) { return this.fetchJSON(`/api/knowledge/${kbId}/documents`, { method: 'POST', body: JSON.stringify(data) }); }
  async searchKnowledgeBase(kbId: string, query: string) { return this.fetchJSON(`/api/knowledge/${kbId}/search?q=${encodeURIComponent(query)}`); }


  // Cognitive Memory
  async cognitiveSearch(query: string, sourceType?: string, after?: string, before?: string) {
    const params = new URLSearchParams({ q: query });
    if (sourceType) params.set("source_type", sourceType);
    if (after) params.set("after", after);
    if (before) params.set("before", before);
    return this.fetchJSON(`/api/cognitive/search?${params}`);
  }
  async cognitiveStats() { return this.fetchJSON("/api/cognitive/stats"); }
  async cognitiveGraph(sourceType: string, sourceId: string) {
    return this.fetchJSON(`/api/cognitive/graph?source_type=${sourceType}&source_id=${sourceId}`);
  }
  async cognitiveBackfill() { return this.fetchJSON("/api/cognitive/backfill", { method: "POST" }); }
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
