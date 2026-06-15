/** Reactive current-session store (Svelte 5 runes). The single source of truth for "who am I". */
import * as api from "./api.ts";
import type { User } from "./api.ts";

class SessionStore {
  user = $state<User | null>(null);
  /** loading → checking the cookie on boot; ready → resolved (user or null). */
  status = $state<"loading" | "ready">("loading");

  get isAdmin(): boolean {
    return this.user?.role === "admin";
  }

  /** Resolves the session cookie on app boot. */
  async refresh(): Promise<void> {
    try {
      this.user = await api.me();
    } finally {
      this.status = "ready";
    }
  }

  async login(email: string, password: string): Promise<void> {
    this.user = await api.login(email, password);
  }

  async logout(): Promise<void> {
    await api.logout();
    this.user = null;
  }
}

export const session = new SessionStore();
