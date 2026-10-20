package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"
)

const (
	testOrigin     = "http://127.0.0.1:8080"
	testToken      = "secret-token-test-123"
	testInstanceID = "11111111-2222-3333-4444-555555555555"
)

type testEnv struct {
	gateway        http.Handler
	discoveryPath  string
	upstreamServer *httptest.Server
	upstreamURL    string
}

func setupTestEnv(t *testing.T, upstreamHandler http.Handler, mutateDiscovery func(d *Discovery)) *testEnv {
	t.Helper()

	ts := httptest.NewServer(upstreamHandler)
	t.Cleanup(ts.Close)

	d := Discovery{
		Version:    3,
		InstanceID: testInstanceID,
		URL:        ts.URL,
		Token:      testToken,
	}
	if mutateDiscovery != nil {
		mutateDiscovery(&d)
	}

	discData, err := json.Marshal(d)
	if err != nil {
		t.Fatalf("failed to marshal discovery: %v", err)
	}

	discPath := filepath.Join(t.TempDir(), "stable.json")
	if err := os.WriteFile(discPath, discData, 0o600); err != nil {
		t.Fatalf("failed to write discovery: %v", err)
	}

	assets := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<!DOCTYPE html><html><body>Whiteboard</body></html>")},
		"app.js":     &fstest.MapFile{Data: []byte("console.log('mobile-whiteboard');")},
	}

	gw, err := NewGateway(Options{
		Origin:        testOrigin,
		Listen:        "127.0.0.1:8080",
		DiscoveryPath: discPath,
		Assets:        assets,
		Client:        ts.Client(),
	})
	if err != nil {
		t.Fatalf("failed to create gateway: %v", err)
	}

	return &testEnv{
		gateway:        gw,
		discoveryPath:  discPath,
		upstreamServer: ts,
		upstreamURL:    ts.URL,
	}
}

