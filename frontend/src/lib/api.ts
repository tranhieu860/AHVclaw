const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3101";

class ApiClient {
  private accessToken: string | null = null;
  private refreshing: Promise<boolean> | null = null;

  setToken(token: string | null) {
    this.accessToken = token;
  }

  private async tryRefresh(): Promise<boolean> {
    const refreshToken = typeof window !== 'undefined' ? localStorage.getItem('refresh_token') : null;
    if (!refreshToken) return false;
    try {
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      this.accessToken = data.access_token;
      if (typeof window !== 'undefined') {
        localStorage.setItem('access_token', data.access_token);
        localStorage.setItem('refresh_token', data.refresh_token);
      }
      return true;
    } catch {
      return false;
    }
  }

  private async fetchJSON(path: string, options: RequestInit = {}, retry = true): Promise<any> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    };
    if (this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`;
    }
    const res = await fetch(`${API_URL}${path}`, { ...options, headers });
    if (res.status === 401 && retry) {
      if (!this.refreshing) {
        this.refreshing = this.tryRefresh().finally(() => { this.refreshing = null; });
      }
      const ok = await this.refreshing;
      if (ok) {
        return this.fetchJSON(path, options, false);
      }
      if (typeof window !== 'undefined' && !path.includes('/auth/')) {
        window.location.href = '/login';
      }
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  async fetch(path: string, options: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    };
    if (this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`;
    }
    return fetch(`${API_URL}${path}`, { ...options, headers });
  }

  async login(email: string, password: string) {
    return this.fetchJSON("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  }
  async register(email: string, password: string, name: string) {
    return this.fetchJSON("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password, name }) });
  }
  async refreshToken(refreshToken: string) {
    return this.fetchJSON("/api/auth/refresh", { method: "POST", body: JSON.stringify({ refresh_token: refreshToken }) });
  }
  async getMe() { return this.fetchJSON("/api/auth/me"); }
  async getConversations() { return this.fetchJSON("/api/conversations"); }
  async getMessages(conversationId: string) { return this.fetchJSON(`/api/conversations/${conversationId}`); }
  async deleteConversation(conversationId: string) { return this.fetchJSON(`/api/conversations/${conversationId}`, { method: "DELETE" }); }
  async getModels() { return this.fetchJSON("/api/models"); }

  async getWSTicket(): Promise<string> {
    const data = await this.fetchJSON("/api/ws/ticket", { method: "POST" });
    return data.ticket;
  }

  async createChatSocket(): Promise<WebSocket> {
    const wsUrl = API_URL.replace("http", "ws");
    try {
      const ticket = await this.getWSTicket();
      return new WebSocket(`${wsUrl}/ws/chat?ticket=${ticket}`);
    } catch {
      return new WebSocket(`${wsUrl}/ws/chat?token=${this.accessToken}`);
    }
  }

  async createEventSocket(): Promise<WebSocket> {
    const wsUrl = API_URL.replace("http", "ws");
    try {
      const ticket = await this.getWSTicket();
      return new WebSocket(`${wsUrl}/ws/events?ticket=${ticket}`);
    } catch {
      return new WebSocket(`${wsUrl}/ws/events?token=${this.accessToken}`);
    }
  }

  // Bots
  async getBots() { return this.fetchJSON("/api/bots"); }
  async createBot(data: Record<string, unknown>) { return this.fetchJSON("/api/bots", { method: "POST", body: JSON.stringify(data) }); }
  async updateBot(id: string, data: Record<string, unknown>) { return this.fetchJSON(`/api/bots/${id}`, { method: "PUT", body: JSON.stringify(data) }); }
  async deleteBot(id: string) { return this.fetchJSON(`/api/bots/${id}`, { method: "DELETE" }); }
  async startBot(id: string) { return this.fetchJSON(`/api/bots/${id}/start`, { method: "POST" }); }
  async stopBot(id: string) { return this.fetchJSON(`/api/bots/${id}/stop`, { method: "POST" }); }

  // Inbox
  async getInbox(params?: Record<string, string>) { const qs = params ? "?" + new URLSearchParams(params).toString() : ""; return this.fetchJSON(`/api/inbox${qs}`); }
  async getInboxConversation(id: string) { return this.fetchJSON(`/api/inbox/${id}`); }
  async replyToConversation(id: string, content: string) { return this.fetchJSON(`/api/inbox/${id}/reply`, { method: "POST", body: JSON.stringify({ content }) }); }
  async archiveConversation(id: string) { return this.fetchJSON(`/api/inbox/${id}/archive`, { method: "POST" }); }
  async takeoverConversation(id: string) { return this.fetchJSON(`/api/inbox/${id}/takeover`, { method: "POST" }); }
  async releaseConversation(id: string) { return this.fetchJSON(`/api/inbox/${id}/release`, { method: "POST" }); }

  // Contacts
  async getContacts(search?: string) { const qs = search ? `?search=${encodeURIComponent(search)}` : ""; return this.fetchJSON(`/api/contacts${qs}`); }
  async updateContact(id: string, data: Record<string, unknown>) { return this.fetchJSON(`/api/contacts/${id}`, { method: "PUT", body: JSON.stringify(data) }); }
  async deleteContact(id: string) { return this.fetchJSON(`/api/contacts/${id}`, { method: "DELETE" }); }
  async mergeContacts(sourceId: string, targetId: string) { return this.fetchJSON("/api/contacts/merge", { method: "POST", body: JSON.stringify({ source_id: sourceId, target_id: targetId }) }); }

  // Settings
  async getSettings() { return this.fetchJSON("/api/settings"); }
  async updateSettings(data: Record<string, unknown>) { return this.fetchJSON("/api/settings", { method: "PUT", body: JSON.stringify(data) }); }
  async changePassword(oldPw: string, newPw: string) { return this.fetchJSON("/api/settings/password", { method: "POST", body: JSON.stringify({ old_password: oldPw, new_password: newPw }) }); }
  async regenerateApiKey() { return this.fetchJSON("/api/settings/api-key", { method: "POST" }); }
  async getStorage() { return this.fetchJSON("/api/settings/storage"); }

  // Providers (legacy)
  async getProviders() { return this.fetchJSON("/api/providers"); }
  async createProvider(data: Record<string, unknown>) { return this.fetchJSON("/api/providers", { method: "POST", body: JSON.stringify(data) }); }
  async deleteProvider(id: string) { return this.fetchJSON(`/api/providers/${id}`, { method: "DELETE" }); }

  // Upload
  async uploadFile(file: File) {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${API_URL}/api/upload`, { method: "POST", headers: { Authorization: `Bearer ${this.accessToken}` }, body: formData });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    return res.json();
  }

  // Admin
  async getAdminUsers() { return this.fetchJSON("/api/admin/users"); }
  async updateUserRole(id: string, role: string) { return this.fetchJSON(`/api/admin/users/${id}/role`, { method: "PUT", body: JSON.stringify({ role }) }); }
  async deleteUser(id: string) { return this.fetchJSON(`/api/admin/users/${id}`, { method: "DELETE" }); }

  // Projects
  async getProjects() { return this.fetchJSON("/api/projects"); }
  async createProject(data: Record<string, unknown>) { return this.fetchJSON("/api/projects", { method: "POST", body: JSON.stringify(data) }); }
  async getProject(id: string) { return this.fetchJSON(`/api/projects/${id}`); }
  async updateProject(id: string, data: Record<string, unknown>) { return this.fetchJSON(`/api/projects/${id}`, { method: "PUT", body: JSON.stringify(data) }); }
  async deleteProject(id: string) { return this.fetchJSON(`/api/projects/${id}`, { method: "DELETE" }); }
  async uploadProjectFile(id: string, file: File) {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${API_URL}/api/projects/${id}/files`, { method: "POST", headers: { Authorization: `Bearer ${this.accessToken}` }, body: formData });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    return res.json();
  }
  async deleteProjectFile(projectId: string, fileId: string) { return this.fetchJSON(`/api/projects/${projectId}/files/${fileId}`, { method: "DELETE" }); }

  // Autonomous Agent
  async getAutonomousStatus() { return this.fetchJSON("/api/autonomous/status"); }
  async updateAutonomousConfig(data: Record<string, unknown>) { return this.fetchJSON("/api/autonomous/config", { method: "PUT", body: JSON.stringify(data) }); }
  async stopAutonomous() { return this.fetchJSON("/api/autonomous/stop", { method: "POST" }); }
  async resumeAutonomous() { return this.fetchJSON("/api/autonomous/resume", { method: "POST" }); }

  // Goals
  async getGoals() { return this.fetchJSON("/api/goals"); }
  async createGoal(data: Record<string, unknown>) { return this.fetchJSON("/api/goals", { method: "POST", body: JSON.stringify(data) }); }
  async updateGoal(id: string, data: Record<string, unknown>) { return this.fetchJSON(`/api/goals/${id}`, { method: "PUT", body: JSON.stringify(data) }); }
  async deleteGoal(id: string) { return this.fetchJSON(`/api/goals/${id}`, { method: "DELETE" }); }

  // Reflections
  async getReflections() { return this.fetchJSON("/api/reflections"); }
  async getReflection(date: string) { return this.fetchJSON(`/api/reflections/${date}`); }

  // Trust
  async getTrustPermissions() { return this.fetchJSON("/api/trust"); }
  async updateTrustScore(id: string, score: number) { return this.fetchJSON(`/api/trust/${id}`, { method: "PUT", body: JSON.stringify({ trust_score: score }) }); }

  // Patterns
  async getPatterns() { return this.fetchJSON("/api/patterns"); }
  async acceptPattern(id: string) { return this.fetchJSON(`/api/patterns/${id}/accept`, { method: "POST" }); }
  async rejectPattern(id: string) { return this.fetchJSON(`/api/patterns/${id}/reject`, { method: "POST" }); }

  // Knowledge Base
  async getKnowledgeBases() { return this.fetchJSON("/api/knowledge"); }
  async createKnowledgeBase(data: Record<string, unknown>) { return this.fetchJSON("/api/knowledge", { method: "POST", body: JSON.stringify(data) }); }
  async deleteKnowledgeBase(id: string) { return this.fetchJSON(`/api/knowledge/${id}`, { method: "DELETE" }); }
  async getDocuments(kbId: string) { return this.fetchJSON(`/api/knowledge/${kbId}/documents`); }
  async createDocument(kbId: string, data: Record<string, unknown>) { return this.fetchJSON(`/api/knowledge/${kbId}/documents`, { method: "POST", body: JSON.stringify(data) }); }
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

  // Voice / Audio Settings
  async getVoiceSettings(): Promise<any> { return this.fetchJSON("/api/voice/settings"); }
  async updateVoiceSettings(data: Record<string, string>): Promise<any> { return this.fetchJSON("/api/voice/settings", { method: "PUT", body: JSON.stringify(data) }); }
  async testTTS(): Promise<{ success: boolean; audio_b64?: string; format?: string; error?: string }> {
    return this.fetchJSON("/api/voice/test-tts", { method: "POST" });
  }
  async testSTT(audio: Blob, mimeType: string): Promise<{ success: boolean; text?: string; error?: string }> {
    const formData = new FormData();
    formData.append("audio", audio, "recording.webm");
    const headers: Record<string, string> = {};
    if (this.accessToken) headers["Authorization"] = `Bearer ${this.accessToken}`;
    const res = await fetch(`${API_URL}/api/voice/test-stt`, { method: "POST", headers, body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // Connections (Provider Registry)
  async getConnections(): Promise<any[]> { return this.fetchJSON("/api/connections"); }
  async createConnection(data: Record<string, unknown>): Promise<any> { return this.fetchJSON("/api/connections", { method: "POST", body: JSON.stringify(data) }); }
  async updateConnection(id: string, data: Record<string, unknown>): Promise<any> { return this.fetchJSON(`/api/connections/${id}`, { method: "PUT", body: JSON.stringify(data) }); }
  async deleteConnection(id: string): Promise<void> { return this.fetchJSON(`/api/connections/${id}`, { method: "DELETE" }); }
  async testConnection(id: string): Promise<{ success: boolean; message: string }> { return this.fetchJSON(`/api/connections/${id}/test`, { method: "POST" }); }
  async resetConnection(id: string): Promise<void> { return this.fetchJSON(`/api/connections/${id}/reset`, { method: "POST" }); }
  async startOAuth(provider: string): Promise<{ auth_url: string; provider: string; paste_url?: boolean }> { return this.fetchJSON(`/api/oauth/authorize/${provider}`); }
  async fetchRemoteModels(connId: string): Promise<{ models: { id: string; owned_by: string }[]; provider_type: string }> { return this.fetchJSON(`/api/connections/${connId}/models`); }
  async exchangeOAuth(url: string): Promise<{ ok: boolean; provider: string; account: string }> { return this.fetchJSON("/api/oauth/exchange", { method: "POST", body: JSON.stringify({ url }) }); }

  // Combos
  async getCombos(): Promise<any[]> { return this.fetchJSON("/api/combos"); }
  async createCombo(data: Record<string, unknown>): Promise<any> { return this.fetchJSON("/api/combos", { method: "POST", body: JSON.stringify(data) }); }
  async updateCombo(id: string, data: Record<string, unknown>): Promise<any> { return this.fetchJSON(`/api/combos/${id}`, { method: "PUT", body: JSON.stringify(data) }); }
  async deleteCombo(id: string): Promise<void> { return this.fetchJSON(`/api/combos/${id}`, { method: "DELETE" }); }

  // Connection Health
  async getConnectionHealth(): Promise<any[]> { return this.fetchJSON("/api/connections/health"); }

  // Agent Teams
  async getTeams(): Promise<any[]> { return this.fetchJSON("/api/teams"); }
  async createTeam(data: Record<string, unknown>): Promise<any> { return this.fetchJSON("/api/teams", { method: "POST", body: JSON.stringify(data) }); }
  async updateTeam(id: string, data: Record<string, unknown>): Promise<any> { return this.fetchJSON(`/api/teams/${id}`, { method: "PUT", body: JSON.stringify(data) }); }
  async deleteTeam(id: string): Promise<void> { return this.fetchJSON(`/api/teams/${id}`, { method: "DELETE" }); }

  // MCP Bridge
  async getMCPBridges(): Promise<any[]> { return this.fetchJSON("/api/mcp/bridges"); }
  async addMCPBridge(data: { name: string; url: string; api_key?: string }): Promise<any> { return this.fetchJSON("/api/mcp/bridges", { method: "POST", body: JSON.stringify(data) }); }
  async removeMCPBridge(id: string): Promise<void> { return this.fetchJSON(`/api/mcp/bridges/${id}`, { method: "DELETE" }); }
  async getMCPBridgeTools(id: string): Promise<any[]> { return this.fetchJSON(`/api/mcp/bridges/${id}/tools`); }

  // Registry
  async getProviderTypes(): Promise<any[]> { return this.fetchJSON("/api/provider-types"); }
  async getAvailableModels(): Promise<any[]> { return this.fetchJSON("/api/models/available"); }
  // Admin CP endpoints
  async getAdminDashboard() { return this.fetchJSON("/api/admin/dashboard"); }
  async getAdminSystem() { return this.fetchJSON("/api/admin/system"); }
  async getAdminUsersDetailed() { return this.fetchJSON("/api/admin/users/detailed"); }
  async adminCreateUser(data: { email: string; name: string; password: string; role: string }) {
    return this.fetchJSON("/api/admin/users", { method: "POST", body: JSON.stringify(data) });
  }
  async adminUpdateUser(id: string, data: Record<string, unknown>) {
    return this.fetchJSON("/api/admin/users/" + id, { method: "PUT", body: JSON.stringify(data) });
  }
  async getAdminActivity(limit?: number) {
    return this.fetchJSON("/api/admin/activity?limit=" + (limit || 50));
  }
  async getAdminHeartbeat() { return this.fetchJSON("/api/admin/heartbeat"); }
  async getAdminDBStats() { return this.fetchJSON("/api/admin/db-stats"); }
  async getAdminSettings() { return this.fetchJSON("/api/admin/settings"); }
  async updateAdminSetting(key: string, value: string) {
    return this.fetchJSON("/api/admin/settings", { method: "PUT", body: JSON.stringify({ key, value }) });
  }
  async getAdminSecurity() { return this.fetchJSON("/api/admin/security"); }

}

export const api = new ApiClient();