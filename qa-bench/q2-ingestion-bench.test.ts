// QA-only matched benchmark for the #41366 replacement. Not shipped. Base and head sources load in one process, interleaved.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { it, vi } from 'vitest'

const ROOTS: Record<string, string> = { base: process.env.Q2_BASE_ROOT!, head: process.env.Q2_HEAD_ROOT! }
const OUT = process.env.Q2_BENCH_OUT!
const COLS = 120
const ROWS = 40
const CHUNK = 4096
const KIB = 1024
const REPS = 7

function fill(unit: (i: number) => string, bytes: number): string {
  let s = ''
  for (let i = 0; s.length < bytes; i++) s += unit(i)
  return s.slice(0, bytes)
}
const plainLine = (i: number) => `line ${String(i).padStart(6, '0')} ${'abcdefghij'.repeat(10)}\r\n`
const wideLine = (i: number) => `w${i % 10} ${'界é'.repeat(30)} 漢字テスト\r\n`
const frame = (() => {
  let f = '\x1b[H'
  for (let r = 1; r <= ROWS; r++) f += `\x1b[${r};1H` + `row ${String(r).padStart(2, '0')} ${'ready > '.repeat(13)}`.slice(0, COLS)
  return f
})()
const editUnit = (i: number) =>
  `\x1b[${(i % 38) + 2};1Hcell${i % 97} \x1b[${(i % 30) + 1}G\x1b[2@ab\x1b[3P\x1b[1K\x1b[${(i % 20) + 5};${(i % 40) + 1}H\x1b[1L\x1b[1M\x1b[4X` +
  (i % 9 === 0 ? '\x1b[2K' : '') + (i % 13 === 0 ? `\x1b[3;30r\x1b[30;1H\r\n\x1b[r` : '')
const PAYLOADS: Record<string, string> = {
  'plain-64KiB': fill(plainLine, 64 * KIB),
  'plain-640KiB': fill(plainLine, 640 * KIB),
  'wide-combining-64KiB': fill(wideLine, 64 * KIB),
  'identical-repaint-64KiB': fill(() => frame, 64 * KIB),
  'structural-edits-64KiB': fill(editUnit, 64 * KIB)
}
const chunks = (s: string) => { const o: string[] = []; for (let i = 0; i < s.length; i += CHUNK) o.push(s.slice(i, i + CHUNK)); return o }
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16)
const cpuMs = (c: NodeJS.CpuUsage) => (c.user + c.system) / 1000

type Mods = { HeadlessEmulator: any; createTranscriptPane: any; PTY: string }
async function load(root: string): Promise<Mods> {
  const emu = await import(`${root}/src/main/daemon/emulation/headless-emulator`)
  const h = await import(`${root}/src/main/runtime/terminal/wait/agent-transcript-pane-test-harness`)
  return { HeadlessEmulator: emu.HeadlessEmulator, createTranscriptPane: h.createTranscriptPane, PTY: h.TRANSCRIPT_PANE_PTY_ID }
}

async function emulatorRun(m: Mods, name: string) {
  const parts = chunks(PAYLOADS[name])
  const emu = new m.HeadlessEmulator({ cols: COLS, rows: ROWS })
  const c0 = process.cpuUsage(); const t0 = performance.now()
  for (const p of parts) await emu.write(p)
  const writeMs = performance.now() - t0; const writeCpuMs = cpuMs(process.cpuUsage(c0))
  const r0 = performance.now(); const lines = emu.getVisibleLines(); const coldReadMs = performance.now() - r0
  emu.dispose()
  return { writeMs, writeCpuMs, coldReadMs, digest: sha(lines) }
}

async function runtimeRun(m: Mods, name: string, mode: string) {
  const claude = mode === 'claude-title-boundary'
  const { runtime, handle } = await m.createTranscriptPane({ paneTitle: claude ? 'claude' : 'Terminal', foregroundProcess: claude ? 'claude' : 'bash', data: '', size: { cols: COLS, rows: ROWS } })
  let parts = chunks(PAYLOADS[name])
  if (mode !== 'no-boundary') {
    const half = parts.length >> 1
    const start = claude ? '\x1b]133;A\x07$ claude\r\n\x1b]133;C\x07\x1b]0;claude\x07' : '\x1b]133;A\x07$ agent\r\n\x1b]133;C\x07'
    parts = [start, ...parts.slice(0, half), '\x1b]133;D;0\x07' + start, ...parts.slice(half)]
  }
  const c0 = process.cpuUsage(); const t0 = performance.now()
  for (const p of parts) runtime.onPtyData(m.PTY, p, Date.now())
  const ingestMs = performance.now() - t0; const ingestCpuMs = cpuMs(process.cpuUsage(c0))
  const r0 = performance.now(); const read = await runtime.readTerminal(handle); const firstReadMs = performance.now() - r0
  const w0 = performance.now()
  const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1 }).catch(() => null)
  await wait
  const tuiIdleEvalMs = performance.now() - w0
  return { ingestMs, ingestCpuMs, firstReadMs, tuiIdleEvalMs, digest: sha((read as any).tail ?? read) }
}

const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }

it('q2 matched ingestion benchmark', async () => {
  vi.useRealTimers()
  const mods: Record<string, Mods> = { base: await load(ROOTS.base), head: await load(ROOTS.head) }
  const rows: any[] = []
  const cells: [string, string, string][] = []
  for (const name of Object.keys(PAYLOADS)) {
    cells.push(['headless-emulator', name, 'default'])
    for (const mode of ['no-boundary', 'C-boundary-mid', 'claude-title-boundary']) cells.push(['runtime-onPtyData', name, mode])
  }
  for (const [layer, name, mode] of cells) {
    const run = (rev: string) => layer === 'headless-emulator' ? emulatorRun(mods[rev], name) : runtimeRun(mods[rev], name, mode)
    await run('base'); await run('head')
    for (let rep = 0; rep < REPS; rep++) {
      for (const rev of rep % 2 ? ['head', 'base'] : ['base', 'head']) rows.push({ layer, name, mode, rev, rep, ...(await run(rev)) })
    }
  }
  const summary: any[] = []
  for (const [layer, name, mode] of cells) {
    const pick = (rev: string) => rows.filter((r) => r.layer === layer && r.name === name && r.mode === mode && r.rev === rev)
    const b = pick('base'); const h = pick('head')
    for (const metric of Object.keys(b[0]).filter((k) => k.endsWith('Ms'))) {
      const bv = b.map((r) => r[metric]); const hv = h.map((r) => r[metric])
      const bm = med(bv); const hm = med(hv)
      const spread = (Math.max(...bv) - Math.min(...bv)) / bm
      summary.push({ layer, name, mode, metric, base: +bm.toFixed(3), head: +hm.toFixed(3), deltaPct: +(((hm - bm) / bm) * 100).toFixed(1), baseSpreadPct: +(spread * 100).toFixed(1), sameOutput: b[0].digest === h[0].digest })
    }
  }
  console.log("Q2SUMMARY " + JSON.stringify(summary))
  writeFileSync(OUT, JSON.stringify({ node: process.version, reps: `1 warmup + ${REPS} interleaved`, summary, rows }, null, 1))
}, 1_800_000)