func TestHostAndOriginSecurity(t *testing.T) {
	env := setupTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	}), nil)

	tests := []struct {
		name       string
		method     string
		path       string
		host       string
		origin     string
		fwdHost    string
		fetchSite  string
		wantStatus int
	}{
		{
			name:       "valid host and matching origin",
			method:     http.MethodGet,
			path:       "/api/reviews",
			host:       "127.0.0.1:8080",
			origin:     testOrigin,
			wantStatus: http.StatusOK,
		},
		{
			name:       "valid host missing origin on safe GET permitted",
			method:     http.MethodGet,
			path:       "/api/reviews",
			host:       "127.0.0.1:8080",
			origin:     "",
			wantStatus: http.StatusOK,
		},
		{
			name:       "wrong host header rejected",
			method:     http.MethodGet,
			path:       "/api/reviews",
			host:       "attacker.com:8080",
			origin:     testOrigin,
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "unexpected forwarded host rejected",
			method:     http.MethodGet,
			path:       "/api/reviews",
			host:       "127.0.0.1:8080",
			fwdHost:    "spoofed.com",
			origin:     testOrigin,
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "cross-site fetch rejected",
			method:     http.MethodGet,
			path:       "/api/reviews",
			host:       "127.0.0.1:8080",
			origin:     testOrigin,
			fetchSite:  "cross-site",
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "mismatched origin on GET rejected",
			method:     http.MethodGet,
			path:       "/api/reviews",
			host:       "127.0.0.1:8080",
			origin:     "http://evil.com",
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "missing origin on PUT rejected",
			method:     http.MethodPut,
			path:       "/api/reviews/rev-1/markdown/b-1",
			host:       "127.0.0.1:8080",
			origin:     "",
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "mismatched origin on PUT rejected",
			method:     http.MethodPut,
			path:       "/api/reviews/rev-1/markdown/b-1",
			host:       "127.0.0.1:8080",
			origin:     "http://evil.com",
			wantStatus: http.StatusForbidden,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, nil)
			req.Host = tc.host
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			if tc.fwdHost != "" {
				req.Header.Set("X-Forwarded-Host", tc.fwdHost)
			}
			if tc.fetchSite != "" {
				req.Header.Set("Sec-Fetch-Site", tc.fetchSite)
			}

			rec := httptest.NewRecorder()
			env.gateway.ServeHTTP(rec, req)

			if rec.Code != tc.wantStatus {
				t.Fatalf("expected status %d, got %d (body: %s)", tc.wantStatus, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestIncomingCredentialsAndUnknownRoutes(t *testing.T) {
	env := setupTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`[]`))
	}), nil)

	t.Run("incoming x-review-token rejected", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/reviews", nil)
		req.Host = "127.0.0.1:8080"
		req.Header.Set("X-Review-Token", "incoming-secret")
		rec := httptest.NewRecorder()
		env.gateway.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for incoming x-review-token, got %d", rec.Code)
		}
	})

	t.Run("incoming authorization header rejected", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/reviews", nil)
		req.Host = "127.0.0.1:8080"
		req.Header.Set("Authorization", "Bearer incoming-secret")
		rec := httptest.NewRecorder()
		env.gateway.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for incoming authorization header, got %d", rec.Code)
		}
	})

	t.Run("incoming token query param rejected", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/reviews?token=incoming-secret", nil)
		req.Host = "127.0.0.1:8080"
		rec := httptest.NewRecorder()
		env.gateway.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for incoming token query, got %d", rec.Code)
		}
	})

	unknownRoutes := []string{
		"/commands",
		"/agent",
		"/control",
		"/api/commands",
		"/api/agent",
		"/api/control",
		"/api/unknown",
		"/api/reviews/rev-1/unknown",
		"/api/reviews/rev-1/file/extra",
	}
	for _, route := range unknownRoutes {
		t.Run("unknown route "+route, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, route, nil)
			req.Host = "127.0.0.1:8080"
			rec := httptest.NewRecorder()
			env.gateway.ServeHTTP(rec, req)
			if rec.Code != http.StatusNotFound {
				t.Fatalf("expected 404 for unknown route %q, got %d", route, rec.Code)
			}
		})
	}

	traversalRoutes := []string{
		"/api/reviews/%2e%2e/file",
		"/api/reviews/rev%2f1/file",
		"/api/reviews/rev%5c1/file",
		"/api/reviews/rev%001/file",
	}
	for _, tr := range traversalRoutes {
		t.Run("encoded traversal "+tr, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tr, nil)
			req.Host = "127.0.0.1:8080"
			rec := httptest.NewRecorder()
			env.gateway.ServeHTTP(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400 for traversal route %q, got %d", tr, rec.Code)
			}
		})
	}
}

func TestDiscoveryValidationAndRedirectPrevention(t *testing.T) {
	t.Run("missing discovery file returns 502", func(t *testing.T) {
		gw, err := NewGateway(Options{
			Origin:        testOrigin,
			Listen:        "127.0.0.1:8080",
			DiscoveryPath: "/nonexistent/path/to/stable.json",
		})
		if err != nil {
			t.Fatalf("failed to create gateway: %v", err)
		}
		req := httptest.NewRequest(http.MethodGet, "/api/reviews", nil)
		req.Host = "127.0.0.1:8080"
		rec := httptest.NewRecorder()
		gw.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("expected 502 for missing discovery file, got %d", rec.Code)
		}
	})

	t.Run("malformed discovery version returns 502", func(t *testing.T) {
		env := setupTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}), func(d *Discovery) {
			d.Version = 2
		})
		req := httptest.NewRequest(http.MethodGet, "/api/reviews", nil)
		req.Host = "127.0.0.1:8080"
		rec := httptest.NewRecorder()
		env.gateway.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("expected 502 for unsupported desktop discovery version, got %d", rec.Code)
		}
	})

	t.Run("non-loopback discovery url returns 502", func(t *testing.T) {
		env := setupTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}), func(d *Discovery) {
			d.URL = "http://192.168.1.50:8080"
		})
		req := httptest.NewRequest(http.MethodGet, "/api/reviews", nil)
		req.Host = "127.0.0.1:8080"
		rec := httptest.NewRecorder()
		env.gateway.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("expected 502 for non-loopback url, got %d", rec.Code)
		}
	})

	t.Run("redirect prevention on upstream response", func(t *testing.T) {
		env := setupTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/reviews-api" {
				http.Redirect(w, r, "/elsewhere", http.StatusFound)
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`"reached elsewhere"`))
		}), nil)

		req := httptest.NewRequest(http.MethodGet, "/api/reviews", nil)
		req.Host = "127.0.0.1:8080"
		rec := httptest.NewRecorder()
		env.gateway.ServeHTTP(rec, req)

		if rec.Code != http.StatusBadGateway {
			t.Fatalf("expected 502 (redirect not followed), got %d", rec.Code)
		}
	})
}

