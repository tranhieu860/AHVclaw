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
	// 008: chunks (skip vector column for now if pgvector not available)
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
