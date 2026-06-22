import { useEffect, useState } from "react";
import { themeVars } from "./palette";
import {
  getAuthStatus,
  performRegistration,
  performAuthentication
} from "./auth";
import App from "./App";

function AuthScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell" style={themeVars("dark")}>
      <div className="flex min-h-screen items-center justify-center p-6">
        <div
          className="w-full max-w-sm rounded-app border p-8"
          style={{ background: "var(--background-surface)", borderColor: "var(--border-default)" }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function BootstrapScreen({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("My Passkey");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleRegister() {
    setError("");
    setBusy(true);
    try {
      await performRegistration(name.trim() || "Passkey");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Registration failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScreen>
      <div className="mb-6 flex flex-col gap-1">
        <h1 className="text-base font-bold" style={{ color: "var(--foreground-primary)" }}>
          First-time setup
        </h1>
        <p className="text-sm" style={{ color: "var(--foreground-secondary)" }}>
          Create a passkey to secure your Task Tracker. You can add more passkeys from Settings after signing in.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="label" style={{ color: "var(--foreground-secondary)" }}>
            Passkey name
          </label>
          <input
            className="input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Passkey"
            disabled={busy}
          />
        </div>

        {error && (
          <p className="text-sm" style={{ color: "var(--status-red-text)" }}>{error}</p>
        )}

        <button
          className="btn btn-primary w-full"
          onClick={handleRegister}
          disabled={busy}
        >
          {busy ? "Waiting for passkey…" : "Create passkey"}
        </button>
      </div>
    </AuthScreen>
  );
}

function SignInScreen({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSignIn() {
    setError("");
    setBusy(true);
    try {
      await performAuthentication();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Authentication failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScreen>
      <div className="mb-6 flex flex-col gap-1">
        <h1 className="text-base font-bold" style={{ color: "var(--foreground-primary)" }}>
          Task Tracker
        </h1>
        <p className="text-sm" style={{ color: "var(--foreground-secondary)" }}>
          Sign in with your passkey to continue.
        </p>
      </div>

      {error && (
        <p className="mb-4 text-sm" style={{ color: "var(--status-red-text)" }}>{error}</p>
      )}

      <button
        className="btn btn-primary w-full"
        onClick={handleSignIn}
        disabled={busy}
      >
        {busy ? "Waiting for passkey…" : "Sign in with passkey"}
      </button>
    </AuthScreen>
  );
}

function LoadingScreen() {
  return (
    <div className="app-shell" style={themeVars("dark")}>
      <div className="flex min-h-screen items-center justify-center">
        <span className="text-sm" style={{ color: "var(--foreground-tertiary)" }}>Loading…</span>
      </div>
    </div>
  );
}

type AuthState = "loading" | "bootstrapping" | "unauthenticated" | "authenticated";

export default function AuthGate() {
  const [authState, setAuthState] = useState<AuthState>("loading");

  useEffect(() => {
    getAuthStatus().then(({ authenticated, bootstrapMode }) => {
      if (authenticated) setAuthState("authenticated");
      else if (bootstrapMode) setAuthState("bootstrapping");
      else setAuthState("unauthenticated");
    }).catch(() => {
      setAuthState("unauthenticated");
    });
  }, []);

  if (authState === "loading") return <LoadingScreen />;
  if (authState === "bootstrapping") return <BootstrapScreen onDone={() => setAuthState("authenticated")} />;
  if (authState === "unauthenticated") return <SignInScreen onDone={() => setAuthState("authenticated")} />;
  return <App onUnauthorized={() => setAuthState("unauthenticated")} />;
}