func TestUpstreamTokenAttachmentAndSecurityHeaders(t *testing.T) {
	var receivedToken, receivedClientHeader string
	env := setupTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedToken = r.Header.Get("X-Review-Token")
		receivedClientHeader = r.Header.Get("X-Review-Client")

		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Set-Cookie", "session=12345; Path=/")
		w.Header().Set("Location", "/redirect")
		w.Header().Set("X-Review-Token", testToken)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`[{"reviewId":"r1","title":"Test"}]`))
	}), nil)

	req := httptest.NewRequest(http.MethodGet, "/api/reviews", nil)
	req.Host = "127.0.0.1:8080"
	rec := httptest.NewRecorder()
	env.gateway.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	if receivedToken != testToken {
		t.Fatalf("expected upstream to receive discovery token %q, got %q", testToken, receivedToken)
	}
	if receivedClientHeader != "remote" {
		t.Fatalf("expected upstream to receive x-review-client remote, got %q", receivedClientHeader)
	}

	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Error("Access-Control-Allow-Origin was leaked to browser")
	}
	if rec.Header().Get("Set-Cookie") != "" {
		t.Error("Set-Cookie was leaked to browser")
	}
	if rec.Header().Get("Location") != "" {
		t.Error("Location header was leaked to browser")
	}
	if rec.Header().Get("X-Review-Token") != "" {
		t.Error("X-Review-Token was leaked to browser")
	}

	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("expected Cache-Control: no-store, got %q", rec.Header().Get("Cache-Control"))
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Errorf("expected X-Content-Type-Options: nosniff, got %q", rec.Header().Get("X-Content-Type-Options"))
	}
	if rec.Header().Get("X-Frame-Options") != "DENY" {
		t.Errorf("expected X-Frame-Options: DENY, got %q", rec.Header().Get("X-Frame-Options"))
	}
	if !strings.Contains(rec.Header().Get("Content-Security-Policy"), "script-src 'self'") {
		t.Errorf("expected CSP to contain script-src 'self', got %q", rec.Header().Get("Content-Security-Policy"))
	}
	for _, directive := range strings.Split(rec.Header().Get("Content-Security-Policy"), ";") {
		if strings.HasPrefix(strings.TrimSpace(directive), "script-src ") && strings.Contains(directive, "'unsafe-inline'") {
			t.Error("CSP must block inline scripts")
		}
	}
}

