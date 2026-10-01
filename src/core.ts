/**
 * Plugin implementation. Loaded (and hot-reloaded on SIGUSR1) by src/index.ts.
 *
 * opencode-plugin-ntfy-sh: expose the opencode server through a Cloudflare tunnel and
 * push ntfy notifications (with a deep link back into the session) whenever a
 * session needs input or finishes its task.
 *
 * Configuration (first match wins per field):
 *   1. plugin options:  "plugin": [["opencode-plugin-ntfy-sh", { ... }]]
 *   2. JSON file:       ~/.config/opencode/remote-notify.json
 *   3. env vars:        see ENV mapping below
 *
 * {
 *   "ntfyUrl":   "https://ntfy.sh/my-secret-topic",   // REQUIRED  (OPENCODE_NTFY_URL)
 *   "ntfyToken": "tk_...",                             // optional  (OPENCODE_NTFY_TOKEN)
 *   "tunnel": {
 *     "enabled":  true,                                // (OPENCODE_TUNNEL=0 disables)
 *     "binary":   "/usr/bin/cloudflared",              // optional override; default: bundled via npm `cloudflared` (OPENCODE_CLOUDFLARED_BIN)
 *     "token":    "eyJ...",                            // named tunnel token (OPENCODE_TUNNEL_TOKEN)
 *     "hostname": "opencode.example.com",              // public hostname of named tunnel (OPENCODE_TUNNEL_HOSTNAME)
 *     "publicUrl": "https://..."                       // skip cloudflared entirely, just use this URL
 *   },
 *   "notifyOn": ["idle", "question", "permission", "error"],
 *   "includeSubagents": false
 * }
 *
 * Without token/hostname a quick tunnel (*.trycloudflare.com) is created.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { Tunnel, bin, install, use } from "cloudflared"
import { readFileSync, existsSync } from "node:fs"
import { homedir, networkInterfaces } from "node:os"
import { join } from "node:path"

type Kind = "idle" | "question" | "permission" | "error"

type Options = {
  ntfyUrl?: string
  ntfyToken?: string
  tunnel?: {
    enabled?: boolean
    binary?: string
    token?: string
    hostname?: string
    publicUrl?: string
  }
  notifyOn?: Kind[]
  includeSubagents?: boolean
}

const LOG = "[ntfy-sh]"

type Level = "debug" | "info" | "warn" | "error"
let sink: ((level: Level, message: string) => void) | undefined
/**
 * `opencode serve` does not surface plugin stdout/stderr, so write to
 * opencode's own log (~/.local/share/opencode/log, service=ntfy-sh) and
 * stderr (visible when running with --print-logs).
 */
export function log(level: Level, ...parts: unknown[]) {
  const message = parts.map((p) => (p instanceof Error ? p.message : typeof p === "string" ? p : JSON.stringify(p))).join(" ")
  console.error(LOG, message)
  sink?.(level, message)
}

function loadOptions(passed?: Record<string, unknown>): Options {
  const file = join(homedir(), ".config", "opencode", "remote-notify.json")
  let fromFile: Options = {}
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, "utf8"))
    } catch (e) {
      log("error", "failed to parse", file, e)
    }
  }
  const o = (passed ?? {}) as Options
  const env = process.env
  return {
    ntfyUrl: o.ntfyUrl ?? fromFile.ntfyUrl ?? env.OPENCODE_NTFY_URL,
    ntfyToken: o.ntfyToken ?? fromFile.ntfyToken ?? env.OPENCODE_NTFY_TOKEN,
    tunnel: {
      enabled: o.tunnel?.enabled ?? fromFile.tunnel?.enabled ?? env.OPENCODE_TUNNEL !== "0",
      binary: o.tunnel?.binary ?? fromFile.tunnel?.binary ?? env.OPENCODE_CLOUDFLARED_BIN,
      token: o.tunnel?.token ?? fromFile.tunnel?.token ?? env.OPENCODE_TUNNEL_TOKEN,
      hostname: o.tunnel?.hostname ?? fromFile.tunnel?.hostname ?? env.OPENCODE_TUNNEL_HOSTNAME,
      publicUrl: o.tunnel?.publicUrl ?? fromFile.tunnel?.publicUrl ?? env.OPENCODE_PUBLIC_URL,
    },
    notifyOn: o.notifyOn ?? fromFile.notifyOn ?? ["idle", "question", "permission", "error"],
    includeSubagents: o.includeSubagents ?? fromFile.includeSubagents ?? false,
  }
}

