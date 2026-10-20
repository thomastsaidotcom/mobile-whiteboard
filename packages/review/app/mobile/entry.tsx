import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";

import "../src/styles.css";
import "./reset.css";

interface MobileErrorState {
  error?: Error;
}

class MobileErrorBoundary extends Component<
  { children: ReactNode },
  MobileErrorState
> {
  state: MobileErrorState = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? (
      <main role="alert">
        <h1>Could not open this review</h1>
        <p>{this.state.error.message}</p>
        <a href="/">Back to reviews</a>
      </main>
    ) : (
      this.props.children
    );
  }
}

const container = document.getElementById("root");

if (!container) throw new Error("Mobile app container is missing.");

const client = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      staleTime: 1000,
    },
  },
});

createRoot(container).render(
  <MobileErrorBoundary>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </MobileErrorBoundary>,
);
