package db

import (
	"context"
	"log"
)

var migrations = []string{
	// 001: users
	`CREATE TABLE IF NOT EXISTS users (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		email VARCHAR(255) UNIQUE NOT NULL,
		password_hash VARCHAR(255) NOT NULL,
		name VARCHAR(255) NOT NULL,
		role VARCHAR(20) NOT NULL DEFAULT 'user',
		avatar_url TEXT,
		api_key VARCHAR(255) UNIQUE,
		settings JSONB DEFAULT '{}',
		created_at TIMESTAMPTZ DEFAULT now(),
		updated_at TIMESTAMPTZ DEFAULT now()
	)`,
	// 002: sessions
	`CREATE TABLE IF NOT EXISTS sessions (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		user_id UUID REFERENCES users(id) ON DELETE CASCADE,
		refresh_token VARCHAR(512) NOT NULL,
		expires_at TIMESTAMPTZ NOT NULL,
		created_at TIMESTAMPTZ DEFAULT now()
	)`,
	// 003: conversations
	`CREATE TABLE IF NOT EXISTS conversations (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		user_id UUID REFERENCES users(id) ON DELETE CASCADE,
		title VARCHAR(500),
		model VARCHAR(100),
		agent_id UUID,
		pinned BOOLEAN DEFAULT false,
		created_at TIMESTAMPTZ DEFAULT now(),
		updated_at TIMESTAMPTZ DEFAULT now()
	)`,
	// 004: messages
	`CREATE TABLE IF NOT EXISTS messages (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
		role VARCHAR(20) NOT NULL,
		content TEXT,
		tool_calls JSONB,
		tool_results JSONB,
		tokens_in INTEGER DEFAULT 0,
		tokens_out INTEGER DEFAULT 0,
		model VARCHAR(100),
		created_at TIMESTAMPTZ DEFAULT now()
	)`,
	// 005: memories
	`CREATE TABLE IF NOT EXISTS memories (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		user_id UUID REFERENCES users(id) ON DELETE CASCADE,
		type VARCHAR(50) NOT NULL,
		key VARCHAR(255) NOT NULL,
		content TEXT NOT NULL,
		source_conversation_id UUID,
		created_at TIMESTAMPTZ DEFAULT now(),
		updated_at TIMESTAMPTZ DEFAULT now()
	)`,
	// 006: knowledge_bases
	`CREATE TABLE IF NOT EXISTS knowledge_bases (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		user_id UUID REFERENCES users(id) ON DELETE CASCADE,
		name VARCHAR(255) NOT NULL,
		description TEXT,
		created_at TIMESTAMPTZ DEFAULT now()
	)`,
	// 007: documents
	`CREATE TABLE IF NOT EXISTS documents (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		kb_id UUID REFERENCES knowledge_bases(id) ON DELETE CASCADE,
		filename VARCHAR(500) NOT NULL,
		content_hash VARCHAR(64),
		file_size BIGINT,
		chunks_count INTEGER DEFAULT 0,
		created_at TIMESTAMPTZ DEFAULT now()
	)`,
	// 008: chunks
	`CREATE TABLE IF NOT EXISTS chunks (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
		content TEXT NOT NULL,
		position INTEGER,
		metadata JSONB DEFAULT '{}'
	)`,
	// 009: skills
	`CREATE TABLE IF NOT EXISTS skills (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		name VARCHAR(255) NOT NULL,
		slug VARCHAR(255) UNIQUE NOT NULL,
		description TEXT,
		version VARCHAR(20) DEFAULT '1.0.0',
		author_id UUID REFERENCES users(id),
		config JSONB NOT NULL,
		is_public BOOLEAN DEFAULT false,
		installs_count INTEGER DEFAULT 0,
		created_at TIMESTAMPTZ DEFAULT now(),
		updated_at TIMESTAMPTZ DEFAULT now()
	)`,
	// 010: user_skills
	`CREATE TABLE IF NOT EXISTS user_skills (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		user_id UUID REFERENCES users(id) ON DELETE CASCADE,
		skill_id UUID REFERENCES skills(id) ON DELETE CASCADE,
		settings JSONB DEFAULT '{}',
		installed_at TIMESTAMPTZ DEFAULT now(),
		UNIQUE(user_id, skill_id)
	)`,
	// 011: agents
	`CREATE TABLE IF NOT EXISTS agents (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		user_id UUID REFERENCES users(id) ON DELETE CASCADE,
		name VARCHAR(255) NOT NULL,
		avatar_url TEXT,
		model VARCHAR(100) NOT NULL,
		system_prompt TEXT NOT NULL,
		skills UUID[] DEFAULT '{}',
		tools_allowed TEXT[] DEFAULT '{}',
		memory_scope VARCHAR(20) DEFAULT 'shared',
		is_public BOOLEAN DEFAULT false,
		created_at TIMESTAMPTZ DEFAULT now(),
		updated_at TIMESTAMPTZ DEFAULT now()
	)`,
	// 012: reviews
	`CREATE TABLE IF NOT EXISTS reviews (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		user_id UUID REFERENCES users(id) ON DELETE CASCADE,
		target_type VARCHAR(20) NOT NULL,
		target_id UUID NOT NULL,
		rating INTEGER CHECK (rating >= 1 AND rating <= 5),
		comment TEXT,
		created_at TIMESTAMPTZ DEFAULT now()
	)`,
	// 013: servers
	`CREATE TABLE IF NOT EXISTS servers (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		user_id UUID REFERENCES users(id) ON DELETE CASCADE,
		name VARCHAR(255) NOT NULL,
		host VARCHAR(255) NOT NULL,
		port INTEGER DEFAULT 22,
		username VARCHAR(100) DEFAULT 'root',
		auth_type VARCHAR(20) NOT NULL,
		credentials_encrypted TEXT NOT NULL,
		environment VARCHAR(20) DEFAULT 'dev',
		tags TEXT[] DEFAULT '{}',
		last_connected_at TIMESTAMPTZ,
		created_at TIMESTAMPTZ DEFAULT now()
	)`,
	// 014: server_groups
	`CREATE TABLE IF NOT EXISTS server_groups (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		user_id UUID REFERENCES users(id) ON DELETE CASCADE,
		name VARCHAR(255) NOT NULL,
		server_ids UUID[] DEFAULT '{}'
	)`,
	// 015: audit_logs
	`CREATE TABLE IF NOT EXISTS audit_logs (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		user_id UUID REFERENCES users(id),
		server_id UUID REFERENCES servers(id),
		command TEXT NOT NULL,
		output TEXT,
		exit_code INTEGER,
		executed_at TIMESTAMPTZ DEFAULT now()
	)`,
	// 016: workspaces
	`CREATE TABLE IF NOT EXISTS workspaces (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		user_id UUID REFERENCES users(id) ON DELETE CASCADE,
		name VARCHAR(255) NOT NULL,
		path VARCHAR(500) NOT NULL,
		created_at TIMESTAMPTZ DEFAULT now()
	)`,
	// 017: tool_logs
	`CREATE TABLE IF NOT EXISTS tool_logs (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
		tool_name VARCHAR(100) NOT NULL,
		input JSONB,
		output JSONB,
		duration_ms INTEGER,
		created_at TIMESTAMPTZ DEFAULT now()
	)`,
	// 018: indexes
	`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at)`,
	`CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_memory_user ON memories(user_id, type)`,
	`CREATE INDEX IF NOT EXISTS idx_audit_server ON audit_logs(server_id, executed_at DESC)`,
	// 019: add tool_call_id to messages
	`ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_call_id VARCHAR(255)`,

	// =============================================
	// Phase 2 Migrations
	// =============================================

	// 020: bots
	`CREATE TABLE IF NOT EXISTS bots (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		user_id UUID REFERENCES users(id) ON DELETE CASCADE,
		name VARCHAR(255) NOT NULL,
		default_agent_id UUID REFERENCES agents(id),
		allowed_agent_ids UUID[] DEFAULT '{}',
		channel VARCHAR(50) NOT NULL,
		channel_config JSONB DEFAULT '{}',
		ai_settings JSONB DEFAULT '{}',
		response_settings JSONB DEFAULT '{}',
		access_settings JSONB DEFAULT '{}',
		notification_settings JSONB DEFAULT '{}',
		is_active BOOLEAN DEFAULT true,
		stats JSONB DEFAULT '{}',
		created_at TIMESTAMPTZ DEFAULT now(),
		updated_at TIMESTAMPTZ DEFAULT now()
	)`,

	// 021: contacts
	`CREATE TABLE IF NOT EXISTS contacts (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		user_id UUID REFERENCES users(id) ON DELETE CASCADE,
		name VARCHAR(255),
		avatar_url TEXT,
		tags TEXT[] DEFAULT '{}',
		notes TEXT,
		metadata JSONB DEFAULT '{}',
		first_seen_at TIMESTAMPTZ DEFAULT now(),
		last_seen_at TIMESTAMPTZ DEFAULT now(),
		created_at TIMESTAMPTZ DEFAULT now(),
		updated_at TIMESTAMPTZ DEFAULT now()
	)`,

	// 022: contact_channels
	`CREATE TABLE IF NOT EXISTS contact_channels (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
		channel VARCHAR(50) NOT NULL,
		channel_user_id VARCHAR(255) NOT NULL,
		channel_username VARCHAR(255),
		metadata JSONB DEFAULT '{}',
		UNIQUE(channel, channel_user_id)
	)`,

	// 023: channel_conversations
	`CREATE TABLE IF NOT EXISTS channel_conversations (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		bot_id UUID REFERENCES bots(id) ON DELETE CASCADE,
		contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
		channel VARCHAR(50) NOT NULL,
		channel_chat_id VARCHAR(255),
		current_agent_id UUID REFERENCES agents(id),
		status VARCHAR(20) DEFAULT 'active',
		takeover_by UUID REFERENCES users(id),
		created_at TIMESTAMPTZ DEFAULT now(),
		updated_at TIMESTAMPTZ DEFAULT now()
	)`,

	// 024: channel_messages
	`CREATE TABLE IF NOT EXISTS channel_messages (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		conversation_id UUID REFERENCES channel_conversations(id) ON DELETE CASCADE,
		direction VARCHAR(10) NOT NULL,
		sender_type VARCHAR(20) NOT NULL,
		sender_id VARCHAR(255),
		content TEXT,
		attachments JSONB DEFAULT '[]',
		channel_message_id VARCHAR(255),
		agent_id UUID REFERENCES agents(id),
		tool_calls JSONB,
		tool_results JSONB,
		tokens_in INTEGER DEFAULT 0,
		tokens_out INTEGER DEFAULT 0,
		created_at TIMESTAMPTZ DEFAULT now()
	)`,

	// 025: attachments
	`CREATE TABLE IF NOT EXISTS attachments (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		user_id UUID REFERENCES users(id) ON DELETE CASCADE,
		filename VARCHAR(500) NOT NULL,
		original_name VARCHAR(500) NOT NULL,
		mime_type VARCHAR(100) NOT NULL,
		file_size BIGINT NOT NULL,
		storage_path TEXT NOT NULL,
		extracted_text TEXT,
		width INTEGER,
		height INTEGER,
		created_at TIMESTAMPTZ DEFAULT now()
	)`,

	// 026: model_providers
	`CREATE TABLE IF NOT EXISTS model_providers (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		user_id UUID REFERENCES users(id) ON DELETE CASCADE,
		name VARCHAR(255) NOT NULL,
		api_url TEXT NOT NULL,
		api_key_encrypted TEXT NOT NULL,
		models JSONB DEFAULT '[]',
		is_active BOOLEAN DEFAULT true,
		created_at TIMESTAMPTZ DEFAULT now(),
		updated_at TIMESTAMPTZ DEFAULT now()
	)`,

	// 027: Phase 2 indexes
	`CREATE INDEX IF NOT EXISTS idx_bots_user ON bots(user_id)`,
	`CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id)`,
	`CREATE INDEX IF NOT EXISTS idx_contact_channels_contact ON contact_channels(contact_id)`,
	`CREATE INDEX IF NOT EXISTS idx_channel_conversations_bot ON channel_conversations(bot_id)`,
	`CREATE INDEX IF NOT EXISTS idx_channel_conversations_contact ON channel_conversations(contact_id)`,
	`CREATE INDEX IF NOT EXISTS idx_channel_messages_conversation ON channel_messages(conversation_id, created_at)`,
	`CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id)`,
	`CREATE INDEX IF NOT EXISTS idx_model_providers_user ON model_providers(user_id)`,

	// 028: Phase 2 ALTER TABLE additions
	`ALTER TABLE skills ADD COLUMN IF NOT EXISTS is_system BOOLEAN DEFAULT false`,
	`ALTER TABLE user_skills ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT true`,
	`ALTER TABLE users ADD COLUMN IF NOT EXISTS storage_quota BIGINT DEFAULT 1073741824`,
	`ALTER TABLE users ADD COLUMN IF NOT EXISTS storage_used BIGINT DEFAULT 0`,

	// 029: Unified conversations - add channel fields to conversations and source to messages
	`ALTER TABLE messages ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'web'`,
	`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel_chat_id VARCHAR(255)`,
	`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel VARCHAR(20)`,
	`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS contact_id UUID`,
	`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS bot_id UUID`,
	`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active'`,
	`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS takeover_by UUID`,
	`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS current_agent_id UUID`,
	`CREATE INDEX IF NOT EXISTS idx_conv_channel_chat ON conversations(channel_chat_id) WHERE channel_chat_id IS NOT NULL`,

	// 030: Add attachments column to messages
	`ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments JSONB`,

	// =============================================
	// Phase 3 Migrations - Scheduled Tasks
	// =============================================

	// 031: scheduled_tasks
	`CREATE TABLE IF NOT EXISTS scheduled_tasks (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		user_id UUID REFERENCES users(id) ON DELETE CASCADE,
		agent_id UUID REFERENCES agents(id),
		name VARCHAR(255) NOT NULL,
		description TEXT,
		prompt TEXT NOT NULL,
		schedule VARCHAR(100) NOT NULL,
		schedule_human VARCHAR(255),
		timezone VARCHAR(50) DEFAULT 'Asia/Ho_Chi_Minh',
		delivery_channel VARCHAR(20) NOT NULL,
		delivery_chat_id VARCHAR(255),
		bot_id UUID REFERENCES bots(id),
		is_active BOOLEAN DEFAULT true,
		last_run_at TIMESTAMPTZ,
		next_run_at TIMESTAMPTZ,
		run_count INTEGER DEFAULT 0,
		error_count INTEGER DEFAULT 0,
		max_retries INTEGER DEFAULT 1,
		created_at TIMESTAMPTZ DEFAULT now(),
		updated_at TIMESTAMPTZ DEFAULT now()
	)`,

	// 032: scheduled_tasks indexes
	`CREATE INDEX IF NOT EXISTS idx_tasks_user ON scheduled_tasks(user_id, is_active)`,
	`CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON scheduled_tasks(next_run_at) WHERE is_active = true`,

	// 033: task_runs
	`CREATE TABLE IF NOT EXISTS task_runs (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		task_id UUID REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
		status VARCHAR(20) NOT NULL,
		started_at TIMESTAMPTZ DEFAULT now(),
		finished_at TIMESTAMPTZ,
		result TEXT,
		error TEXT,
		tokens_in INTEGER DEFAULT 0,
		tokens_out INTEGER DEFAULT 0,
		tools_used JSONB DEFAULT '[]',
		created_at TIMESTAMPTZ DEFAULT now()
	)`,

	// 034: task_runs index
	`CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, started_at DESC)`,

	// =============================================
	// Phase 4 Migrations - Intelligent Chat Pipeline
	// =============================================

	// 035: Intelligent Pipeline --- conversation summary + message retry
	`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS summary TEXT`,
	`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS summary_at TIMESTAMPTZ`,
	`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS message_count INTEGER DEFAULT 0`,
	`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS project_id UUID`,
	`ALTER TABLE messages ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0`,

	// 036: Projects
	`CREATE TABLE IF NOT EXISTS projects (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		name VARCHAR(255) NOT NULL,
		description TEXT,
		instructions TEXT,
		icon VARCHAR(50) DEFAULT '📁',
		is_archived BOOLEAN DEFAULT false,
		created_at TIMESTAMPTZ DEFAULT now(),
		updated_at TIMESTAMPTZ DEFAULT now()
	)`,
	`CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id)`,
	`CREATE TABLE IF NOT EXISTS project_files (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
		filename VARCHAR(500) NOT NULL,
		content TEXT,
		file_path VARCHAR(1000),
		file_size BIGINT,
		mime_type VARCHAR(100),
		created_at TIMESTAMPTZ DEFAULT now()
	)`,
	`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_conversations_project' AND table_name = 'conversations') THEN ALTER TABLE conversations ADD CONSTRAINT fk_conversations_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL; END IF; END $$`,
	`CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id)`,

	// 037: Backfill message counts
	`UPDATE conversations SET message_count = sub.cnt FROM (SELECT conversation_id, COUNT(*) as cnt FROM messages GROUP BY conversation_id) sub WHERE conversations.id = sub.conversation_id AND conversations.message_count = 0 AND sub.cnt > 0`,

	// =============================================
	// Phase 5 Migrations - Security & Performance
	// =============================================

	// 038: System settings table (for registration_enabled, etc.)
	`CREATE TABLE IF NOT EXISTS system_settings (
		key VARCHAR(255) PRIMARY KEY,
		value TEXT NOT NULL,
		updated_at TIMESTAMPTZ DEFAULT now()
	)`,
	`INSERT INTO system_settings (key, value) VALUES ('registration_enabled', 'false') ON CONFLICT (key) DO NOTHING`,

	// 039a: User settings table (for fallback_models etc.)
	`CREATE TABLE IF NOT EXISTS user_settings (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		key VARCHAR(255) NOT NULL,
		value TEXT NOT NULL,
		created_at TIMESTAMPTZ DEFAULT now(),
		updated_at TIMESTAMPTZ DEFAULT now(),
		UNIQUE(user_id, key)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_user_settings_user_key ON user_settings(user_id, key)`,

	// 039: Performance indexes
	`CREATE INDEX IF NOT EXISTS idx_messages_conv_role_created ON messages(conversation_id, role, created_at DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_conv_bot_contact_status ON conversations(bot_id, contact_id, status)`,
	`CREATE INDEX IF NOT EXISTS idx_messages_retry ON messages(conversation_id, role, created_at) WHERE retry_count > 0`,

	// =============================================
	// Phase 6 Migrations - SSH Host Key TOFU
	// =============================================

	// 040: SSH host keys for TOFU verification
	`CREATE TABLE IF NOT EXISTS ssh_host_keys (
		host VARCHAR(255) NOT NULL,
		port INTEGER NOT NULL,
		key_type VARCHAR(50) NOT NULL,
		fingerprint VARCHAR(255) NOT NULL,
		raw_key BYTEA NOT NULL,
		first_seen_at TIMESTAMPTZ DEFAULT now(),
		PRIMARY KEY (host, port, key_type)
	)`,

	// 041: Session cleanup indexes
	`CREATE INDEX IF NOT EXISTS idx_sessions_refresh_token ON sessions(refresh_token)`,
	`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,

	// 042: Server chat workspace
	`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS server_id UUID REFERENCES servers(id) ON DELETE SET NULL`,
	`CREATE INDEX IF NOT EXISTS idx_conversations_server ON conversations(server_id) WHERE server_id IS NOT NULL`,

	// =============================================
	// Phase 7 Migrations - File-based Memories
	// =============================================

	// 043: Add file_path column to memories
	`ALTER TABLE memories ADD COLUMN IF NOT EXISTS file_path TEXT`,

	// 044: Unique index on memories(user_id, type, key)
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_user_type_key ON memories(user_id, type, key)`,

	// 045: Message feedback columns
	`ALTER TABLE messages ADD COLUMN IF NOT EXISTS feedback_rating SMALLINT`,
	`ALTER TABLE messages ADD COLUMN IF NOT EXISTS feedback_at TIMESTAMPTZ`,
	`CREATE INDEX IF NOT EXISTS idx_messages_feedback ON messages (conversation_id, feedback_rating) WHERE feedback_rating IS NOT NULL`,

	// =============================================
	// Phase 8 Migrations - Autonomous Agent Engine
	// =============================================

	// 046: Heartbeat config
	`CREATE TABLE IF NOT EXISTS heartbeat_config (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled BOOLEAN DEFAULT true,
    interval_min INT DEFAULT 5,
    quiet_hours_start TIME DEFAULT '23:00',
    quiet_hours_end TIME DEFAULT '07:00',
    max_actions_per_hour INT DEFAULT 20,
    timezone TEXT DEFAULT 'Asia/Ho_Chi_Minh',
    reflection_time TIME DEFAULT '23:00',
    digest_time TIME DEFAULT '21:00',
    delivery_channel TEXT DEFAULT 'telegram',
    delivery_chat_id TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
)`,

	// 047: Action trust
	`CREATE TABLE IF NOT EXISTS action_trust (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action_type TEXT NOT NULL,
    action_pattern TEXT NOT NULL,
    trust_score INT NOT NULL DEFAULT 0,
    approve_count INT DEFAULT 0,
    reject_count INT DEFAULT 0,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, action_type, action_pattern)
)`,

	// 048: Goals
	`CREATE TABLE IF NOT EXISTS goals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'proposed',
    priority TEXT DEFAULT 'medium',
    source TEXT DEFAULT 'bot',
    parent_goal_id UUID REFERENCES goals(id) ON DELETE SET NULL,
    deadline TIMESTAMPTZ,
    progress INT DEFAULT 0,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
)`,

	// 049: Heartbeat runs
	`CREATE TABLE IF NOT EXISTS heartbeat_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    triggers_checked INT DEFAULT 0,
    actions_taken INT DEFAULT 0,
    actions_skipped INT DEFAULT 0,
    tokens_used INT DEFAULT 0,
    summary TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
)`,
	`CREATE INDEX IF NOT EXISTS idx_heartbeat_runs_user_time ON heartbeat_runs(user_id, started_at DESC)`,

	// 050: Autonomous actions
	`CREATE TABLE IF NOT EXISTS autonomous_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    heartbeat_run_id UUID REFERENCES heartbeat_runs(id) ON DELETE SET NULL,
    action_type TEXT NOT NULL,
    action_pattern TEXT NOT NULL,
    description TEXT NOT NULL,
    trust_score_at_time INT,
    status TEXT NOT NULL,
    result TEXT,
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
)`,
	`CREATE INDEX IF NOT EXISTS idx_autonomous_actions_user_time ON autonomous_actions(user_id, created_at DESC)`,

	// 051: Reflections
	`CREATE TABLE IF NOT EXISTS reflections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    lessons JSONB DEFAULT '[]',
    user_insights JSONB DEFAULT '[]',
    prompt_suggestions JSONB DEFAULT '[]',
    goals_progress JSONB DEFAULT '[]',
    detected_patterns JSONB DEFAULT '[]',
    performance_score DECIMAL(3,1),
    raw_output TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, date)
)`,

	// 052: Detected patterns
	`CREATE TABLE IF NOT EXISTS detected_patterns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pattern_type TEXT NOT NULL,
    description TEXT NOT NULL,
    evidence JSONB DEFAULT '[]',
    confidence DECIMAL(3,2) NOT NULL,
    status TEXT DEFAULT 'detected',
    action_taken TEXT,
    task_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
)`,

	// 053: Mood log
	`CREATE TABLE IF NOT EXISTS mood_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    message_id UUID,
    sentiment TEXT,
    urgency TEXT,
    energy TEXT,
    emotion TEXT,
    confidence DECIMAL(3,2),
    created_at TIMESTAMPTZ DEFAULT NOW()
)`,
	`CREATE INDEX IF NOT EXISTS idx_mood_log_user_time ON mood_log(user_id, created_at DESC)`,

	// =============================================
	// Phase 9 Migrations - Cognitive Memory Engine
	// =============================================

	// 054: Unified cognitive embeddings table
	`CREATE TABLE IF NOT EXISTS cognitive_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,
    source_id UUID NOT NULL,
    content_hash TEXT NOT NULL,
    content_preview TEXT NOT NULL,
    embedding vector(1536) NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
)`,
	`CREATE INDEX IF NOT EXISTS idx_cognitive_embeddings_user ON cognitive_embeddings(user_id)`,
	`CREATE INDEX IF NOT EXISTS idx_cognitive_embeddings_source ON cognitive_embeddings(user_id, source_type, source_id)`,
	`CREATE INDEX IF NOT EXISTS idx_cognitive_embeddings_hash ON cognitive_embeddings(user_id, content_hash)`,
	`CREATE INDEX IF NOT EXISTS idx_cognitive_embeddings_vector ON cognitive_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,

	// 055: Cross-reference graph
	`CREATE TABLE IF NOT EXISTS cross_references (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,
    source_id UUID NOT NULL,
    target_type TEXT NOT NULL,
    target_id UUID NOT NULL,
    relation TEXT NOT NULL,
    strength DECIMAL(3,2) DEFAULT 1.0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, source_type, source_id, target_type, target_id, relation)
)`,
	`CREATE INDEX IF NOT EXISTS idx_crossref_source ON cross_references(user_id, source_type, source_id)`,
	`CREATE INDEX IF NOT EXISTS idx_crossref_target ON cross_references(user_id, target_type, target_id)`,

	// 056: Consolidation log
	`CREATE TABLE IF NOT EXISTS consolidation_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    entries_scanned INT DEFAULT 0,
    duplicates_merged INT DEFAULT 0,
    stale_pruned INT DEFAULT 0,
    new_crossrefs INT DEFAULT 0,
    summary TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
)`,

	// 057: Unique index for cognitive upsert
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_cognitive_embeddings_unique_source ON cognitive_embeddings(user_id, source_type, source_id)`,

	// =============================================
	// Phase 10 Migrations - Provider Connections & Model Combos
	// =============================================

	// 058: provider_connections table
	`CREATE TABLE IF NOT EXISTS provider_connections (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		user_id UUID REFERENCES users(id) ON DELETE CASCADE,
		provider_type VARCHAR(30) NOT NULL,
		auth_type VARCHAR(20) DEFAULT 'api_key',
		name VARCHAR(255) NOT NULL,
		priority INT DEFAULT 1,
		api_url TEXT NOT NULL,
		api_format VARCHAR(20) DEFAULT 'openai',
		api_key_encrypted TEXT DEFAULT '',
		access_token_encrypted TEXT DEFAULT '',
		refresh_token_encrypted TEXT DEFAULT '',
		token_expires_at TIMESTAMPTZ,
		oauth_scope TEXT DEFAULT '',
		is_active BOOLEAN DEFAULT true,
		test_status VARCHAR(20) DEFAULT 'unknown',
		error_code INT DEFAULT 0,
		last_error TEXT DEFAULT '',
		last_error_at TIMESTAMPTZ,
		backoff_level INT DEFAULT 0,
		models JSONB DEFAULT '[]',
		provider_data JSONB DEFAULT '{}',
		created_at TIMESTAMPTZ DEFAULT now(),
		updated_at TIMESTAMPTZ DEFAULT now()
	)`,

	// 059: provider_connections indexes
	`CREATE INDEX IF NOT EXISTS idx_provider_connections_user ON provider_connections(user_id)`,
	`CREATE INDEX IF NOT EXISTS idx_provider_connections_type ON provider_connections(user_id, provider_type)`,

	// 060: model_combos table
	`CREATE TABLE IF NOT EXISTS model_combos (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		user_id UUID REFERENCES users(id) ON DELETE CASCADE,
		name VARCHAR(255) NOT NULL,
		models JSONB NOT NULL DEFAULT '[]',
		strategy VARCHAR(20) DEFAULT 'fallback',
		is_active BOOLEAN DEFAULT true,
		created_at TIMESTAMPTZ DEFAULT now(),
		updated_at TIMESTAMPTZ DEFAULT now()
	)`,
	`CREATE INDEX IF NOT EXISTS idx_model_combos_user ON model_combos(user_id)`,

	// 061: migrate existing model_providers data into provider_connections
	`INSERT INTO provider_connections (id, user_id, provider_type, auth_type, name, api_url, api_format, api_key_encrypted, models, is_active, created_at, updated_at)
SELECT id, user_id, 'custom', 'api_key', name, api_url, 'openai', api_key_encrypted, models, is_active, created_at, updated_at
FROM model_providers
ON CONFLICT (id) DO NOTHING`,

	// 062: Add goal_id to scheduled_tasks for goal-task linkage
	`ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS goal_id UUID REFERENCES goals(id) ON DELETE SET NULL`,
	`CREATE INDEX IF NOT EXISTS idx_tasks_goal ON scheduled_tasks(goal_id) WHERE goal_id IS NOT NULL`,

	// 063: Add rotation tracking columns for multi-account support
	`ALTER TABLE provider_connections ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ`,
	`ALTER TABLE provider_connections ADD COLUMN IF NOT EXISTS consecutive_use_count INTEGER DEFAULT 0`,

	// 064: execution plans for multi-step autonomous actions
	`CREATE TABLE IF NOT EXISTS execution_plans (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		user_id UUID NOT NULL REFERENCES users(id),
		goal_id UUID REFERENCES goals(id),
		title TEXT NOT NULL,
		steps JSONB NOT NULL DEFAULT '[]',
		current_step INT NOT NULL DEFAULT 0,
		status VARCHAR(20) NOT NULL DEFAULT 'pending',
		result TEXT,
		created_at TIMESTAMPTZ DEFAULT now(),
		updated_at TIMESTAMPTZ DEFAULT now()
	)`,
	`CREATE INDEX IF NOT EXISTS idx_execution_plans_user_status ON execution_plans(user_id, status)`,

}

func RunMigrations() error {
	ctx := context.Background()
	for i, m := range migrations {
		if _, err := Pool.Exec(ctx, m); err != nil {
			log.Printf("Migration %d failed: %v", i+1, err)
			return err
		}
	}
	log.Printf("Ran %d migrations successfully", len(migrations))
	return nil
}