func TestMarkdownSave_ValidNestedEnvelope(t *testing.T) {
	var commandsCalled atomic.Bool
	var commandPayload map[string]any

	env := setupTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/reviews-api/rev-1" {
			snap := map[string]any{
				"reviewId": "rev-1",
				"version":  2,
				"title":    "Nested Doc",
				"document": []any{
					map[string]any{
						"type":  "section",
						"id":    "sec-1",
						"title": "Outer Section",
						"children": []any{
							map[string]any{
								"type":  "section",
								"id":    "sec-2",
								"title": "Inner Section",
								"children": []any{
									map[string]any{
										"type":     "markdown",
										"id":       "block-target",
										"markdown": "old text",
									},
								},
							},
						},
					},
				},
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(snap)
			return
		}

		if r.Method == http.MethodPost && r.URL.Path == "/reviews-api/commands" {
			commandsCalled.Store(true)
			_ = json.NewDecoder(r.Body).Decode(&commandPayload)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"reviewId":"rev-1","version":3,"targetId":"block-target","type":"update"}`))
			return
		}

		w.WriteHeader(http.StatusNotFound)
	}), nil)

	body := `{"version": 2, "markdown": "updated text content"}`
	req := httptest.NewRequest(http.MethodPut, "/api/reviews/rev-1/markdown/block-target", strings.NewReader(body))
	req.Host = "127.0.0.1:8080"
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	env.gateway.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d (body: %s)", rec.Code, rec.Body.String())
	}
	if !commandsCalled.Load() {
		t.Fatal("expected POST /reviews-api/commands to be called")
	}

	op, ok := commandPayload["operation"].(map[string]any)
	if !ok {
		t.Fatalf("malformed operation payload: %+v", commandPayload)
	}
	if op["type"] != "edit" || op["reviewId"] != "rev-1" {
		t.Fatalf("unexpected operation header: %+v", op)
	}
	edit, ok := op["edit"].(map[string]any)
	if !ok || edit["type"] != "update" || edit["targetId"] != "block-target" {
		t.Fatalf("unexpected edit struct: %+v", edit)
	}
	changes, ok := edit["changes"].(map[string]any)
	if !ok || changes["markdown"] != "updated text content" {
		t.Fatalf("unexpected changes payload: %+v", changes)
	}
}

func TestMarkdownSave_ConflictNoPost(t *testing.T) {
	var commandsCalled atomic.Bool

	env := setupTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/reviews-api/rev-1" {
			snap := map[string]any{
				"reviewId": "rev-1",
				"version":  5,
				"title":    "Doc",
				"document": []any{
					map[string]any{
						"type":     "markdown",
						"id":       "block-1",
						"markdown": "text",
					},
				},
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(snap)
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == "/reviews-api/commands" {
			commandsCalled.Store(true)
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}), nil)

	body := `{"version": 4, "markdown": "conflict text"}`
	req := httptest.NewRequest(http.MethodPut, "/api/reviews/rev-1/markdown/block-1", strings.NewReader(body))
	req.Host = "127.0.0.1:8080"
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	env.gateway.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 Conflict, got %d", rec.Code)
	}
	if commandsCalled.Load() {
		t.Fatal("upstream POST /reviews-api/commands MUST NOT be called on version conflict")
	}
}

func TestMarkdownSave_ValidationAndBounds(t *testing.T) {
	env := setupTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/reviews-api/rev-1" {
			snap := map[string]any{
				"reviewId": "rev-1",
				"version":  0,
				"title":    "Doc",
				"document": []any{
					map[string]any{
						"type":     "markdown",
						"id":       "md-0",
						"markdown": "zero",
					},
					map[string]any{
						"type":  "section",
						"id":    "sec-non-md",
						"title": "Section",
					},
				},
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(snap)
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == "/reviews-api/commands" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"reviewId":"rev-1","version":1}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}), nil)

	tests := []struct {
		name       string
		path       string
		body       string
		wantStatus int
	}{
		{
			name:       "target node missing from snapshot returns 404",
			path:       "/api/reviews/rev-1/markdown/missing-node",
			body:       `{"version": 0, "markdown": "hello"}`,
			wantStatus: http.StatusNotFound,
		},
		{
			name:       "target node wrong type (section) returns 400",
			path:       "/api/reviews/rev-1/markdown/sec-non-md",
			body:       `{"version": 0, "markdown": "hello"}`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "unknown field in body rejected",
			path:       "/api/reviews/rev-1/markdown/md-0",
			body:       `{"version": 0, "markdown": "hello", "unknownField": true}`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "missing version field rejected",
			path:       "/api/reviews/rev-1/markdown/md-0",
			body:       `{"markdown": "hello"}`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "version 0 distinguished and valid",
			path:       "/api/reviews/rev-1/markdown/md-0",
			body:       `{"version": 0, "markdown": "zero updated"}`,
			wantStatus: http.StatusOK,
		},
		{
			name:       "missing markdown field rejected",
			path:       "/api/reviews/rev-1/markdown/md-0",
			body:       `{"version": 0}`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "trailing JSON data rejected",
			path:       "/api/reviews/rev-1/markdown/md-0",
			body:       `{"version": 0, "markdown": "hello"} {extra}`,
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPut, tc.path, strings.NewReader(tc.body))
			req.Host = "127.0.0.1:8080"
			req.Header.Set("Origin", testOrigin)
			req.Header.Set("Content-Type", "application/json")

			rec := httptest.NewRecorder()
			env.gateway.ServeHTTP(rec, req)

			if rec.Code != tc.wantStatus {
				t.Fatalf("expected status %d, got %d (body: %s)", tc.wantStatus, rec.Code, rec.Body.String())
			}
		})
	}

	t.Run("body exceeding 1MiB rejected", func(t *testing.T) {
		huge := strings.Repeat("x", (1<<20)+10)
		body := fmt.Sprintf(`{"version": 0, "markdown": "%s"}`, huge)
		req := httptest.NewRequest(http.MethodPut, "/api/reviews/rev-1/markdown/md-0", strings.NewReader(body))
		req.Host = "127.0.0.1:8080"
		req.Header.Set("Origin", testOrigin)
		req.Header.Set("Content-Type", "application/json")

		rec := httptest.NewRecorder()
		env.gateway.ServeHTTP(rec, req)

		if rec.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("expected 413 Payload Too Large, got %d", rec.Code)
		}
	})
}

func TestMarkdownSave_ResultAcknowledgement(t *testing.T) {
	for _, tc := range []struct {
		name   string
		result string
		status int
	}{
		{"wrong review", `{"reviewId":"wrong-id","version":2}`, http.StatusBadGateway},
		{"older version", `{"reviewId":"rev-1","version":0}`, http.StatusBadGateway},
		{"missing version", `{"reviewId":"rev-1"}`, http.StatusBadGateway},
		{"no-op", `{"reviewId":"rev-1","version":1}`, http.StatusOK},
		{"updated", `{"reviewId":"rev-1","version":2}`, http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var postCount atomic.Int32

			env := setupTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet && r.URL.Path == "/reviews-api/rev-1" {
					snap := map[string]any{
						"reviewId": "rev-1",
						"version":  1,
						"title":    "Doc",
						"document": []any{
							map[string]any{
								"type":     "markdown",
								"id":       "md-1",
								"markdown": "old",
							},
						},
					}
					w.Header().Set("Content-Type", "application/json")
					_ = json.NewEncoder(w).Encode(snap)
					return
				}
				if r.Method == http.MethodPost && r.URL.Path == "/reviews-api/commands" {
					postCount.Add(1)
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusOK)
					_, _ = w.Write([]byte(tc.result))
					return
				}
				w.WriteHeader(http.StatusNotFound)
			}), nil)

			body := `{"version": 1, "markdown": "new text"}`
			req := httptest.NewRequest(http.MethodPut, "/api/reviews/rev-1/markdown/md-1", strings.NewReader(body))
			req.Host = "127.0.0.1:8080"
			req.Header.Set("Origin", testOrigin)
			req.Header.Set("Content-Type", "application/json")

			rec := httptest.NewRecorder()
			env.gateway.ServeHTTP(rec, req)

			if rec.Code != tc.status {
				t.Fatalf("expected %d for command result, got %d", tc.status, rec.Code)
			}
			if tc.status == http.StatusBadGateway && !strings.Contains(rec.Body.String(), "save outcome unknown, reread before retry") {
				t.Fatalf("expected 'save outcome unknown' error message, got %s", rec.Body.String())
			}
			if postCount.Load() != 1 {
				t.Fatalf("expected exactly 1 POST dispatch (no automatic retries), got %d", postCount.Load())
			}
		})
	}
}

func TestWatchStreaming_FlushAndCancellation(t *testing.T) {
	upstreamCancelled := make(chan struct{})
	var closeOnce sync.Once

	env := setupTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/reviews-api/watch" {
			w.WriteHeader(http.StatusNotFound)
			return
		}

		sub := r.URL.Query().Get("subscriptions")
		if !strings.Contains(sub, "rev-1") {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "flusher unsupported", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/x-ndjson")
		w.WriteHeader(http.StatusOK)

		_, _ = w.Write([]byte("{\"kind\":\"list\",\"reviews\":[]}\n"))
		flusher.Flush()

		_, _ = w.Write([]byte("{\"kind\":\"review\",\"reviewId\":\"rev-1\",\"value\":{}}\n"))
		flusher.Flush()

		select {
		case <-r.Context().Done():
			closeOnce.Do(func() { close(upstreamCancelled) })
			return
		case <-time.After(5 * time.Second):
			return
		}
	}), nil)

	gwServer := httptest.NewServer(env.gateway)
	defer gwServer.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, gwServer.URL+"/api/watch?subscriptions=[{\"reviewId\":null},{\"reviewId\":\"rev-1\"}]", nil)
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	req.Host = "127.0.0.1:8080"

	resp, err := gwServer.Client().Do(req)
	if err != nil {
		t.Fatalf("watch request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK from watch, got %d", resp.StatusCode)
	}

	reader := bufio.NewReader(resp.Body)
	line1, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("failed to read line1: %v", err)
	}
	line2, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("failed to read line2: %v", err)
	}

	if !strings.Contains(line1, "list") {
		t.Errorf("expected line1 to contain 'list', got %q", line1)
	}
	if !strings.Contains(line2, "review") {
		t.Errorf("expected line2 to contain 'review', got %q", line2)
	}

	cancel()

	select {
	case <-upstreamCancelled:
		// Upstream correctly notified
	case <-time.After(2 * time.Second):
		t.Fatal("expected upstream to receive context cancellation")
	}
}

func TestWatchStreaming_OversizedLine(t *testing.T) {
	env := setupTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			return
		}
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.WriteHeader(http.StatusOK)

		// Send oversized line > 1MiB
		huge := strings.Repeat("x", (1<<20)+10)
		_, _ = w.Write([]byte(fmt.Sprintf("{\"kind\":\"test\",\"data\":\"%s\"}\n", huge)))
		flusher.Flush()
	}), nil)

	gwServer := httptest.NewServer(env.gateway)
	defer gwServer.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, gwServer.URL+"/api/watch?subscriptions=[{\"reviewId\":null}]", nil)
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	req.Host = "127.0.0.1:8080"

	resp, err := gwServer.Client().Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()

	reader := bufio.NewReader(resp.Body)
	_, err = reader.ReadString('\n')
	// Stream should terminate / EOF on oversized line without forwarding it
	if err == nil {
		t.Error("expected EOF or error on oversized stream line")
	}
}

func TestWatchStreaming_MalformedSubscriptions(t *testing.T) {
	env := setupTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}), nil)

	tests := []struct {
		name       string
		query      string
		wantStatus int
	}{
		{
			name:       "empty object missing reviewId rejected",
			query:      "subscriptions=[{}]",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "object with extra keys rejected",
			query:      "subscriptions=[{\"reviewId\":\"rev-1\",\"extra\":true}]",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "trailing JSON after subscriptions rejected",
			query:      "subscriptions=[{\"reviewId\":null}]%20extra",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "repeated query parameters rejected",
			query:      "subscriptions=[{\"reviewId\":null}]&subscriptions=[{\"reviewId\":null}]",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "malformed query percent-encoding rejected",
			query:      "subscriptions=%ZZ",
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/watch?"+tc.query, nil)
			req.Host = "127.0.0.1:8080"
			rec := httptest.NewRecorder()
			env.gateway.ServeHTTP(rec, req)

			if rec.Code != tc.wantStatus {
				t.Fatalf("expected status %d, got %d (body: %s)", tc.wantStatus, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestSourceTraversalAndQueryValidation(t *testing.T) {
	env := setupTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"content":"safe"}`))
	}), nil)

	tests := []struct {
		name       string
		path       string
		wantStatus int
	}{
		{
			name:       "safe file query allowed",
			path:       "/api/reviews/rev-1/file?side=head&file=src/index.ts",
			wantStatus: http.StatusOK,
		},
		{
			name:       "path traversal in file rejected",
			path:       "/api/reviews/rev-1/file?side=head&file=../secret.txt",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "absolute file path rejected",
			path:       "/api/reviews/rev-1/file?side=head&file=/etc/passwd",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "backslash in file rejected",
			path:       "/api/reviews/rev-1/file?side=head&file=foo\\bar",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "invalid side rejected",
			path:       "/api/reviews/rev-1/file?side=invalid&file=src/index.ts",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "unknown query param on file rejected",
			path:       "/api/reviews/rev-1/file?side=head&file=src/index.ts&unknown=1",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "negative version on diff rejected",
			path:       "/api/reviews/rev-1/diff?version=-1",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "tree path traversal rejected",
			path:       "/api/reviews/rev-1/tree?path=../bad",
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			req.Host = "127.0.0.1:8080"
			rec := httptest.NewRecorder()
			env.gateway.ServeHTTP(rec, req)

			if rec.Code != tc.wantStatus {
				t.Fatalf("expected status %d, got %d (body: %s)", tc.wantStatus, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestStaticAssets(t *testing.T) {
	env := setupTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}), nil)

	t.Run("serve index.html at root", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Host = "127.0.0.1:8080"
		rec := httptest.NewRecorder()
		env.gateway.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "Whiteboard") {
			t.Errorf("expected body to contain Whiteboard, got %q", rec.Body.String())
		}
		if !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/html") {
			t.Errorf("expected text/html Content-Type, got %q", rec.Header().Get("Content-Type"))
		}
	})

	t.Run("serve app.js file", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/app.js", nil)
		req.Host = "127.0.0.1:8080"
		rec := httptest.NewRecorder()
		env.gateway.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "mobile-whiteboard") {
			t.Errorf("expected body to contain mobile-whiteboard, got %q", rec.Body.String())
		}
	})

	t.Run("missing asset returns 404 with no SPA fallback", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/missing-route", nil)
		req.Host = "127.0.0.1:8080"
		rec := httptest.NewRecorder()
		env.gateway.ServeHTTP(rec, req)

		if rec.Code != http.StatusNotFound {
			t.Fatalf("expected 404 for missing asset, got %d", rec.Code)
		}
		if strings.Contains(rec.Body.String(), "Whiteboard") {
			t.Error("SPA fallback must not be served for missing assets")
		}
	})

	t.Run("directory trailing slash returns 404", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/subdir/", nil)
		req.Host = "127.0.0.1:8080"
		rec := httptest.NewRecorder()
		env.gateway.ServeHTTP(rec, req)

		if rec.Code != http.StatusNotFound {
			t.Fatalf("expected 404 for directory listing, got %d", rec.Code)
		}
	})

	t.Run("POST to static asset rejected with 405", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/", nil)
		req.Host = "127.0.0.1:8080"
		req.Header.Set("Origin", testOrigin)
		rec := httptest.NewRecorder()
		env.gateway.ServeHTTP(rec, req)

		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("expected 405 Method Not Allowed, got %d", rec.Code)
		}
	})
}

