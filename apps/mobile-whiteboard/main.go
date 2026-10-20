package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func main() {
	homeDir, _ := os.UserHomeDir()
	defaultDiscovery := ""
	if homeDir != "" {
		defaultDiscovery = filepath.Join(homeDir, ".dev", "review-desktop", "instances", "stable.json")
	}

	listenFlag := flag.String("listen", "127.0.0.1:8080", "Listen address (loopback IPv4 only, e.g. 127.0.0.1:8080)")
	originFlag := flag.String("origin", "http://127.0.0.1:8080", "Exact allowed origin (http://127.0.0.1:<port> for dev, https://*.ts.net for remote)")
	discoveryFlag := flag.String("discovery", defaultDiscovery, "Path to desktop instances discovery JSON file")
	assetsDirFlag := flag.String("assets-dir", "../../packages/review/app/dist/mobile", "Directory containing built mobile web assets (relative to the working directory)")

	flag.Parse()

	if err := ValidateListen(*listenFlag); err != nil {
		log.Fatalf("invalid -listen: %v", err)
	}

	normOrigin, _, err := ValidateOrigin(*originFlag)
	if err != nil {
		log.Fatalf("invalid -origin: %v", err)
	}

	discPath := *discoveryFlag
	if strings.HasPrefix(discPath, "~/") {
		if homeDir != "" {
			discPath = filepath.Join(homeDir, discPath[2:])
		}
	}
	if discPath == "" {
		log.Fatal("discovery path cannot be empty")
	}

	handler, err := NewGateway(Options{
		Origin:        normOrigin,
		Listen:        *listenFlag,
		DiscoveryPath: discPath,
		AssetsDir:     *assetsDirFlag,
	})
	if err != nil {
		log.Fatalf("failed to initialize gateway: %v", err)
	}

	server := &http.Server{
		Addr:              *listenFlag,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log.Printf("Starting Mobile Whiteboard gateway on %s (origin: %s)", *listenFlag, normOrigin)

	serverErr := make(chan error, 1)
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
	}()

	select {
	case err := <-serverErr:
		log.Fatalf("server error: %v", err)
	case <-ctx.Done():
		log.Println("Shutting down server gracefully...")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("server shutdown error: %v", err)
		}
	}
}
