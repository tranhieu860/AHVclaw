package ssh

import (
	"bytes"
	"fmt"
	"time"

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
	config := &ssh.ClientConfig{
		User: c.Username,
		Auth: []ssh.AuthMethod{
			ssh.Password(c.Password),
		},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         10 * time.Second,
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
