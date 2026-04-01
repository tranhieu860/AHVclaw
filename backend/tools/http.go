package tools

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var blockedCIDRs = []string{
	"10.0.0.0/8",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"::1/128",
	"fc00::/7",
	"fe80::/10",
}

func isBlockedIP(host string) bool {
	// Remove port if present
	hostname := host
	if h, _, err := net.SplitHostPort(host); err == nil {
		hostname = h
	}

	ips, err := net.LookupIP(hostname)
	if err != nil {
		return true // Block if we can't resolve
	}

	for _, ip := range ips {
		for _, cidr := range blockedCIDRs {
			_, network, _ := net.ParseCIDR(cidr)
			if network.Contains(ip) {
				return true
			}
		}
	}
	return false
}

func (e *Executor) httpRequest(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		URL     string            `json:"url"`
		Method  string            `json:"method"`
		Headers map[string]string `json:"headers"`
		Body    string            `json:"body"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "http_request", Error: "invalid arguments"}
	}
	if args.URL == "" {
		return &ToolResult{Name: "http_request", Error: "url is required"}
	}
	if args.Method == "" {
		args.Method = "GET"
	}

	// Validate URL and check for SSRF
	parsed, err := url.Parse(args.URL)
	if err != nil {
		return &ToolResult{Name: "http_request", Error: "invalid URL"}
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return &ToolResult{Name: "http_request", Error: "only http/https URLs allowed"}
	}
	if isBlockedIP(parsed.Host) {
		return &ToolResult{Name: "http_request", Error: "access to internal/private IPs is blocked"}
	}

	client := &http.Client{Timeout: 30 * time.Second}
	var bodyReader io.Reader
	if args.Body != "" {
		bodyReader = strings.NewReader(args.Body)
	}

	req, err := http.NewRequest(strings.ToUpper(args.Method), args.URL, bodyReader)
	if err != nil {
		return &ToolResult{Name: "http_request", Error: err.Error()}
	}

	for k, v := range args.Headers {
		req.Header.Set(k, v)
	}

	resp, err := client.Do(req)
	if err != nil {
		return &ToolResult{Name: "http_request", Error: err.Error()}
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 50*1024))

	return &ToolResult{
		Name:    "http_request",
		Content: fmt.Sprintf("Status: %d\n\n%s", resp.StatusCode, string(respBody)),
	}
}
