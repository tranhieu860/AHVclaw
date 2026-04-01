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
