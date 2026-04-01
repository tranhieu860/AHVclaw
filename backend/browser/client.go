package browser

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

var httpClient = &http.Client{Timeout: 60 * time.Second}

const playwrightURL = "http://127.0.0.1:3102"

type BrowserRequest struct {
	Action   string `json:"action"`
	UserID   string `json:"userId"`
	URL      string `json:"url,omitempty"`
	Selector string `json:"selector,omitempty"`
	Text     string `json:"text,omitempty"`
	Key      string `json:"key,omitempty"`
	Script   string `json:"script,omitempty"`
}

type BrowserResult struct {
	URL     string `json:"url,omitempty"`
	Title   string `json:"title,omitempty"`
	Image   string `json:"image,omitempty"`
	Content string `json:"content,omitempty"`
	Clicked string `json:"clicked,omitempty"`
	Typed   string `json:"typed,omitempty"`
	Pressed string `json:"pressed,omitempty"`
	Result  string `json:"result,omitempty"`
	Active  bool   `json:"active,omitempty"`
	Closed  bool   `json:"closed,omitempty"`
	Error   string `json:"error,omitempty"`
}

func Execute(req BrowserRequest) (*BrowserResult, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}

	resp, err := httpClient.Post(playwrightURL, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("playwright server unavailable: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var result BrowserResult
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, err
	}

	if result.Error != "" {
		return nil, fmt.Errorf("%s", result.Error)
	}

	return &result, nil
}
