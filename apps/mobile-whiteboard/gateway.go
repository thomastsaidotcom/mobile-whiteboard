package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	uuidRegex = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	idRegex   = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
)

// Discovery represents the trusted local desktop server configuration.
type Discovery struct {
	Version    int    `json:"version"`
	InstanceID string `json:"instanceId"`
	URL        string `json:"url"`
	Token      string `json:"token"`
}

// ValidateDiscovery verifies discovery configuration parameters.
func ValidateDiscovery(d *Discovery) error {
	if d == nil {
		return errors.New("discovery data is nil")
	}
	// Desktop discovery uses protocol 3; the headless server has a separate format.
	if d.Version != 3 {
		return fmt.Errorf("unsupported desktop discovery version: %d (expected 3)", d.Version)
	}
	if !uuidRegex.MatchString(d.InstanceID) {
		return fmt.Errorf("invalid instanceId: must be a valid UUID")
	}
	if strings.TrimSpace(d.Token) == "" {
		return errors.New("discovery token is required")
	}

	u, err := url.Parse(d.URL)
	if err != nil {
		return fmt.Errorf("invalid discovery url: %w", err)
	}
	if u.Scheme != "http" {
		return fmt.Errorf("discovery url scheme must be http, got %q", u.Scheme)
	}
	if u.User != nil {
		return errors.New("discovery url must not contain credentials")
	}
	if u.Path != "" && u.Path != "/" {
		return fmt.Errorf("discovery url must not contain path, got %q", u.Path)
	}
	if u.RawQuery != "" || u.ForceQuery {
		return errors.New("discovery url must not contain query")
	}
	if u.Fragment != "" {
		return errors.New("discovery url must not contain fragment")
	}

	host := u.Hostname()
	if host != "127.0.0.1" {
		return fmt.Errorf("discovery url host must be 127.0.0.1, got %q", host)
	}
	portStr := u.Port()
	if portStr == "" {
		return errors.New("discovery url must contain a port")
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		return fmt.Errorf("discovery url port must be between 1 and 65535, got %q", portStr)
	}

	canonical := fmt.Sprintf("http://127.0.0.1:%d", port)
	if d.URL != canonical && d.URL != canonical+"/" {
		return fmt.Errorf("discovery url is not canonical: %q", d.URL)
	}

	return nil
}

// ValidateOrigin validates configured origin strings according to security requirements.
func ValidateOrigin(raw string) (string, *url.URL, error) {
	if raw == "" {
		return "", nil, errors.New("origin is required")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", nil, fmt.Errorf("invalid origin %q: %w", raw, err)
	}
	if u.User != nil {
		return "", nil, errors.New("origin must not contain userinfo")
	}
	if u.Path != "" && u.Path != "/" {
		return "", nil, errors.New("origin must not contain path")
	}
	if u.RawQuery != "" {
		return "", nil, errors.New("origin must not contain query")
	}
	if u.Fragment != "" {
		return "", nil, errors.New("origin must not contain fragment")
	}

	switch u.Scheme {
	case "http":
		host := u.Hostname()
		if host != "127.0.0.1" {
			return "", nil, fmt.Errorf("http origin must use 127.0.0.1, got %q", host)
		}
		portStr := u.Port()
		if portStr == "" {
			return "", nil, errors.New("http origin must specify a port")
		}
		port, err := strconv.Atoi(portStr)
		if err != nil || port < 1 || port > 65535 {
			return "", nil, fmt.Errorf("invalid port in origin: %q", portStr)
		}
	case "https":
		host := strings.ToLower(u.Hostname())
		if !strings.HasSuffix(host, ".ts.net") || len(host) <= len(".ts.net") {
			return "", nil, fmt.Errorf("https origin must be a *.ts.net domain, got %q", host)
		}
		if portStr := u.Port(); portStr != "" {
			port, err := strconv.Atoi(portStr)
			if err != nil || port < 1 || port > 65535 {
				return "", nil, fmt.Errorf("invalid port in https origin: %q", portStr)
			}
		}
	default:
		return "", nil, fmt.Errorf("origin scheme must be http or https, got %q", u.Scheme)
	}

	portStr := ""
	if u.Port() != "" {
		portStr = ":" + u.Port()
	}
	norm := fmt.Sprintf("%s://%s%s", u.Scheme, u.Hostname(), portStr)
	normURL, _ := url.Parse(norm)
	return norm, normURL, nil
}

// ValidateListen validates loopback IPv4 listen address with valid port.
func ValidateListen(listen string) error {
	host, portStr, err := net.SplitHostPort(listen)
	if err != nil {
		return fmt.Errorf("invalid listen address %q: %w", listen, err)
	}
	ip := net.ParseIP(host)
	if ip == nil || ip.To4() == nil || !ip.IsLoopback() {
		return fmt.Errorf("listen host must be a loopback IPv4 address, got %q", host)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		return fmt.Errorf("listen port must be between 1 and 65535, got %q", portStr)
	}
	return nil
}

// Options configures the Gateway constructor.
type Options struct {
	Origin        string
	Listen        string
	DiscoveryPath string
	Assets        fs.FS
	AssetsDir     string
	Client        *http.Client
}

// Gateway implements the HTTP reverse proxy and security boundary for Mobile Whiteboard v1.
type Gateway struct {
	origin        string
	originURL     *url.URL
	expectedHost  string
	discoveryPath string
	assets        fs.FS
	client        *http.Client
}

