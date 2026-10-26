// Decides whether this browser can run Hyperion and, if not, explains why in
// specific, fixable terms. The decision itself (diagnose) is a pure function
// of plain facts, so it can be unit-tested without a browser.

export interface EnvironmentFacts {
  secureContext: boolean; // page served over https:// or from localhost
  hasWebGpuApi: boolean; // navigator.gpu exists
  adapterFound: boolean; // navigator.gpu.requestAdapter() returned an adapter
  userAgent: string; // only used to tailor advice, never to decide
  origin: string; // e.g. "http://192.168.1.20:5173", quoted in the message
}

export type ProblemReason =
  | 'insecure-context'
  | 'no-webgpu'
  | 'no-adapter'
  | 'device-failed'
  | 'device-lost-repeatedly';

export interface Problem {
  reason: ProblemReason;
  title: string;
  explanation: string;
  advice: string[];
}

export function diagnose(facts: EnvironmentFacts): Problem | null {
  // Order matters. In an insecure context navigator.gpu doesn't exist at all
  // (the spec marks it [SecureContext]), so this check must come first or
  // we'd wrongly blame the browser.
  // https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts
  if (!facts.secureContext) {
    return {
      reason: 'insecure-context',
      title: 'This page needs a secure connection',
      explanation: `WebGPU only works on pages served over HTTPS or from localhost. This page was opened from ${facts.origin}.`,
      advice: [
        'If you started the dev server yourself, open it through localhost (for example http://localhost:5173) instead of a network address.',
        'If the page is hosted somewhere, use its https:// address.',
      ],
    };
  }
  if (!facts.hasWebGpuApi) {
    return {
      reason: 'no-webgpu',
      title: "This browser doesn't support WebGPU",
      explanation:
        'Hyperion renders with WebGPU, the browser API for modern GPU features. This browser, or its current version on this operating system, does not provide it.',
      advice: adviceForMissingWebGpu(browserFamily(facts.userAgent)),
    };
  }
  if (!facts.adapterFound) {
    return {
      reason: 'no-adapter',
      title: 'WebGPU is available, but no GPU was offered',
      explanation:
        'The browser supports WebGPU but did not provide a GPU adapter. That usually means the GPU or its driver is blocked or disabled, not that the browser is too old.',
      advice: [
        'Make sure hardware acceleration is turned on in the browser settings.',
        'Update your GPU driver: browsers block drivers with known bugs.',
        'Remote desktop sessions and virtual machines often have no usable GPU.',
        'In Chrome or Edge, open chrome://gpu and look at the "WebGPU" line.',
      ],
    };
  }
  return null;
}

export type BrowserFamily = 'chromium' | 'firefox' | 'safari' | 'other';

// User-agent sniffing is unreliable, so it only picks which advice to show.
// It never decides whether we try to run.
export function browserFamily(userAgent: string): BrowserFamily {
  if (/Firefox\//.test(userAgent)) return 'firefox';
  if (/(Chrome|Chromium|Edg)\//.test(userAgent)) return 'chromium';
  if (/Version\/[\d.]+.*Safari\//.test(userAgent)) return 'safari';
  return 'other';
}

// Support facts below were checked on 2026-10-23 against:
// https://github.com/gpuweb/gpuweb/wiki/Implementation-Status
// https://developer.chrome.com/blog/new-in-webgpu-144 (Linux)
// https://www.firefox.com/en-US/firefox/147.0/releasenotes/
// https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
function adviceForMissingWebGpu(family: BrowserFamily): string[] {
  switch (family) {
    case 'chromium':
      return [
        'Update Chrome or Edge. WebGPU is on by default on Windows, macOS and ChromeOS (version 113+) and Android 12+ (121+).',
        'On Linux it is on by default only for some GPUs so far (Intel Gen12+ from 144, NVIDIA on Wayland from 147).',
        'Open chrome://gpu and check the "WebGPU" line to see why it is off.',
      ];
    case 'firefox':
      return [
        'Firefox has WebGPU on Windows (141+) and on Apple Silicon Macs (145+ on macOS Tahoe, 147+ on any macOS).',
        'On Linux and Intel Macs it is only in Firefox Nightly so far. Chrome or Edge will work there.',
      ];
    case 'safari':
      return [
        'Safari has WebGPU from Safari 26. On a Mac it also requires macOS Tahoe 26 or later.',
        'Update macOS or iOS, or try Chrome.',
      ];
    case 'other':
      return ['Use a current Chrome or Edge, Safari 26+, or Firefox 141+ on Windows.'];
  }
}

export function deviceFailure(error: unknown): Problem {
  const message = error instanceof Error ? error.message : String(error);
  return {
    reason: 'device-failed',
    title: 'The GPU refused to start',
    explanation: `The browser found a GPU but could not create a WebGPU device on it: ${message}`,
    advice: ['Reload the page.', 'Update your GPU driver.', 'Close other GPU-heavy tabs or apps and try again.'],
  };
}

export function lostTooOften(lastMessage: string): Problem {
  return {
    reason: 'device-lost-repeatedly',
    title: 'The GPU keeps resetting',
    explanation: `The GPU device was lost several times within a minute, so Hyperion stopped retrying. Last message: ${lastMessage || '(none)'}`,
    advice: ['Reload the page to try again.', 'Update your GPU driver.', 'Close other GPU-heavy tabs or apps.'],
  };
}

// ?simulate=... lets you preview each failure message on a machine where
// everything works.
export type Simulation = 'insecure' | 'no-webgpu' | 'no-adapter';
const SIMULATIONS: readonly Simulation[] = ['insecure', 'no-webgpu', 'no-adapter'];

export function parseSimulation(search: string): Simulation | null {
  const value = new URLSearchParams(search).get('simulate');
  return SIMULATIONS.find((s) => s === value) ?? null;
}

export function applySimulation(facts: EnvironmentFacts, simulation: Simulation | null): EnvironmentFacts {
  switch (simulation) {
    case null:
      return facts;
    case 'insecure': // a real insecure page has no navigator.gpu either
      return { ...facts, secureContext: false, hasWebGpuApi: false, adapterFound: false };
    case 'no-webgpu':
      return { ...facts, hasWebGpuApi: false, adapterFound: false };
    case 'no-adapter':
      return { ...facts, adapterFound: false };
  }
}

// The browser-facing part: gathers the facts, then asks diagnose().
export async function probe(
  simulation: Simulation | null,
): Promise<{ adapter: GPUAdapter } | { problem: Problem }> {
  // TypeScript's types declare navigator.gpu as always present, but browsers
  // without WebGPU simply don't have it, so check at runtime.
  const hasWebGpuApi = 'gpu' in navigator;
  let adapter: GPUAdapter | null = null;
  if (hasWebGpuApi && simulation === null) {
    try {
      // Resolves to null (rather than throwing) when no suitable GPU is
      // available: https://developer.mozilla.org/en-US/docs/Web/API/GPU/requestAdapter
      adapter = await navigator.gpu.requestAdapter();
    } catch (error) {
      console.warn('[WebGPU] requestAdapter() threw:', error);
    }
  }
  const facts = applySimulation(
    {
      secureContext: window.isSecureContext,
      hasWebGpuApi,
      adapterFound: adapter !== null,
      userAgent: navigator.userAgent,
      origin: location.origin,
    },
    simulation,
  );
  const problem = diagnose(facts);
  if (problem) return { problem };
  if (adapter === null) throw new Error('diagnose() should have reported the missing adapter');
  return { adapter };
}
