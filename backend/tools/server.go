package tools

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/ahvholding/ahvclaw/crypto"
	"github.com/ahvholding/ahvclaw/db"
	sshpkg "github.com/ahvholding/ahvclaw/ssh"
)

func (e *Executor) serverSSHExec(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		ServerName string `json:"server_name"`
		Command    string `json:"command"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "server_ssh_exec", Error: "invalid arguments"}
	}
	if args.ServerName == "" || args.Command == "" {
		return &ToolResult{Name: "server_ssh_exec", Error: "server_name and command are required"}
	}

	var host, username, credentials string
	var port int
	err := db.Pool.QueryRow(context.Background(),
		"SELECT host, port, username, credentials_encrypted FROM servers WHERE user_id = $1 AND name ILIKE $2",
		e.UserID, args.ServerName).Scan(&host, &port, &username, &credentials)
	if err != nil {
		return &ToolResult{Name: "server_ssh_exec", Error: fmt.Sprintf("server '%s' not found", args.ServerName)}
	}

	// Decrypt credentials
	decryptedCreds, err := crypto.Decrypt(credentials)
	if err != nil {
		return &ToolResult{Name: "server_ssh_exec", Error: "decryption failed"}
	}

	client := sshpkg.NewClient(host, port, username, decryptedCreds)
	output, exitCode, err := client.Execute(args.Command)
	if err != nil {
		return &ToolResult{Name: "server_ssh_exec", Error: err.Error()}
	}

	return &ToolResult{
		Name:    "server_ssh_exec",
		Content: fmt.Sprintf("Exit code: %d\n\n%s", exitCode, output),
	}
}

func (e *Executor) serverStatus(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		ServerName string `json:"server_name"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "server_status", Error: "invalid arguments"}
	}
	if args.ServerName == "" {
		return &ToolResult{Name: "server_status", Error: "server_name is required"}
	}

	var host, username, credentials string
	var port int
	err := db.Pool.QueryRow(context.Background(),
		"SELECT host, port, username, credentials_encrypted FROM servers WHERE user_id = $1 AND name ILIKE $2",
		e.UserID, args.ServerName).Scan(&host, &port, &username, &credentials)
	if err != nil {
		return &ToolResult{Name: "server_status", Error: fmt.Sprintf("server '%s' not found", args.ServerName)}
	}

	// Decrypt credentials
	decryptedCreds, err := crypto.Decrypt(credentials)
	if err != nil {
		return &ToolResult{Name: "server_status", Error: "decryption failed"}
	}

	client := sshpkg.NewClient(host, port, username, decryptedCreds)
	status, err := client.GetStatus()
	if err != nil {
		return &ToolResult{Name: "server_status", Error: err.Error()}
	}

	return &ToolResult{Name: "server_status", Content: status}
}

func (e *Executor) serverList(argsJSON json.RawMessage) *ToolResult {
	rows, err := db.Pool.Query(context.Background(),
		"SELECT name, host, port, environment, status FROM servers WHERE user_id = $1 ORDER BY name", e.UserID)
	if err != nil {
		return &ToolResult{Name: "server_list", Error: err.Error()}
	}
	defer rows.Close()

	var result string
	count := 0
	for rows.Next() {
		var name, host, env, status string
		var port int
		if err := rows.Scan(&name, &host, &port, &env, &status); err != nil {
			continue
		}
		count++
		result += fmt.Sprintf("%d. %s — %s:%d [%s] (%s)\n", count, name, host, port, env, status)
	}
	if count == 0 {
		return &ToolResult{Name: "server_list", Content: "No servers registered."}
	}
	return &ToolResult{Name: "server_list", Content: fmt.Sprintf("Found %d server(s):\n\n%s", count, result)}
}
