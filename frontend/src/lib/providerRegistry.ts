export interface ProviderTypeDef {
  type: string
  name: string
  default_url: string
  api_format: string
  auth_types: string[]
  known_models: string[]
  icon: string
  description: string
}

export interface ProviderConnection {
  id: string
  user_id: string
  provider_type: string
  auth_type: string
  name: string
  priority: number
  api_url: string
  api_format: string
  token_expires_at: string | null
  is_active: boolean
  test_status: string
  error_code: number
  last_error: string
  last_error_at: string | null
  backoff_level: number
  models: string
  provider_data: string | null
  created_at: string
  updated_at: string
}

export interface ModelCombo {
  id: string
  user_id: string
  name: string
  models: string
  strategy: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface AvailableModel {
  id: string
  name: string
  provider_type: string
  source: string
  connection?: string
}

export const PROVIDER_ICONS: Record<string, string> = {
  openai: '🟢',
  anthropic: '🟠',
  gemini: '🔵',
  minimax: '⚡',
  'minimax-anthropic': '⚡',
  deepseek: '🌊',
  glm: '🔮',
  'claude-proxy': '🤖',
  '9router': '🔀',
  custom: '⚙️',
}

export const PROVIDER_COLORS: Record<string, string> = {
  openai: '#10a37f',
  anthropic: '#d97757',
  gemini: '#4285f4',
  minimax: '#ff6b35',
  'minimax-anthropic': '#ff6b35',
  deepseek: '#0ea5e9',
  glm: '#8b5cf6',
  'claude-proxy': '#d97757',
  '9router': '#6366f1',
  custom: '#6b7280',
}

export function getStatusColor(status: string): string {
  switch (status) {
    case 'active': return 'text-green-400'
    case 'unavailable': return 'text-red-400'
    case 'error': return 'text-red-400'
    case 'pending': return 'text-yellow-400'
    default: return 'text-zinc-500'
  }
}

export function getStatusDot(status: string): string {
  switch (status) {
    case 'active': return '🟢'
    case 'unavailable': return '🔴'
    case 'error': return '🔴'
    case 'pending': return '🟡'
    default: return '⚪'
  }
}

export function parseModels(raw: unknown): string[] {
  if (!raw) return [];
  // Handle string (JSON-encoded)
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((m): m is string => typeof m === 'string');
      return [];
    } catch {
      return raw.split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  // Handle array directly (from JSONB)
  if (Array.isArray(raw)) {
    return raw.filter((m): m is string => typeof m === 'string');
  }
  return [];
}