/** Same encoding the opencode web app uses for the `/:dir` route segment. */
function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function ensureBinary(override?: string): Promise<string> {
  if (override) {
    use(override)
    return override
  }
  if (!existsSync(bin)) {
    // postinstall may have been skipped (e.g. bun doesn't run untrusted lifecycle scripts)
    log("info", "downloading cloudflared to", bin)
    await install(bin)
  }
  return bin
}

type Notify = (title: string, url: string) => Promise<void>

/**
 * Keeps one cloudflared running for a local target and restarts it when:
 *  - cloudflared exits or fails to come up (exponential backoff, 2s..60s);
 *  - the machine's network interfaces/addresses change (e.g. new Wi-Fi);
 *  - the process was suspended (laptop sleep: timer gap far over interval);
 *  - the public URL fails a health check 3 times in a row.
 * Quick-tunnel URLs change on every restart, so links always read `url()`.
 */
class TunnelManager {
  private tunnel?: Tunnel
  private current?: string
  private waiters: Array<(u: string | undefined) => void> = []
  private starting = false
  private stopped = false
  private backoff = 2_000
  private retryTimer?: ReturnType<typeof setTimeout>
  private watchTimer?: ReturnType<typeof setInterval>
  private failures = 0
  private lastTick = Date.now()
  private netSig = networkSignature()
  private generation = 0

  constructor(
    private t: NonNullable<Options["tunnel"]>,
    private localUrl: string,
    private notify: Notify,
  ) {}

  /** Current public URL; waits (up to 20s) while a (re)start is in flight. */
  url(): Promise<string | undefined> {
    if (this.current || this.stopped) return Promise.resolve(this.current)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.current), 20_000)
      this.waiters.push((u) => {
        clearTimeout(timer)
        resolve(u)
      })
    })
  }

  start() {
    this.spawn()
    this.watchTimer = setInterval(() => void this.watch(), WATCH_INTERVAL)
    // Don't keep the process alive just for the watchdog.
    ;(this.watchTimer as any).unref?.()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.retryTimer)
    clearInterval(this.watchTimer)
    this.kill()
    for (const w of this.waiters.splice(0)) w(undefined)
  }

  restart(reason: string) {
    if (this.stopped) return
    log("warn", `restarting tunnel: ${reason}`)
    clearTimeout(this.retryTimer)
    this.kill()
    this.spawn()
  }

  private kill() {
    this.generation++ // ignore events from the old process
    this.current = undefined
    this.starting = false
    try {
      this.tunnel?.stop()
    } catch {}
    this.tunnel = undefined
  }

  private scheduleRetry(reason: string) {
    if (this.stopped || this.retryTimer) return
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, 60_000)
    log("warn", `${reason}; retrying tunnel in ${delay / 1000}s`)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.kill()
      this.spawn()
    }, delay)
  }

  private async spawn() {
    if (this.stopped || this.starting) return
    this.starting = true
    const gen = ++this.generation
    const named = !!this.t.token
    const namedUrl = this.t.hostname ? `https://${this.t.hostname.replace(/^https?:\/\//, "")}` : undefined

    let tunnel: Tunnel
    try {
      await ensureBinary(this.t.binary)
      if (gen !== this.generation) return
      tunnel = named
        ? Tunnel.withToken(this.t.token!, { "--no-autoupdate": true })
        : Tunnel.quick(this.localUrl, { "--no-autoupdate": true })
    } catch (e) {
      this.starting = false
      return this.scheduleRetry(`failed to start cloudflared: ${(e as Error).message}`)
    }
    this.tunnel = tunnel

    const up = (u: string | undefined) => {
      if (gen !== this.generation) return
      clearTimeout(upTimer)
      this.starting = false
      if (!u) return this.scheduleRetry("tunnel came up without a public URL")
      const changed = u !== this.current
      this.current = u
      this.backoff = 2_000
      this.failures = 0
      for (const w of this.waiters.splice(0)) w(u)
      if (changed) {
        log("info", "public URL:", u)
        void this.notify(this.everUp ? "opencode tunnel reconnected" : "opencode server online", u)
      }
      this.everUp = true
    }
    const upTimer = setTimeout(() => {
      if (gen === this.generation && this.starting) this.restart("tunnel did not come up within 60s")
    }, 60_000)

    // Quick tunnel: library parses the trycloudflare URL for us.
    tunnel.once("url", (u) => {
      if (!named) up(u)
    })
    // Named tunnel: routing lives in the Cloudflare dashboard; only the
    // hostname is needed.
    tunnel.once("connected", () => {
      if (named) up(namedUrl)
    })
    tunnel.on("error", (e) => {
      if (gen !== this.generation) return
      log("error", "cloudflared error:", e.message)
    })
    tunnel.on("exit", (code) => {
      if (gen !== this.generation) return
      clearTimeout(upTimer)
      this.current = undefined
      this.starting = false
      this.tunnel = undefined
      this.scheduleRetry(`cloudflared exited (${code})`)
    })
  }
  private everUp = false

  private async watch() {
    if (this.stopped) return
    const now = Date.now()
    const gap = now - this.lastTick
    this.lastTick = now
    if (gap > WATCH_INTERVAL * 3) return this.restart(`process was suspended for ${Math.round(gap / 1000)}s (sleep?)`)

    const sig = networkSignature()
    if (sig !== this.netSig) {
      this.netSig = sig
      // Give DHCP/DNS a moment to settle on the new network.
      clearTimeout(this.retryTimer)
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined
        this.backoff = 2_000
        this.restart("network changed")
      }, 3_000)
      return
    }

    if (!this.current || this.starting || this.t.publicUrl) return
    if (await healthy(this.current)) {
      this.failures = 0
    } else if (++this.failures >= 3) {
      this.restart(`public URL failed ${this.failures} health checks`)
    }
  }
}

