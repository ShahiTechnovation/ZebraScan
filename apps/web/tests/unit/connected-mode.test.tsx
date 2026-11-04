import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/scan",
}));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("connected mode without live adapters (acceptance 10)", () => {
  it("registry returns no services — never falls back to demo", async () => {
    vi.stubEnv("NEXT_PUBLIC_ZEB_MODE", "connected");
    const { getServices } = await import("@/services/registry");
    expect(getServices()).toBeNull();
  });

  it("demo mode returns demo services", async () => {
    vi.stubEnv("NEXT_PUBLIC_ZEB_MODE", "demo");
    const { getServices } = await import("@/services/registry");
    expect(getServices()?.kind).toBe("demo");
  });

  it("Scan & Pay shows not-connected state, no demo sample, no simulation", async () => {
    vi.stubEnv("NEXT_PUBLIC_ZEB_MODE", "connected");
    const { ZebProvider } = await import("@/providers/ZebProvider");
    const { ToastProvider } = await import("@/providers/ToastProvider");
    const { ScanPayWizard } = await import("@/components/screens/ScanPayWizard");
    render(
      <ZebProvider>
        <ToastProvider>
          <ScanPayWizard />
        </ToastProvider>
      </ZebProvider>,
    );
    expect(screen.getAllByText(/Live payments are not connected in this build/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Simulate/)).toBeNull();
  });

  it("merchant console is not available and exposes no demo sign-in", async () => {
    vi.stubEnv("NEXT_PUBLIC_ZEB_MODE", "connected");
    const { ZebProvider } = await import("@/providers/ZebProvider");
    const { ToastProvider } = await import("@/providers/ToastProvider");
    const { AppShell } = await import("@/components/layout/AppShell");
    render(
      <ZebProvider>
        <ToastProvider>
          <AppShell>
            <p>secret console</p>
          </AppShell>
        </ToastProvider>
      </ZebProvider>,
    );
    expect(screen.queryByText("secret console")).toBeNull();
    expect(screen.queryByRole("button", { name: "Explore demo merchant account" })).toBeNull();
    expect(screen.getAllByText(/not connected/i).length).toBeGreaterThan(0);
  });
});