// NewGateway creates a new Mobile Whiteboard gateway handler.
func NewGateway(opts Options) (http.Handler, error) {
	normOrigin, normURL, err := ValidateOrigin(opts.Origin)
	if err != nil {
		return nil, fmt.Errorf("invalid origin: %w", err)
	}
	if opts.Listen != "" {
		if err := ValidateListen(opts.Listen); err != nil {
			return nil, fmt.Errorf("invalid listen: %w", err)
		}
	}
	if opts.DiscoveryPath == "" {
		return nil, errors.New("discovery path is required")
	}

	assets := opts.Assets
	if assets == nil && opts.AssetsDir != "" {
		root, err := os.OpenRoot(opts.AssetsDir)
		if err != nil {
			return nil, fmt.Errorf("failed to open assets directory %q: %w", opts.AssetsDir, err)
		}
		assets = root.FS()
	}

	client := opts.Client
	if client == nil {
		transport := &http.Transport{
			Proxy: nil, // disable env HTTP proxy
			DialContext: (&net.Dialer{
				Timeout:   5 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			IdleConnTimeout:     90 * time.Second,
			TLSHandshakeTimeout: 5 * time.Second,
		}
		client = &http.Client{
			Transport: transport,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	} else {
		client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		}
	}

	expectedHost := normURL.Host

	return &Gateway{
		origin:        normOrigin,
		originURL:     normURL,
		expectedHost:  expectedHost,
		discoveryPath: opts.DiscoveryPath,
		assets:        assets,
		client:        client,
	}, nil
}

func (g *Gateway) readDiscovery() (*Discovery, error) {
	data, err := os.ReadFile(g.discoveryPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read discovery file: %w", err)
	}
	var d Discovery
	if err := json.Unmarshal(data, &d); err != nil {
		return nil, fmt.Errorf("failed to parse discovery JSON: %w", err)
	}
	if err := ValidateDiscovery(&d); err != nil {
		return nil, err
	}
	return &d, nil
}

func (g *Gateway) checkHost(r *http.Request) bool {
	host := r.Host
	if host == g.expectedHost {
		return true
	}
	if g.originURL.Scheme == "https" {
		if host == strings.TrimSuffix(g.expectedHost, ":443") || host+":443" == g.expectedHost {
			return true
		}
	}
	return false
}

func (g *Gateway) checkForwarded(r *http.Request) bool {
	if xfh := r.Header.Get("X-Forwarded-Host"); xfh != "" {
		if xfh != g.expectedHost && (g.originURL.Scheme != "https" || xfh != strings.TrimSuffix(g.expectedHost, ":443")) {
			return false
		}
	}
	if fwd := r.Header.Get("Forwarded"); fwd != "" {
		for _, part := range strings.Split(fwd, ";") {
			part = strings.TrimSpace(part)
			if strings.HasPrefix(strings.ToLower(part), "host=") {
				fwdHost := strings.Trim(part[5:], `"`)
				if fwdHost != g.expectedHost && (g.originURL.Scheme != "https" || fwdHost != strings.TrimSuffix(g.expectedHost, ":443")) {
					return false
				}
			}
		}
	}
	return true
}

func (g *Gateway) setSecurityHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	// Emscripten's shared map bindings construct functions; script loading stays local.
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; font-src 'self' data:; img-src 'self' https: data: blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'")
}

func parseAndValidateQuery(rawQuery string) (url.Values, error) {
	if rawQuery == "" {
		return url.Values{}, nil
	}
	values, err := url.ParseQuery(rawQuery)
	if err != nil {
		return nil, fmt.Errorf("malformed query string: %w", err)
	}
	for k, vs := range values {
		if len(vs) > 1 {
			return nil, fmt.Errorf("duplicate query parameter %q", k)
		}
	}
	return values, nil
}

func hasDotDot(p string) bool {
	for _, part := range strings.FieldsFunc(p, func(r rune) bool { return r == '/' || r == '\\' }) {
		if part == ".." {
			return true
		}
	}
	return false
}

func readBoundedBody(r io.Reader, max int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > max {
		return nil, errors.New("response body exceeds size limit")
	}
	return data, nil
}

func readBoundedJSON(r io.Reader, max int64) ([]byte, error) {
	data, err := readBoundedBody(r, max)
	if err != nil {
		return nil, err
	}
	if !json.Valid(data) {
		return nil, errors.New("invalid JSON payload")
	}
	return data, nil
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	g.setSecurityHeaders(w)

	// 1. Host header validation
	if !g.checkHost(r) {
		http.Error(w, "forbidden: invalid host", http.StatusForbidden)
		return
	}

	// 2. Forwarded host validation
	if !g.checkForwarded(r) {
		http.Error(w, "forbidden: unexpected forwarded host", http.StatusForbidden)
		return
	}

	// 3. Sec-Fetch-Site validation
	if sfs := r.Header.Get("Sec-Fetch-Site"); sfs == "cross-site" {
		http.Error(w, "forbidden: cross-site request", http.StatusForbidden)
		return
	}

	// 4. Origin header validation
	reqOrigin := r.Header.Get("Origin")
	if r.Method == http.MethodPut {
		if reqOrigin == "" {
			http.Error(w, "forbidden: origin required on write", http.StatusForbidden)
			return
		}
		if reqOrigin != g.origin {
			http.Error(w, "forbidden: origin mismatch", http.StatusForbidden)
			return
		}
	} else {
		if reqOrigin != "" && reqOrigin != g.origin {
			http.Error(w, "forbidden: origin mismatch", http.StatusForbidden)
			return
		}
	}

	// 5. Incoming credentials rejection
	if r.Header.Get("X-Review-Token") != "" || r.Header.Get("Authorization") != "" || r.URL.Query().Has("token") {
		http.Error(w, "bad request: incoming credentials not permitted", http.StatusBadRequest)
		return
	}

	// 6. Encoded separator / path traversal rejection
	if r.URL.RawPath != "" {
		low := strings.ToLower(r.URL.RawPath)
		if strings.Contains(low, "%2f") || strings.Contains(low, "%5c") || strings.Contains(low, "%00") || strings.Contains(low, "%2e%2e") {
			http.Error(w, "bad request: encoded path separator or traversal", http.StatusBadRequest)
			return
		}
	}
	if strings.Contains(r.URL.Path, `\`) || strings.Contains(r.URL.Path, "\x00") || hasDotDot(r.URL.Path) {
		http.Error(w, "bad request: invalid path characters", http.StatusBadRequest)
		return
	}

	// 7. Strict query string validation
	q, err := parseAndValidateQuery(r.URL.RawQuery)
	if err != nil {
		http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
		return
	}

	// Route dispatching
	p := r.URL.Path

	if p == "/health" || p == "/api/health" {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if len(q) > 0 {
			http.Error(w, "bad request: unknown query parameter", http.StatusBadRequest)
			return
		}
		g.handleHealth(w, r)
		return
	}

	if p == "/api/reviews" {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if len(q) > 0 {
			http.Error(w, "bad request: unknown query parameter", http.StatusBadRequest)
			return
		}
		g.handleListReviews(w, r)
		return
	}

	if p == "/api/watch" {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		g.handleWatch(w, r, q)
		return
	}

	if strings.HasPrefix(p, "/api/reviews/") {
		sub := strings.TrimPrefix(p, "/api/reviews/")
		parts := strings.Split(sub, "/")
		reviewID := parts[0]
		if !idRegex.MatchString(reviewID) {
			http.Error(w, "bad request: invalid review id", http.StatusBadRequest)
			return
		}

		switch len(parts) {
		case 1:
			if r.Method != http.MethodGet {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			g.handleGetSnapshot(w, r, reviewID, q)
			return
		case 2:
			if r.Method != http.MethodGet {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			switch parts[1] {
			case "file":
				g.handleGetFile(w, r, reviewID, q)
			case "tree":
				g.handleGetTree(w, r, reviewID, q)
			case "diff":
				g.handleGetDiff(w, r, reviewID, q)
			case "commits":
				g.handleGetCommits(w, r, reviewID, q)
			case "history":
				g.handleGetHistory(w, r, reviewID, q)
			default:
				http.Error(w, "not found", http.StatusNotFound)
			}
			return
		case 3:
			switch parts[1] {
			case "resources":
				if r.Method != http.MethodGet {
					http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
					return
				}
				resourceID := parts[2]
				if !idRegex.MatchString(resourceID) {
					http.Error(w, "bad request: invalid resource id", http.StatusBadRequest)
					return
				}
				g.handleGetResource(w, r, reviewID, resourceID, q)
				return
			case "maps":
				if r.Method != http.MethodGet {
					http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
					return
				}
				resourceID := parts[2]
				if !idRegex.MatchString(resourceID) {
					http.Error(w, "bad request: invalid map resource id", http.StatusBadRequest)
					return
				}
				g.handleGetMap(w, r, reviewID, resourceID, q)
				return
			case "markdown":
				if r.Method != http.MethodPut {
					http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
					return
				}
				blockID := parts[2]
				if !idRegex.MatchString(blockID) {
					http.Error(w, "bad request: invalid block id", http.StatusBadRequest)
					return
				}
				if len(q) > 0 {
					http.Error(w, "bad request: unexpected query parameter", http.StatusBadRequest)
					return
				}
				g.handlePutMarkdown(w, r, reviewID, blockID)
				return
			default:
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
		default:
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
	}

	if strings.HasPrefix(p, "/api/") {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	g.handleStatic(w, r)
}

func (g *Gateway) handleHealth(w http.ResponseWriter, r *http.Request) {
	disc, err := g.readDiscovery()
	if err != nil {
		http.Error(w, "bad gateway: discovery configuration error", http.StatusBadGateway)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, disc.URL+"/health", nil)
	if err != nil {
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}
	req.Header.Set("X-Review-Token", disc.Token)
	req.Header.Set("X-Review-Client", "remote")

	resp, err := g.client.Do(req)
	if err != nil {
		http.Error(w, "bad gateway: upstream health check failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		http.Error(w, "bad gateway: upstream health check returned non-200", http.StatusBadGateway)
		return
	}

	body, err := readBoundedJSON(resp.Body, 1<<20)
	if err != nil {
		http.Error(w, "bad gateway: invalid upstream health json", http.StatusBadGateway)
		return
	}

	var health struct {
		OK         bool   `json:"ok"`
		InstanceID string `json:"instanceId"`
		Version    string `json:"version"`
	}
	if err := json.Unmarshal(body, &health); err != nil {
		http.Error(w, "bad gateway: invalid upstream health json", http.StatusBadGateway)
		return
	}

	if !health.OK || health.InstanceID == "" || health.InstanceID != disc.InstanceID {
		http.Error(w, "bad gateway: upstream instance id mismatch", http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"ok":true}`))
}