const WATCH_INTERVAL = 20_000

/** Non-internal interface addresses; changes when switching networks. */
function networkSignature() {
  return Object.entries(networkInterfaces())
    .flatMap(([name, addrs]) => (addrs ?? []).filter((a) => !a.internal).map((a) => `${name}=${a.address}`))
    .sort()
    .join(",")
}

/**
 * Any response from our origin counts (401 from OPENCODE_SERVER_PASSWORD
 * included). Cloudflare answers 530 (error 1033) when the tunnel is gone;
 * network errors/timeouts also count as unhealthy.
 */
async function healthy(url: string) {
  try {
    const res = await fetch(`${url}/global/health`, { signal: AbortSignal.timeout(10_000), redirect: "manual" })
    return res.status !== 530
  } catch {
    return false
  }
}

/** Tunnel managers started by this copy of the module, keyed by local target. */
const managers = new Map<string, TunnelManager>()
let exitHooked = false

/**
 * Stop every tunnel this module started. Called by the wrapper (src/index.ts)
 * before it loads a fresh copy of this module on SIGUSR1.
 */
export function shutdown() {
  for (const m of managers.values()) m.stop()
  managers.clear()
}

/** Force-restart all tunnels (used by the `tunnel_restart` tool). */
export function restartTunnels(reason = "manual restart") {
  for (const m of managers.values()) m.restart(reason)
  return managers.size
}

