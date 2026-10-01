/**
 * Hot-reload wrapper for opencode-plugin-ntfy-sh.
 *
 * opencode registers a plugin's hooks once per project instance and never
 * reloads plugin code while the server runs. This wrapper hands opencode
 * stable hook functions that delegate to whichever copy of ./core.ts is
 * currently loaded.
 *
 * Send SIGUSR1 to the opencode server process to:
 *   1. stop the current tunnel(s),
 *   2. import a fresh copy of ./core.ts (picks up code edits),
 *   3. re-initialise every plugin instance (re-reads remote-notify.json,
 *      starts a new tunnel, sends a new "server online" notification).
 *
 *   kill -USR1 $(pgrep -f "opencode serve")
 *
 * Only hooks listed in DELEGATED are forwarded. If core.ts starts using
 * another hook, add it here; changes to this file itself still need a restart.
 */
import { tool, type Hooks, type Plugin, type PluginInput, type PluginOptions } from "@opencode-ai/plugin"

type Core = {
  default: Plugin
  shutdown?: () => void | Promise<void>
  restartTunnels?: (reason?: string) => number
  log?: (level: "debug" | "info" | "warn" | "error", ...parts: unknown[]) => void
}
type Instance = { input: PluginInput; options?: PluginOptions; hooks: Hooks }

const DELEGATED = ["event"] as const

// Kept on globalThis so a second import of this file can't install a second
// signal handler or split the instance list.
const state = ((globalThis as any).__ntfyShReload ??= {
  version: 0,
  core: undefined as Promise<Core> | undefined,
  instances: new Set<Instance>(),
  queue: Promise.resolve() as Promise<unknown>,
  signalInstalled: false,
}) as {
  version: number
  core: Promise<Core> | undefined
  instances: Set<Instance>
  queue: Promise<unknown>
  signalInstalled: boolean
}

function importCore(): Promise<Core> {
  // A unique query string makes Bun evaluate a fresh copy of the module.
  const spec = new URL(`./core.ts?v=${++state.version}`, import.meta.url).href
  return import(spec) as Promise<Core>
}

async function init(core: Core, inst: Instance) {
  try {
    inst.hooks = (await core.default(inst.input, inst.options)) ?? {}
  } catch (e) {
    console.error("[ntfy-sh] plugin init failed:", e)
    inst.hooks = {}
  }
}

function reload() {
  // Serialise reloads so rapid signals can't interleave.
  state.queue = state.queue.then(async () => {
    const old = await state.core?.catch(() => undefined)
    await old?.shutdown?.()
    let core: Core
    try {
      core = await importCore()
    } catch (e) {
      // Keep running without a tunnel rather than crashing the server; fix
      // the error and send SIGUSR1 again.
      console.error("[ntfy-sh] reload failed, core.ts did not load:", e)
      old?.log?.("error", "reload failed:", e)
      return
    }
    state.core = Promise.resolve(core)
    for (const inst of state.instances) await init(core, inst)
    core.log?.("info", `reloaded (v${state.version}, ${state.instances.size} instance(s))`)
  })
  return state.queue
}

const NtfySh: Plugin = async (input, options) => {
  if (!state.signalInstalled) {
    state.signalInstalled = true
    process.on("SIGUSR1", () => void reload())
  }
  state.core ??= importCore()
  const inst: Instance = { input, options, hooks: {} }
  await init(await state.core, inst)
  state.instances.add(inst)

  const hooks: Hooks = {}
  for (const name of DELEGATED) {
    ;(hooks as any)[name] = (...args: unknown[]) => (inst.hooks as any)[name]?.(...args)
  }
  // Defined here (not in core.ts) so the tool survives hot reloads.
  hooks.tool = {
    tunnel_restart: tool({
      description:
        "Restart the opencode-plugin-ntfy-sh Cloudflare tunnel (e.g. after a network change). Quick-tunnel URLs change on restart; a notification with the new URL is sent.",
      args: {},
      async execute() {
        const core = await state.core
        const n = core?.restartTunnels?.("requested via tunnel_restart tool") ?? 0
        return n ? `Restarting ${n} tunnel(s); a notification with the URL will follow.` : "No tunnel is running."
      },
    }),
  }
  return hooks
}

export default NtfySh