func TestStaticAssets_SymlinkEscape(t *testing.T) {
	tempBase := t.TempDir()
	outsideDir := filepath.Join(tempBase, "outside")
	assetsDir := filepath.Join(tempBase, "assets")

	if err := os.MkdirAll(outsideDir, 0o700); err != nil {
		t.Fatalf("failed to create outside dir: %v", err)
	}
	if err := os.MkdirAll(assetsDir, 0o700); err != nil {
		t.Fatalf("failed to create assets dir: %v", err)
	}

	secretFile := filepath.Join(outsideDir, "secret.txt")
	if err := os.WriteFile(secretFile, []byte("SUPER_SECRET_TOKEN"), 0o600); err != nil {
		t.Fatalf("failed to write secret file: %v", err)
	}

	// Create symlink pointing outside assets directory
	symlinkPath := filepath.Join(assetsDir, "escape.txt")
	if err := os.Symlink(secretFile, symlinkPath); err != nil {
		t.Fatalf("failed to create symlink: %v", err)
	}

	gw, err := NewGateway(Options{
		Origin:        testOrigin,
		Listen:        "127.0.0.1:8080",
		DiscoveryPath: filepath.Join(tempBase, "dummy.json"),
		AssetsDir:     assetsDir,
	})
	if err != nil {
		t.Fatalf("failed to initialize gateway with AssetsDir: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/escape.txt", nil)
	req.Host = "127.0.0.1:8080"
	rec := httptest.NewRecorder()
	gw.ServeHTTP(rec, req)

	// Must be 404 Not Found, never 200 with secret contents
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 Not Found for symlink escape, got %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "SUPER_SECRET_TOKEN") {
		t.Fatal("secret leaked through symlink escape!")
	}
}

