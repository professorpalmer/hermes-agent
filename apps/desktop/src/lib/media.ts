import { readDesktopFileDataUrl } from '@/lib/desktop-fs'
import { $connection } from '@/store/session'

export type MediaKind = 'audio' | 'image' | 'video' | 'file'

interface MediaInfo {
  kind: MediaKind
  mime: string
}

const MEDIA_BY_EXT: Record<string, MediaInfo> = {
  avi: { kind: 'video', mime: 'video/x-msvideo' },
  bmp: { kind: 'image', mime: 'image/bmp' },
  flac: { kind: 'audio', mime: 'audio/flac' },
  gif: { kind: 'image', mime: 'image/gif' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  m4a: { kind: 'audio', mime: 'audio/mp4' },
  mkv: { kind: 'video', mime: 'video/x-matroska' },
  mov: { kind: 'video', mime: 'video/quicktime' },
  mp3: { kind: 'audio', mime: 'audio/mpeg' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  ogg: { kind: 'audio', mime: 'audio/ogg' },
  opus: { kind: 'audio', mime: 'audio/ogg; codecs=opus' },
  png: { kind: 'image', mime: 'image/png' },
  svg: { kind: 'image', mime: 'image/svg+xml' },
  wav: { kind: 'audio', mime: 'audio/wav' },
  webm: { kind: 'video', mime: 'video/webm' },
  webp: { kind: 'image', mime: 'image/webp' }
}

function mediaInfo(path: string): MediaInfo | undefined {
  const ext = path.split(/[?#]/, 1)[0]?.split('.').pop()?.toLowerCase()

  return ext ? MEDIA_BY_EXT[ext] : undefined
}

export function mediaKind(path: string): MediaKind {
  return mediaInfo(path)?.kind ?? 'file'
}

export function mediaMime(path: string): string {
  return mediaInfo(path)?.mime ?? 'application/octet-stream'
}

export function mediaName(path: string): string {
  try {
    const url = new URL(path)

    return url.pathname.split('/').filter(Boolean).pop() || path
  } catch {
    return path.split(/[\\/]/).filter(Boolean).pop() || path
  }
}

export function mediaMarkdownHref(path: string): string {
  return `#media:${encodeURIComponent(path)}`
}

// Build a `file://` URL from a local absolute path with per-segment encoding.
//
// The old `file://${path}` string concat broke three ways, all of which made a
// chat link a silent dead end (the main process rejects the malformed URL and
// the click/copy does nothing):
//   1. A path with URL-special chars (`#`, `?`, spaces) was truncated at the
//      first `#`/`?` — `new URL('file:///tmp/a#b.png')` drops `#b.png` as a
//      fragment, so the shell opened the wrong path (or ENOENT'd).
//   2. A RELATIVE path (`hermes-support-slack.png`) became
//      `file://hermes-support-slack.png`, where the filename is parsed as the
//      URL *host* — rejected on macOS/Linux ("file URL host must be empty").
//   3. A `~/...` path hit the same host-parse failure.
//
// Per-segment `encodeURIComponent` keeps each path component intact (spaces,
// `#`, `?`, unicode all survive a `new URL()` round-trip). Relative and `~`
// paths are returned RAW so the main process can resolve them with a real
// home-dir/cwd base (`resolveRequestedPathForIpc`) — `new URL` can't.
export function toLocalFileUrl(path: string): string {
  if (/^file:/i.test(path)) {
    return path
  }

  // Normalize Windows separators so segment-splitting is uniform.
  let p = path.replace(/\\/g, '/')

  // Windows drive path (`C:/...`) → `/C:/...` so it parses as an absolute
  // file URL. The drive-letter colon stays literal (canonical Node form).
  const driveMatch = /^([a-zA-Z]):(\/.*)?$/.exec(p)

  if (driveMatch) {
    const rest = (driveMatch[2] ?? '/')
      .split('/')
      .map(seg => encodeURIComponent(seg))
      .join('/')

    return `file:///${driveMatch[1]}:${rest}`
  }

  // Relative or tilde path: the renderer can't resolve it (no cwd/home), and
  // `file://<relative>` mis-parses the first segment as a host. Hand the raw
  // path to the main process, which expands `~` and resolves against a base.
  if (!p.startsWith('/')) {
    return p
  }

  const encoded = p
    .split('/')
    .map(seg => encodeURIComponent(seg))
    .join('/')

  return `file://${encoded}`
}

// Resolve a media path to a URL the shell can open. Remote mode rewrites
// gateway-local paths to an authenticated /api/files/download URL (the file
// lives on the gateway, not this disk); local mode keeps the file:// form.
export function mediaExternalUrl(path: string): string {
  if (/^https?:/i.test(path)) {
    return path
  }

  if (isRemoteGateway()) {
    const conn = $connection.get()

    if (conn?.baseUrl && conn.token) {
      const file = encodeURIComponent(filePathFromMediaPath(path))

      return `${conn.baseUrl}/api/files/download?path=${file}&token=${encodeURIComponent(conn.token)}`
    }
  }

  return toLocalFileUrl(path)
}

// Custom Electron scheme (registered in electron/main.cjs) that streams a local
// file with Range support. Used for audio/video so playback bypasses the data
// URL size cap and supports seeking. `path` may be a plain path or `file://…`.
export function mediaStreamUrl(path: string): string {
  return `hermes-media://stream/${encodeURIComponent(filePathFromMediaPath(path))}`
}

export function mediaPathFromMarkdownHref(href?: string): string | null {
  if (!href?.startsWith('#media:')) {
    return null
  }

  try {
    return decodeURIComponent(href.slice('#media:'.length))
  } catch {
    return null
  }
}

export function filePathFromMediaPath(path: string): string {
  if (!path.startsWith('file:')) {
    return path
  }

  try {
    return decodeURIComponent(new URL(path).pathname)
  } catch {
    return path.replace(/^file:\/\//, '')
  }
}

// True when this desktop shell is wired to a remote gateway. Local media paths
// then live on the gateway machine, not this disk, so we fetch them over the API.
export function isRemoteGateway(): boolean {
  return $connection.get()?.mode === 'remote'
}

// Fetch gateway-local media as a data URL via the authenticated desktop FS
// bridge. Remote Desktop artifacts can live anywhere the gateway can read
// (workspace, skills, ~/.hermes/cache, etc.); /api/media is intentionally
// narrower and rejects non-images plus images outside its media roots.
export async function gatewayMediaDataUrl(path: string): Promise<string> {
  return readDesktopFileDataUrl(filePathFromMediaPath(path))
}

// Remote-mode replacement for opening gateway-local file paths with file://.
// The file lives on the gateway, so fetch it over the authenticated fs bridge
// and hand the bytes to the local browser shell as a download.
export async function downloadGatewayMediaFile(path: string): Promise<void> {
  const dataUrl = await readDesktopFileDataUrl(filePathFromMediaPath(path))

  if (!dataUrl) {
    throw new Error('Gateway returned no file data')
  }

  const response = await fetch(dataUrl)
  const blobUrl = URL.createObjectURL(await response.blob())
  const anchor = document.createElement('a')
  anchor.href = blobUrl
  anchor.download = mediaName(path)
  anchor.rel = 'noopener noreferrer'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000)
}

export function mediaDisplayLabel(path: string): string {
  const escaped = mediaName(path).replace(/[[\]\\]/g, '\\$&')
  const kind = mediaKind(path)

  return `${kind[0].toUpperCase()}${kind.slice(1)}: ${escaped}`
}