func (g *Gateway) handleListReviews(w http.ResponseWriter, r *http.Request) {
	disc, err := g.readDiscovery()
	if err != nil {
		http.Error(w, "bad gateway: discovery configuration error", http.StatusBadGateway)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, disc.URL+"/reviews-api", nil)
	if err != nil {
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}
	req.Header.Set("X-Review-Token", disc.Token)
	req.Header.Set("X-Review-Client", "remote")

	resp, err := g.client.Do(req)
	if err != nil {
		http.Error(w, "bad gateway: failed to reach upstream reviews api", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		http.Error(w, "bad gateway: upstream returned unexpected status", http.StatusBadGateway)
		return
	}

	body, err := readBoundedJSON(resp.Body, 16<<20)
	if err != nil {
		http.Error(w, "bad gateway: invalid upstream reviews json", http.StatusBadGateway)
		return
	}

	var rawList *[]json.RawMessage
	if err := json.Unmarshal(body, &rawList); err != nil || rawList == nil {
		http.Error(w, "bad gateway: invalid upstream reviews list", http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func (g *Gateway) handleGetSnapshot(w http.ResponseWriter, r *http.Request, reviewID string, q url.Values) {
	versionStr := q.Get("version")
	for k := range q {
		if k != "version" {
			http.Error(w, "bad request: unknown query parameter", http.StatusBadRequest)
			return
		}
	}
	if versionStr != "" {
		v, err := strconv.Atoi(versionStr)
		if err != nil || v < 0 {
			http.Error(w, "bad request: version must be a non-negative integer", http.StatusBadRequest)
			return
		}
	}

	disc, err := g.readDiscovery()
	if err != nil {
		http.Error(w, "bad gateway: discovery configuration error", http.StatusBadGateway)
		return
	}

	targetURL := fmt.Sprintf("%s/reviews-api/%s?full=true", disc.URL, reviewID)
	if versionStr != "" {
		targetURL += "&version=" + url.QueryEscape(versionStr)
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}
	req.Header.Set("X-Review-Token", disc.Token)
	req.Header.Set("X-Review-Client", "remote")

	resp, err := g.client.Do(req)
	if err != nil {
		http.Error(w, "bad gateway: upstream request failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		http.Error(w, "not found: review not found", http.StatusNotFound)
		return
	}
	if resp.StatusCode != http.StatusOK {
		http.Error(w, "bad gateway: unexpected upstream status", http.StatusBadGateway)
		return
	}

	body, err := readBoundedJSON(resp.Body, 16<<20)
	if err != nil {
		http.Error(w, "bad gateway: invalid upstream snapshot json", http.StatusBadGateway)
		return
	}

	var snapshot snapshotEnvelope
	if err := json.Unmarshal(body, &snapshot); err != nil {
		http.Error(w, "bad gateway: invalid upstream snapshot schema", http.StatusBadGateway)
		return
	}
	if snapshot.ReviewID == nil || *snapshot.ReviewID != reviewID || snapshot.Version == nil || *snapshot.Version < 0 || snapshot.Document == nil {
		http.Error(w, "bad gateway: invalid upstream snapshot schema", http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func (g *Gateway) handleGetFile(w http.ResponseWriter, r *http.Request, reviewID string, q url.Values) {
	allowed := map[string]bool{
		"side":         true,
		"file":         true,
		"version":      true,
		"commit":       true,
		"repositoryId": true,
		"head":         true,
		"base":         true,
	}
	for k := range q {
		if !allowed[k] {
			http.Error(w, fmt.Sprintf("bad request: unknown query parameter %q", k), http.StatusBadRequest)
			return
		}
	}

	file := q.Get("file")
	if file == "" {
		http.Error(w, "bad request: missing file query parameter", http.StatusBadRequest)
		return
	}
	if strings.HasPrefix(file, "/") || strings.Contains(file, `\`) || strings.Contains(file, "\x00") || hasDotDot(file) {
		http.Error(w, "bad request: unsafe file path", http.StatusBadRequest)
		return
	}
	cleanFile := path.Clean(file)
	if cleanFile == ".." || strings.HasPrefix(cleanFile, "../") {
		http.Error(w, "bad request: file path traversal", http.StatusBadRequest)
		return
	}

	if side := q.Get("side"); side != "" && side != "base" && side != "head" {
		http.Error(w, "bad request: side must be base or head", http.StatusBadRequest)
		return
	}
	if vStr := q.Get("version"); vStr != "" {
		v, err := strconv.Atoi(vStr)
		if err != nil || v < 0 {
			http.Error(w, "bad request: version must be a non-negative integer", http.StatusBadRequest)
			return
		}
	}

	disc, err := g.readDiscovery()
	if err != nil {
		http.Error(w, "bad gateway: discovery configuration error", http.StatusBadGateway)
		return
	}

	targetURL := fmt.Sprintf("%s/reviews-api/%s/file?%s", disc.URL, reviewID, q.Encode())

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}
	req.Header.Set("X-Review-Token", disc.Token)
	req.Header.Set("X-Review-Client", "remote")

	resp, err := g.client.Do(req)
	if err != nil {
		http.Error(w, "bad gateway: upstream request failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		http.Error(w, "not found: file not found", http.StatusNotFound)
		return
	}
	if resp.StatusCode != http.StatusOK {
		http.Error(w, "bad gateway: upstream returned unexpected status", http.StatusBadGateway)
		return
	}

	body, err := readBoundedBody(resp.Body, 16<<20)
	if err != nil {
		http.Error(w, "bad gateway: failed to read upstream file data", http.StatusBadGateway)
		return
	}

	ct := resp.Header.Get("Content-Type")
	mediaType, _, _ := mime.ParseMediaType(ct)
	if mediaType == "application/json" && !json.Valid(body) {
		http.Error(w, "bad gateway: invalid JSON in file response", http.StatusBadGateway)
		return
	}
	if ct == "" {
		ct = "application/json"
	}
	w.Header().Set("Content-Type", ct)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func (g *Gateway) handleGetTree(w http.ResponseWriter, r *http.Request, reviewID string, q url.Values) {
	allowed := map[string]bool{
		"path":         true,
		"side":         true,
		"version":      true,
		"commit":       true,
		"repositoryId": true,
		"head":         true,
		"base":         true,
	}
	for k := range q {
		if !allowed[k] {
			http.Error(w, fmt.Sprintf("bad request: unknown query parameter %q", k), http.StatusBadRequest)
			return
		}
	}

	if p := q.Get("path"); p != "" {
		if strings.HasPrefix(p, "/") || strings.Contains(p, `\`) || strings.Contains(p, "\x00") || hasDotDot(p) {
			http.Error(w, "bad request: unsafe tree path", http.StatusBadRequest)
			return
		}
		cleanP := path.Clean(p)
		if cleanP == ".." || strings.HasPrefix(cleanP, "../") {
			http.Error(w, "bad request: tree path traversal", http.StatusBadRequest)
			return
		}
	}
	if side := q.Get("side"); side != "" && side != "base" && side != "head" {
		http.Error(w, "bad request: side must be base or head", http.StatusBadRequest)
		return
	}
	if vStr := q.Get("version"); vStr != "" {
		v, err := strconv.Atoi(vStr)
		if err != nil || v < 0 {
			http.Error(w, "bad request: version must be a non-negative integer", http.StatusBadRequest)
			return
		}
	}

	disc, err := g.readDiscovery()
	if err != nil {
		http.Error(w, "bad gateway: discovery configuration error", http.StatusBadGateway)
		return
	}

	targetURL := fmt.Sprintf("%s/reviews-api/%s/tree", disc.URL, reviewID)
	if len(q) > 0 {
		targetURL += "?" + q.Encode()
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}
	req.Header.Set("X-Review-Token", disc.Token)
	req.Header.Set("X-Review-Client", "remote")

	resp, err := g.client.Do(req)
	if err != nil {
		http.Error(w, "bad gateway: upstream request failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		http.Error(w, "not found: tree not found", http.StatusNotFound)
		return
	}
	if resp.StatusCode != http.StatusOK {
		http.Error(w, "bad gateway: unexpected upstream status", http.StatusBadGateway)
		return
	}

	body, err := readBoundedJSON(resp.Body, 16<<20)
	if err != nil {
		http.Error(w, "bad gateway: invalid upstream tree JSON", http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func (g *Gateway) handleGetDiff(w http.ResponseWriter, r *http.Request, reviewID string, q url.Values) {
	allowed := map[string]bool{
		"version":      true,
		"commit":       true,
		"repositoryId": true,
		"head":         true,
		"base":         true,
	}
	for k := range q {
		if !allowed[k] {
			http.Error(w, fmt.Sprintf("bad request: unknown query parameter %q", k), http.StatusBadRequest)
			return
		}
	}
	if vStr := q.Get("version"); vStr != "" {
		v, err := strconv.Atoi(vStr)
		if err != nil || v < 0 {
			http.Error(w, "bad request: version must be a non-negative integer", http.StatusBadRequest)
			return
		}
	}

	disc, err := g.readDiscovery()
	if err != nil {
		http.Error(w, "bad gateway: discovery configuration error", http.StatusBadGateway)
		return
	}

	targetURL := fmt.Sprintf("%s/reviews-api/%s/diff", disc.URL, reviewID)
	if len(q) > 0 {
		targetURL += "?" + q.Encode()
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}
	req.Header.Set("X-Review-Token", disc.Token)
	req.Header.Set("X-Review-Client", "remote")

	resp, err := g.client.Do(req)
	if err != nil {
		http.Error(w, "bad gateway: upstream request failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		http.Error(w, "not found: diff not found", http.StatusNotFound)
		return
	}
	if resp.StatusCode != http.StatusOK {
		http.Error(w, "bad gateway: unexpected upstream status", http.StatusBadGateway)
		return
	}

	body, err := readBoundedJSON(resp.Body, 16<<20)
	if err != nil {
		http.Error(w, "bad gateway: invalid upstream diff JSON", http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func (g *Gateway) handleGetCommits(w http.ResponseWriter, r *http.Request, reviewID string, q url.Values) {
	for k := range q {
		if k != "version" {
			http.Error(w, "bad request: unknown query parameter", http.StatusBadRequest)
			return
		}
	}
	if vStr := q.Get("version"); vStr != "" {
		v, err := strconv.Atoi(vStr)
		if err != nil || v < 0 {
			http.Error(w, "bad request: version must be a non-negative integer", http.StatusBadRequest)
			return
		}
	}

	disc, err := g.readDiscovery()
	if err != nil {
		http.Error(w, "bad gateway: discovery configuration error", http.StatusBadGateway)
		return
	}

	targetURL := fmt.Sprintf("%s/reviews-api/%s/commits", disc.URL, reviewID)
	if len(q) > 0 {
		targetURL += "?" + q.Encode()
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}
	req.Header.Set("X-Review-Token", disc.Token)
	req.Header.Set("X-Review-Client", "remote")

	resp, err := g.client.Do(req)
	if err != nil {
		http.Error(w, "bad gateway: upstream request failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		http.Error(w, "not found: commits not found", http.StatusNotFound)
		return
	}
	if resp.StatusCode != http.StatusOK {
		http.Error(w, "bad gateway: unexpected upstream status", http.StatusBadGateway)
		return
	}

	body, err := readBoundedJSON(resp.Body, 16<<20)
	if err != nil {
		http.Error(w, "bad gateway: invalid upstream commits JSON", http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func (g *Gateway) handleGetHistory(w http.ResponseWriter, r *http.Request, reviewID string, q url.Values) {
	for k := range q {
		if k != "version" {
			http.Error(w, "bad request: unknown query parameter", http.StatusBadRequest)
			return
		}
	}
	if vStr := q.Get("version"); vStr != "" {
		v, err := strconv.Atoi(vStr)
		if err != nil || v < 0 {
			http.Error(w, "bad request: version must be a non-negative integer", http.StatusBadRequest)
			return
		}
	}

	disc, err := g.readDiscovery()
	if err != nil {
		http.Error(w, "bad gateway: discovery configuration error", http.StatusBadGateway)
		return
	}

	targetURL := fmt.Sprintf("%s/reviews-api/%s/history", disc.URL, reviewID)
	if len(q) > 0 {
		targetURL += "?" + q.Encode()
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}
	req.Header.Set("X-Review-Token", disc.Token)
	req.Header.Set("X-Review-Client", "remote")

	resp, err := g.client.Do(req)
	if err != nil {
		http.Error(w, "bad gateway: upstream request failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		http.Error(w, "not found: history not found", http.StatusNotFound)
		return
	}
	if resp.StatusCode != http.StatusOK {
		http.Error(w, "bad gateway: unexpected upstream status", http.StatusBadGateway)
		return
	}

	body, err := readBoundedJSON(resp.Body, 16<<20)
	if err != nil {
		http.Error(w, "bad gateway: invalid upstream history JSON", http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func (g *Gateway) handleGetResource(w http.ResponseWriter, r *http.Request, reviewID, resourceID string, q url.Values) {
	for k := range q {
		if k != "version" {
			http.Error(w, "bad request: unknown query parameter", http.StatusBadRequest)
			return
		}
	}
	if vStr := q.Get("version"); vStr != "" {
		v, err := strconv.Atoi(vStr)
		if err != nil || v < 0 {
			http.Error(w, "bad request: version must be a non-negative integer", http.StatusBadRequest)
			return
		}
	}

	disc, err := g.readDiscovery()
	if err != nil {
		http.Error(w, "bad gateway: discovery configuration error", http.StatusBadGateway)
		return
	}

	targetURL := fmt.Sprintf("%s/reviews-api/%s/resources/%s", disc.URL, reviewID, resourceID)
	if len(q) > 0 {
		targetURL += "?" + q.Encode()
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}
	req.Header.Set("X-Review-Token", disc.Token)
	req.Header.Set("X-Review-Client", "remote")

	resp, err := g.client.Do(req)
	if err != nil {
		http.Error(w, "bad gateway: upstream request failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		http.Error(w, "not found: resource not found", http.StatusNotFound)
		return
	}
	if resp.StatusCode != http.StatusOK {
		http.Error(w, "bad gateway: unexpected upstream status", http.StatusBadGateway)
		return
	}

	ct := resp.Header.Get("Content-Type")
	mediaType, _, _ := mime.ParseMediaType(ct)
	if mediaType != "image/png" && mediaType != "application/json" {
		http.Error(w, "bad gateway: unsupported resource content type", http.StatusBadGateway)
		return
	}

	body, err := readBoundedBody(resp.Body, 16<<20)
	if err != nil {
		http.Error(w, "bad gateway: failed to read resource data", http.StatusBadGateway)
		return
	}

	if mediaType == "application/json" && !json.Valid(body) {
		http.Error(w, "bad gateway: invalid JSON in resource response", http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", ct)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func (g *Gateway) handleGetMap(w http.ResponseWriter, r *http.Request, reviewID, resourceID string, q url.Values) {
	for k := range q {
		if k != "version" {
			http.Error(w, "bad request: unknown query parameter", http.StatusBadRequest)
			return
		}
	}
	if vStr := q.Get("version"); vStr != "" {
		v, err := strconv.Atoi(vStr)
		if err != nil || v < 0 {
			http.Error(w, "bad request: version must be a non-negative integer", http.StatusBadRequest)
			return
		}
	}

	disc, err := g.readDiscovery()
	if err != nil {
		http.Error(w, "bad gateway: discovery configuration error", http.StatusBadGateway)
		return
	}

	targetURL := fmt.Sprintf("%s/reviews-api/%s/maps/%s", disc.URL, reviewID, resourceID)
	if len(q) > 0 {
		targetURL += "?" + q.Encode()
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}
	req.Header.Set("X-Review-Token", disc.Token)
	req.Header.Set("X-Review-Client", "remote")

	resp, err := g.client.Do(req)
	if err != nil {
		http.Error(w, "bad gateway: upstream request failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		http.Error(w, "not found: map resource not found", http.StatusNotFound)
		return
	}
	if resp.StatusCode != http.StatusOK {
		http.Error(w, "bad gateway: unexpected upstream status", http.StatusBadGateway)
		return
	}

	body, err := readBoundedJSON(resp.Body, 16<<20)
	if err != nil {
		http.Error(w, "bad gateway: invalid map resource JSON", http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func (g *Gateway) handleWatch(w http.ResponseWriter, r *http.Request, q url.Values) {
	if !q.Has("subscriptions") || len(q) > 1 {
		http.Error(w, "bad request: watch requires subscriptions parameter only", http.StatusBadRequest)
		return
	}

	subParam := q.Get("subscriptions")
	dec := json.NewDecoder(strings.NewReader(subParam))
	dec.DisallowUnknownFields()
	var rawSubs []map[string]json.RawMessage
	if err := dec.Decode(&rawSubs); err != nil {
		http.Error(w, "bad request: invalid subscriptions json", http.StatusBadRequest)
		return
	}
	var extra json.RawMessage
	if err := dec.Decode(&extra); err != io.EOF {
		http.Error(w, "bad request: trailing data in subscriptions", http.StatusBadRequest)
		return
	}
	if len(rawSubs) < 1 || len(rawSubs) > 2 {
		http.Error(w, "bad request: subscriptions must contain 1 or 2 items", http.StatusBadRequest)
		return
	}

	type subItem struct {
		ReviewID *string `json:"reviewId"`
	}
	subs := make([]subItem, len(rawSubs))
	for i, raw := range rawSubs {
		if len(raw) != 1 {
			http.Error(w, "bad request: subscription object must contain exactly reviewId", http.StatusBadRequest)
			return
		}
		rawVal, ok := raw["reviewId"]
		if !ok {
			http.Error(w, "bad request: subscription object missing reviewId", http.StatusBadRequest)
			return
		}
		if string(rawVal) == "null" {
			subs[i].ReviewID = nil
		} else {
			var str string
			if err := json.Unmarshal(rawVal, &str); err != nil {
				http.Error(w, "bad request: reviewId must be string or null", http.StatusBadRequest)
				return
			}
			if !idRegex.MatchString(str) {
				http.Error(w, "bad request: invalid reviewId in subscription", http.StatusBadRequest)
				return
			}
			subs[i].ReviewID = &str
		}
	}

	normalizedJSON, err := json.Marshal(subs)
	if err != nil {
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}

	disc, err := g.readDiscovery()
	if err != nil {
		http.Error(w, "bad gateway: discovery configuration error", http.StatusBadGateway)
		return
	}

	upstreamURL := fmt.Sprintf("%s/reviews-api/watch?subscriptions=%s", disc.URL, url.QueryEscape(string(normalizedJSON)))
	upstreamReq, err := http.NewRequestWithContext(r.Context(), http.MethodGet, upstreamURL, nil)
	if err != nil {
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}
	upstreamReq.Header.Set("X-Review-Token", disc.Token)
	upstreamReq.Header.Set("X-Review-Client", "remote")

	resp, err := g.client.Do(upstreamReq)
	if err != nil {
		http.Error(w, "bad gateway: upstream watch failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		http.Error(w, "bad gateway: upstream watch returned non-200", http.StatusBadGateway)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	scanner := bufio.NewScanner(resp.Body)
	buf := make([]byte, 4096)
	const maxLineSize = 1 << 20 // 1MiB
	scanner.Buffer(buf, maxLineSize+1)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) > maxLineSize {
			return
		}
		if !json.Valid(line) {
			return
		}
		lineWithNewline := append(line, '\n')
		if _, writeErr := w.Write(lineWithNewline); writeErr != nil {
			return
		}
		flusher.Flush()
	}
}

type markdownPutRequest struct {
	Version  *int    `json:"version"`
	Markdown *string `json:"markdown"`
}

type snapshotDocNode struct {
	Type     string            `json:"type"`
	ID       string            `json:"id"`
	Title    string            `json:"title,omitempty"`
	Markdown string            `json:"markdown,omitempty"`
	Children []snapshotDocNode `json:"children,omitempty"`
}

type snapshotEnvelope struct {
	ReviewID *string           `json:"reviewId"`
	Version  *int              `json:"version"`
	Document []snapshotDocNode `json:"document"`
}

func findDocNode(nodes []snapshotDocNode, targetID string) (*snapshotDocNode, bool) {
	for i := range nodes {
		if nodes[i].ID == targetID {
			return &nodes[i], true
		}
		if len(nodes[i].Children) > 0 {
			if n, ok := findDocNode(nodes[i].Children, targetID); ok {
				return n, true
			}
		}
	}
	return nil, false
}

func (g *Gateway) handlePutMarkdown(w http.ResponseWriter, r *http.Request, reviewID, blockID string) {
	ct := r.Header.Get("Content-Type")
	mediaType, _, err := mime.ParseMediaType(ct)
	if err != nil || mediaType != "application/json" {
		http.Error(w, "unsupported media type: Content-Type must be application/json", http.StatusUnsupportedMediaType)
		return
	}

	bodyBytes, err := readBoundedBody(r.Body, 1<<20)
	if err != nil {
		if err.Error() == "response body exceeds size limit" {
			http.Error(w, "payload too large: body exceeds 1MiB limit", http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, "bad request: failed to read body", http.StatusBadRequest)
		}
		return
	}

	dec := json.NewDecoder(bytes.NewReader(bodyBytes))
	dec.DisallowUnknownFields()
	var req markdownPutRequest
	if err := dec.Decode(&req); err != nil {
		http.Error(w, "bad request: invalid JSON body", http.StatusBadRequest)
		return
	}
	var extra json.RawMessage
	if err := dec.Decode(&extra); err != io.EOF {
		http.Error(w, "bad request: trailing data in JSON body", http.StatusBadRequest)
		return
	}

	if req.Version == nil {
		http.Error(w, "bad request: version field is required", http.StatusBadRequest)
		return
	}
	if *req.Version < 0 {
		http.Error(w, "bad request: version must be a non-negative integer", http.StatusBadRequest)
		return
	}
	if req.Markdown == nil {
		http.Error(w, "bad request: markdown field is required", http.StatusBadRequest)
		return
	}

	disc, err := g.readDiscovery()
	if err != nil {
		http.Error(w, "bad gateway: discovery configuration error", http.StatusBadGateway)
		return
	}

	// 1. Fetch fresh snapshot
	snapCtx, snapCancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer snapCancel()

	snapReq, err := http.NewRequestWithContext(snapCtx, http.MethodGet, disc.URL+"/reviews-api/"+reviewID+"?full=true", nil)
	if err != nil {
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}
	snapReq.Header.Set("X-Review-Token", disc.Token)
	snapReq.Header.Set("X-Review-Client", "remote")

	snapResp, err := g.client.Do(snapReq)
	if err != nil {
		http.Error(w, "bad gateway: failed to read snapshot from upstream", http.StatusBadGateway)
		return
	}
	defer snapResp.Body.Close()

	if snapResp.StatusCode == http.StatusNotFound {
		http.Error(w, "not found: review not found", http.StatusNotFound)
		return
	}
	if snapResp.StatusCode != http.StatusOK {
		http.Error(w, "bad gateway: unexpected snapshot response status", http.StatusBadGateway)
		return
	}

	snapBody, err := readBoundedJSON(snapResp.Body, 16<<20)
	if err != nil {
		http.Error(w, "bad gateway: invalid upstream snapshot schema", http.StatusBadGateway)
		return
	}

	var snapshot snapshotEnvelope
	if err := json.Unmarshal(snapBody, &snapshot); err != nil {
		http.Error(w, "bad gateway: invalid upstream snapshot schema", http.StatusBadGateway)
		return
	}
	if snapshot.ReviewID == nil || *snapshot.ReviewID != reviewID || snapshot.Version == nil || *snapshot.Version < 0 || snapshot.Document == nil {
		http.Error(w, "bad gateway: invalid upstream snapshot schema", http.StatusBadGateway)
		return
	}

	// 2. Version conflict check
	if *snapshot.Version != *req.Version {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": fmt.Sprintf("version conflict: current version %d does not match submitted version %d", *snapshot.Version, *req.Version),
		})
		return
	}

	// 3. Recursive document search for target block
	targetNode, found := findDocNode(snapshot.Document, blockID)
	if !found {
		http.Error(w, "not found: markdown block not found in document", http.StatusNotFound)
		return
	}
	if targetNode.Type != "markdown" {
		http.Error(w, fmt.Sprintf("bad request: target block %q is type %q, expected markdown", blockID, targetNode.Type), http.StatusBadRequest)
		return
	}

	// shortcut: version check cannot prevent racing edits, upgrade when Whiteboard adds atomic expected-version writes.
	cmdPayload := map[string]any{
		"operation": map[string]any{
			"type":     "edit",
			"reviewId": reviewID,
			"edit": map[string]any{
				"type":     "update",
				"targetId": blockID,
				"changes": map[string]any{
					"markdown": *req.Markdown,
				},
			},
		},
	}
	cmdBytes, err := json.Marshal(cmdPayload)
	if err != nil {
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}

	// 4. Send upstream command (never retry automatically)
	cmdCtx, cmdCancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cmdCancel()

	cmdReq, err := http.NewRequestWithContext(cmdCtx, http.MethodPost, disc.URL+"/reviews-api/commands", bytes.NewReader(cmdBytes))
	if err != nil {
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}
	cmdReq.Header.Set("Content-Type", "application/json")
	cmdReq.Header.Set("X-Review-Token", disc.Token)
	cmdReq.Header.Set("X-Review-Client", "remote")

	cmdResp, err := g.client.Do(cmdReq)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusGatewayTimeout)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error": "save outcome unknown, reread before retry",
		})
		return
	}
	defer cmdResp.Body.Close()

	if cmdResp.StatusCode == http.StatusConflict {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "version conflict"})
		return
	}
	if cmdResp.StatusCode == http.StatusNotFound {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "review not found"})
		return
	}
	if cmdResp.StatusCode != http.StatusOK && cmdResp.StatusCode != http.StatusCreated {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "save outcome unknown, reread before retry"})
		return
	}

	cmdResultBytes, err := readBoundedJSON(cmdResp.Body, 16<<20)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "save outcome unknown, reread before retry"})
		return
	}

	type commandResult struct {
		ReviewID *string `json:"reviewId"`
		Version  *int    `json:"version"`
	}
	var res commandResult
	if err := json.Unmarshal(cmdResultBytes, &res); err != nil || res.ReviewID == nil || *res.ReviewID != reviewID || res.Version == nil || *res.Version < *req.Version {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "save outcome unknown, reread before retry"})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(cmdResultBytes)
}

func (g *Gateway) handleStatic(w http.ResponseWriter, r *http.Request) {
	if g.assets == nil {
		http.Error(w, "asset not found", http.StatusNotFound)
		return
	}

	p := r.URL.Path
	if hasDotDot(p) {
		http.Error(w, "asset not found", http.StatusNotFound)
		return
	}

	var target string
	if p == "/" || p == "/index.html" {
		target = "index.html"
	} else {
		if strings.HasSuffix(p, "/") {
			http.Error(w, "asset not found", http.StatusNotFound)
			return
		}
		clean := path.Clean(strings.TrimPrefix(p, "/"))
		if clean == "." || clean == "" || strings.HasPrefix(clean, "..") {
			http.Error(w, "asset not found", http.StatusNotFound)
			return
		}
		target = clean
	}

	f, err := g.assets.Open(target)
	if err != nil {
		http.Error(w, "asset not found", http.StatusNotFound)
		return
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil || stat.IsDir() || !stat.Mode().IsRegular() {
		http.Error(w, "asset not found", http.StatusNotFound)
		return
	}

	ctype := mime.TypeByExtension(filepath.Ext(target))
	if target == "index.html" && ctype == "" {
		ctype = "text/html; charset=utf-8"
	} else if ctype == "" {
		ctype = "application/octet-stream"
	}

	w.Header().Set("Content-Type", ctype)
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}

	_, _ = io.Copy(w, f)
}
