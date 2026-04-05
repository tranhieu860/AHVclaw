package ssh

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"net"
	"time"

	"github.com/ahvholding/ahvclaw/db"
	"golang.org/x/crypto/ssh"
)

type SSHClient struct {
	Host     string
	Port     int
	Username string
	Password string
}

func NewClient(host string, port int, username, password string) *SSHClient {
	return &SSHClient{
		Host:     host,
		Port:     port,
		Username: username,
		Password: password,
	}
}

func (c *SSHClient) Execute(command string) (string, int, error) {
	port := c.Port

	config := &ssh.ClientConfig{
		User: c.Username,
		Auth: []ssh.AuthMethod{
			ssh.Password(c.Password),
		},
		HostKeyCallback: func(hostname string, remote net.Addr, key ssh.PublicKey) error {
			fingerprint := ssh.FingerprintSHA256(key)
			keyType := key.Type()

			// Check if we have a stored key for this host
			var storedFingerprint string
			err := db.Pool.QueryRow(context.Background(),
				"SELECT fingerprint FROM ssh_host_keys WHERE host=$1 AND port=$2 AND key_type=$3",
				hostname, port, keyType).Scan(&storedFingerprint)

			if err != nil {
				// First connection - store the key (trust on first use / TOFU)
				log.Printf("[ssh] TOFU: storing host key for %s:%d (%s): %s", hostname, port, keyType, fingerprint)
				_, insertErr := db.Pool.Exec(context.Background(),
					`INSERT INTO ssh_host_keys (host, port, key_type, fingerprint, raw_key, first_seen_at)
					 VALUES ($1, $2, $3, $4, $5, now()) ON CONFLICT DO NOTHING`,
					hostname, port, keyType, fingerprint, key.Marshal())
				if insertErr != nil {
					log.Printf("[ssh] failed to store host key: %v", insertErr)
				}
				return nil
			}

			// Verify against stored key
			if storedFingerprint != fingerprint {
				return fmt.Errorf("SSH host key mismatch for %s:%d (%s): expected %s, got %s",
					hostname, port, keyType, storedFingerprint, fingerprint)
			}
			return nil
		},
		Timeout: 10 * time.Second,
	}

	addr := fmt.Sprintf("%s:%d", c.Host, c.Port)
	conn, err := ssh.Dial("tcp", addr, config)
	if err != nil {
		return "", -1, fmt.Errorf("failed to connect: %w", err)
	}
	defer conn.Close()

	session, err := conn.NewSession()
	if err != nil {
		return "", -1, fmt.Errorf("failed to create session: %w", err)
	}
	defer session.Close()

	var stdout, stderr bytes.Buffer
	session.Stdout = &stdout
	session.Stderr = &stderr

	exitCode := 0
	if err := session.Run(command); err != nil {
		if exitErr, ok := err.(*ssh.ExitError); ok {
			exitCode = exitErr.ExitStatus()
		} else {
			return "", -1, err
		}
	}

	output := stdout.String()
	if stderr.Len() > 0 {
		output += "\n" + stderr.String()
	}

	if len(output) > 100000 {
		output = output[:100000] + "\n...(truncated)"
	}

	return output, exitCode, nil
}

func (c *SSHClient) GetStatus() (string, error) {
	output, _, err := c.Execute("echo 'CPU:' && top -bn1 | head -3 && echo '---MEMORY---' && free -h && echo '---DISK---' && df -h / && echo '---UPTIME---' && uptime")
	if err != nil {
		return "", err
	}
	return output, nil
}