const RemoteNotify: Plugin = async ({ client, serverUrl, directory }, passed) => {
  sink = (level, message) => {
    client.app.log({ body: { service: "ntfy-sh", level, message } }).catch(() => {})
  }
  const opts = loadOptions(passed)
  if (!opts.ntfyUrl) {
    log("warn", "no ntfyUrl configured; plugin disabled")
    return {}
  }

  const local = new URL(serverUrl.toString())
  const hasRealPort = /^https?:$/.test(local.protocol) && local.port !== "" && local.port !== "0"
  const ntfy = new URL(opts.ntfyUrl)
  const topic = ntfy.pathname.replace(/^\//, "")
  const ntfyBase = ntfy.origin

  const notifyOnline: Notify = async (title, u) => {
    try {
      await fetch(ntfyBase, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(opts.ntfyToken ? { Authorization: `Bearer ${opts.ntfyToken}` } : {}),
        },
        body: JSON.stringify({
          topic,
          title,
          message: u,
          tags: ["rocket"],
          priority: 2,
          click: u,
          actions: [{ action: "view", label: "Open", url: u }],
        }),
      })
    } catch (e) {
      log("error", "ntfy online notification failed:", e)
    }
  }

  let tunnelUrl: () => Promise<string | undefined>
  const t = opts.tunnel!
  if (t.publicUrl) {
    const fixed = t.publicUrl.replace(/\/$/, "")
    tunnelUrl = async () => fixed
  } else if (!t.enabled) {
    tunnelUrl = async () => undefined
  } else if (!hasRealPort) {
    log("warn", `server is not listening on a real port (${local}). Start opencode with --port <n> (or use \`opencode serve\`/\`opencode web\`) for tunneling.`)
    tunnelUrl = async () => undefined
  } else {
    // Connect via loopback even if the server binds 0.0.0.0
    const target = `${local.protocol}//127.0.0.1:${local.port}`
    // opencode creates one plugin instance per project directory, all in the
    // same process. Share one tunnel per server.
    let m = managers.get(target)
    if (!m) {
      m = new TunnelManager(t, target, notifyOnline)
      managers.set(target, m)
      m.start()
      if (!exitHooked) {
        exitHooked = true
        process.once("exit", shutdown)
        process.once("SIGINT", shutdown)
        process.once("SIGTERM", shutdown)
      }
    }
    const mgr = m
    tunnelUrl = () => mgr.url()
  }

  const sessionCache = new Map<string, { title: string; directory: string; parentID?: string }>()
  const lastSent = new Map<string, number>()

  async function sessionInfo(id: string) {
    if (sessionCache.has(id)) return sessionCache.get(id)!
    try {
      const res = await client.session.get({ path: { id } })
      const s = res.data as any
      const info = { title: s?.title ?? id, directory: s?.directory ?? directory, parentID: s?.parentID }
      sessionCache.set(id, info)
      return info
    } catch {
      return { title: id, directory, parentID: undefined }
    }
  }

  async function lastAssistantText(id: string): Promise<string | undefined> {
    try {
      const res = await client.session.messages({ path: { id } })
      const msgs = (res.data ?? []) as any[]
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].info?.role !== "assistant") continue
        const text = (msgs[i].parts ?? [])
          .filter((p: any) => p.type === "text" && p.text)
          .map((p: any) => p.text)
          .join("\n")
          .trim()
        if (text) return text
      }
    } catch {}
    return undefined
  }

  async function send(kind: Kind, sessionID: string, title: string, message: string, priority = 3) {
    if (!opts.notifyOn!.includes(kind)) return
    const info = await sessionInfo(sessionID)
    if (info.parentID && !opts.includeSubagents) return

    // de-dupe bursts (e.g. idle firing right after a question)
    const key = `${kind}:${sessionID}`
    const now = Date.now()
    if (now - (lastSent.get(key) ?? 0) < 5_000) return
    lastSent.set(key, now)

    const base = await tunnelUrl()
    const link = base ? `${base}/${base64UrlEncode(info.directory)}/session/${sessionID}` : undefined

    const body: Record<string, unknown> = {
      topic,
      title: `${title} — ${info.title}`.slice(0, 250),
      message: [
        message.slice(0, 3500),
        "",
        `Project: ${info.directory}`,
        `Session: ${sessionID}`,
        link ? `Open: ${link}` : "(no public tunnel URL available)",
      ].join("\n"),
      priority,
      tags: [kind === "idle" ? "white_check_mark" : kind === "error" ? "x" : "raising_hand"],
    }
    if (link) {
      body.click = link
      body.actions = [{ action: "view", label: kind === "idle" ? "Continue" : "Respond", url: link, clear: true }]
    }

    try {
      const res = await fetch(ntfyBase, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(opts.ntfyToken ? { Authorization: `Bearer ${opts.ntfyToken}` } : {}),
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) log("error", "ntfy responded", res.status, await res.text())
    } catch (e) {
      log("error", "ntfy send failed:", e)
    }
  }

  return {
    event: async ({ event }) => {
      const e = event as any
      switch (e.type) {
        case "session.idle": {
          const id = e.properties.sessionID
          const text = (await lastAssistantText(id)) ?? "Task finished."
          await send("idle", id, "Done", text, 3)
          break
        }
        case "question.asked": {
          const q = e.properties
          const lines = (q.questions ?? []).map((qq: any) => {
            const opts = (qq.options ?? []).map((o: any) => `  • ${o.label}`).join("\n")
            return `${qq.question}${opts ? "\n" + opts : ""}`
          })
          await send("question", q.sessionID, "Question", lines.join("\n\n") || "Input requested.", 4)
          break
        }
        case "permission.asked":
        case "permission.updated": {
          const p = e.properties
          const what = p.permission ?? p.type ?? "permission"
          const patterns = (p.patterns ?? (p.pattern ? [].concat(p.pattern) : [])).join(", ")
          await send("permission", p.sessionID, "Permission needed", `${what}${patterns ? `: ${patterns}` : ""}`, 4)
          break
        }
        case "session.error": {
          const id = e.properties.sessionID
          if (!id) break
          const err = e.properties.error
          await send("error", id, "Error", err?.data?.message ?? err?.name ?? "Session error", 4)
          break
        }
      }
    },
  }
}

export default RemoteNotify