func TestInvalidJSONAndSnapshotFieldRegressions(t *testing.T) {
	t.Run("reviews list returning invalid JSON yields 502", func(t *testing.T) {
		env := setupTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{not-json}`))
		}), nil)

		req := httptest.NewRequest(http.MethodGet, "/api/reviews", nil)
		req.Host = "127.0.0.1:8080"
		rec := httptest.NewRecorder()
		env.gateway.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("expected 502 for invalid JSON, got %d", rec.Code)
		}
	})

	t.Run("reviews list returning null yields 502", func(t *testing.T) {
		env := setupTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`null`))
		}), nil)

		req := httptest.NewRequest(http.MethodGet, "/api/reviews", nil)
		req.Host = "127.0.0.1:8080"
		rec := httptest.NewRecorder()
		env.gateway.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("expected 502 for null reviews list, got %d", rec.Code)
		}
	})

	t.Run("snapshot missing document yields 502", func(t *testing.T) {
		env := setupTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"reviewId":"rev-1","version":1}`))
		}), nil)

		req := httptest.NewRequest(http.MethodGet, "/api/reviews/rev-1", nil)
		req.Host = "127.0.0.1:8080"
		rec := httptest.NewRecorder()
		env.gateway.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("expected 502 for snapshot missing document, got %d", rec.Code)
		}
	})

	t.Run("snapshot reviewId mismatch yields 502", func(t *testing.T) {
		env := setupTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"reviewId":"other-rev","version":1,"document":[]}`))
		}), nil)

		req := httptest.NewRequest(http.MethodGet, "/api/reviews/rev-1", nil)
		req.Host = "127.0.0.1:8080"
		rec := httptest.NewRecorder()
		env.gateway.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("expected 502 for snapshot reviewId mismatch, got %d", rec.Code)
		}
	})

	t.Run("resource with invalid content-type text/html yields 502", func(t *testing.T) {
		env := setupTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/html")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`<html>attack</html>`))
		}), nil)

		req := httptest.NewRequest(http.MethodGet, "/api/reviews/rev-1/resources/res-1", nil)
		req.Host = "127.0.0.1:8080"
		rec := httptest.NewRecorder()
		env.gateway.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("expected 502 for resource text/html Content-Type, got %d", rec.Code)
		}
	})

	t.Run("resource JSON content-type with invalid JSON yields 502", func(t *testing.T) {
		env := setupTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{not-json}`))
		}), nil)

		req := httptest.NewRequest(http.MethodGet, "/api/reviews/rev-1/resources/res-1", nil)
		req.Host = "127.0.0.1:8080"
		rec := httptest.NewRecorder()
		env.gateway.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("expected 502 for resource application/json with invalid JSON, got %d", rec.Code)
		}
	})

	t.Run("health with empty instanceId yields 502", func(t *testing.T) {
		env := setupTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"ok":true,"instanceId":"","version":"0.3.1"}`))
		}), nil)

		req := httptest.NewRequest(http.MethodGet, "/health", nil)
		req.Host = "127.0.0.1:8080"
		rec := httptest.NewRecorder()
		env.gateway.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("expected 502 for health with empty instanceId, got %d", rec.Code)
		}
	})
}

func TestHealthEndpoint(t *testing.T) {
	t.Run("upstream health ok returns 200", func(t *testing.T) {
		env := setupTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/health" {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(fmt.Sprintf(`{"ok":true,"instanceId":%q,"version":"0.3.1"}`, testInstanceID)))
				return
			}
			w.WriteHeader(http.StatusNotFound)
		}), nil)

		req := httptest.NewRequest(http.MethodGet, "/health", nil)
		req.Host = "127.0.0.1:8080"
		rec := httptest.NewRecorder()
		env.gateway.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d (body: %s)", rec.Code, rec.Body.String())
		}
	})

	t.Run("upstream instanceId mismatch returns 502", func(t *testing.T) {
		env := setupTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/health" {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"ok":true,"instanceId":"99999999-9999-9999-9999-999999999999","version":"0.3.1"}`))
				return
			}
			w.WriteHeader(http.StatusNotFound)
		}), nil)

		req := httptest.NewRequest(http.MethodGet, "/health", nil)
		req.Host = "127.0.0.1:8080"
		rec := httptest.NewRecorder()
		env.gateway.ServeHTTP(rec, req)

		if rec.Code != http.StatusBadGateway {
			t.Fatalf("expected 502 for instanceId mismatch, got %d", rec.Code)
		}
	})
}
