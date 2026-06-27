import { atom } from 'nanostores'

import { $rightRailActiveTabId, PREVIEW_PANE_ID, RIGHT_RAIL_BROWSER_TAB_ID, selectRightRailTab } from './layout'
import { setPaneOpen } from './panes'

// The in-app browser is a persistent, navigable webview tab in the right rail —
// distinct from the preview pane (which pins a single artifact/URL). The user
// (or the agent, via the gateway browser bridge) drives it like a real browser:
// address bar, back/forward/reload. State here is the single source of truth the
// BrowserPane chrome renders from; the live webview pushes nav events back into
// it via setBrowserNavState.

export interface BrowserState {
  /** Whether the live webview can navigate back in its history. */
  canGoBack: boolean
  /** Whether the live webview can navigate forward in its history. */
  canGoForward: boolean
  /** True while a navigation is in flight (drives the reload/stop affordance). */
  loading: boolean
  /** Last load error description, or null when the current page loaded cleanly. */
  loadError: string | null
  /** Whether the browser tab is open (mounted in the right rail). */
  open: boolean
  /** Document title reported by the live page, for the tab label. */
  title: string
  /** The URL the webview should display. Changing this navigates the webview. */
  url: string
}

// A one-shot navigation command bumped to force the webview to (re)load `url`
// even when the string is unchanged (e.g. an explicit reload, or re-opening the
// same address). The pane reads `requestedUrl` + `nonce`; bumping nonce alone
// triggers a reload of the current page.
export interface BrowserNavRequest {
  nonce: number
  url: string
}

export const DEFAULT_BROWSER_URL = 'https://duckduckgo.com'

const EMPTY: BrowserState = {
  canGoBack: false,
  canGoForward: false,
  loading: false,
  loadError: null,
  open: false,
  title: '',
  url: ''
}

export const $browserState = atom<BrowserState>(EMPTY)
export const $browserNavRequest = atom<BrowserNavRequest>({ nonce: 0, url: '' })

// Normalize a user/address-bar string into a navigable URL. A bare host
// (example.com) gets https://; anything with spaces or no dot becomes a
// DuckDuckGo search, matching browser omnibox behavior.
export function normalizeBrowserInput(input: string): string {
  const raw = input.trim()

  if (!raw) {
    return ''
  }

  // Already a full URL (http/https/file/about/data) — pass through.
  if (/^(https?|file|about|data):/i.test(raw)) {
    return raw
  }

  // Looks like a bare host[:port][/path] with no spaces and a dot or localhost.
  const looksLikeHost = !/\s/.test(raw) && (/^[^\s/]+\.[^\s/]+/.test(raw) || /^localhost(:\d+)?(\/|$)/i.test(raw))

  if (looksLikeHost) {
    return `https://${raw}`
  }

  return `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`
}

/** Open the browser tab and navigate to `input` (a URL or a search query). */
export function openBrowser(input?: string): string {
  const url = input ? normalizeBrowserInput(input) : $browserState.get().url || DEFAULT_BROWSER_URL

  $browserState.set({
    ...$browserState.get(),
    loadError: null,
    open: true,
    url
  })
  $browserNavRequest.set({ nonce: $browserNavRequest.get().nonce + 1, url })
  selectRightRailTab(RIGHT_RAIL_BROWSER_TAB_ID)
  // The right rail only takes a layout column when its pane container is open.
  // openBrowser must force the preview pane open or the webview renders into a
  // zero-width (invisible) rail. (Regressed when the upstream merge coupled
  // railColumnOpen to the persisted previewPaneOpen atom.)
  setPaneOpen(PREVIEW_PANE_ID, true)

  return url
}

/** Navigate the (already open) browser to a new address. Opens it if closed. */
export function navigateBrowser(input: string): string {
  return openBrowser(input)
}

// Decide where a web link opens. Default: the in-app browser panel (fast,
// on-the-fly preview without leaving Hermes). A modifier (⌘/Ctrl) or a
// middle-click routes to the system browser instead — matching VS Code/Cursor's
// "open in editor vs. open externally" muscle memory.
export function openWebLink(
  url: string,
  modifiers?: { metaKey?: boolean; ctrlKey?: boolean; button?: number }
): void {
  if (!url) {
    return
  }

  const wantsSystem = Boolean(modifiers?.metaKey || modifiers?.ctrlKey || modifiers?.button === 1)

  if (wantsSystem) {
    void window.hermesDesktop?.openExternal?.(url)

    return
  }

  // In-app browser only handles http(s); fall back to the OS for other schemes.
  if (/^https?:\/\//i.test(url)) {
    openBrowser(url)

    return
  }

  void window.hermesDesktop?.openExternal?.(url)
}

/** Force a reload of the current page without changing the URL. */
export function reloadBrowser() {
  const { url } = $browserState.get()

  if (!url) {
    return
  }

  $browserState.set({ ...$browserState.get(), loadError: null })
  $browserNavRequest.set({ nonce: $browserNavRequest.get().nonce + 1, url })
}

/**
 * Open the page currently shown in the in-app browser in the OS default
 * browser. This is the escape hatch for logins the embedded webview can't
 * complete — most importantly WebAuthn *passkeys* (Touch ID): Electron's
 * bundled Chromium has no macOS platform-authenticator bridge, and an unsigned
 * build is blocked from the secure enclave regardless, so a passkey challenge
 * hangs forever in the panel. The real, OS-integrated browser handles it.
 * Returns the URL handed off, or '' when there's nothing to open.
 */
export function openCurrentInSystemBrowser(): string {
  const { url } = $browserState.get()

  if (!url || !/^https?:\/\//i.test(url)) {
    return ''
  }

  void window.hermesDesktop?.openExternal?.(url)

  return url
}

/** Push live navigation state from the webview back into the store. */
export function setBrowserNavState(patch: Partial<Omit<BrowserState, 'open'>>) {
  $browserState.set({ ...$browserState.get(), ...patch })
}

/** Close the browser tab and reset its nav chrome (URL is retained for reopen). */
export function closeBrowser() {
  const { url } = $browserState.get()

  $browserState.set({ ...EMPTY, url })

  if ($rightRailActiveTabId.get() === RIGHT_RAIL_BROWSER_TAB_ID) {
    selectRightRailTab($rightRailActiveTabId.get())
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Live webview registry for agentic interaction (act/extract/screenshot)
// ──────────────────────────────────────────────────────────────────────────────

// The agent tools need access to the live <webview> element (to call
// executeJavaScript, capturePage, sendInputEvent), but use-message-stream.ts
// only has access to $browserState (nav-state), not the element. This registry
// lets browser-pane.tsx publish the webview when it's created, so the gateway
// bridge handlers in use-message-stream.ts can reach it.
let liveWebview: object | null = null

export function registerBrowserWebview(wv: object | null) {
  liveWebview = wv
}

export function getBrowserWebview() {
  return liveWebview
}
