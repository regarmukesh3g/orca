import { OrcaRuntimeWithAdmitWindowPublisher } from './session-window-publisher'
import {
  isTerminalLeafId,
  makePaneKey,
  parsePaneKey
} from '../../../shared/workspace-layout/stable-pane-id'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../terminal/records/runtime-terminal-state-records'

/** An Agent-slept pane keeps its handle while it has no process, so its resume answers to the same name. */
export abstract class OrcaRuntimeWithSleptLeafHandles extends OrcaRuntimeWithAdmitWindowPublisher {
  /** Handles of Agent-slept panes and the process each named, kept so the woken process takes the same name. */
  protected readonly sleptLeafHandles = new Map<string, string>()

  /** Main's hook row names the exact process Agent Sleep stopped in this pane. */
  protected isAgentSleepStop(paneKey: string, ptyId: string): boolean {
    return (this.getAgentStatusSnapshotForPaneFn?.(paneKey) ?? []).some(
      (row) => row.paneSleep?.ptyId === ptyId
    )
  }

  /** A pane's new process keeps the handle when it is the pane's first (mobile already subscribed
   *  to it), or when Agent Sleep stopped the previous one: the handle waits for, then names, the resume. */
  protected retainLeafHandle(
    leaf: Pick<RuntimeLeafRecord, 'tabId' | 'leafId'>,
    previousPtyId: string | null,
    ptyId: string | null,
    ptyGeneration: number
  ): boolean {
    const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
    if (previousPtyId === null) {
      return this.adoptFirstPtyForLeafHandle(leafKey, ptyId, ptyGeneration)
    }
    if (
      !isTerminalLeafId(leaf.leafId) ||
      !this.isAgentSleepStop(makePaneKey(leaf.tabId, leaf.leafId), previousPtyId)
    ) {
      return false
    }
    return ptyId === null
      ? this.parkSleptLeafHandle(leafKey, ptyGeneration)
      : this.rebindSleptLeafHandle(leafKey, ptyId, ptyGeneration)
  }

  /** Keep a slept pane's handle on its now terminal-less leaf instead of retiring it. */
  protected parkSleptLeafHandle(leafKey: string, ptyGeneration: number): boolean {
    const handle = this.handleByLeafKey.get(leafKey)
    const record = handle ? this.handles.get(handle) : null
    if (!handle || !record?.ptyId) {
      return false
    }
    const sleptPtyId = record.ptyId
    // The stopped process keeps no alias: the name now belongs to the pane's next process.
    if (this.handleByPtyId.get(sleptPtyId) === handle) {
      this.terminalIdentity.unbindPty(sleptPtyId)
    }
    if (this.handleByPtyIncarnation.get(sleptPtyId)?.handle === handle) {
      this.terminalIdentity.removeIncarnation(sleptPtyId)
    }
    this.terminalIdentity.setHandle(handle, { ...record, ptyId: null, ptyGeneration })
    this.sleptLeafHandles.set(handle, sleptPtyId)
    return true
  }

  /** A restart left the slept pane bound to its stopped process; its resume takes over the same handle. */
  protected rebindSleptLeafHandle(leafKey: string, ptyId: string, ptyGeneration: number): boolean {
    const handle = this.handleByLeafKey.get(leafKey)
    const record = handle ? this.handles.get(handle) : null
    if (!handle || !record?.ptyId || this.ptysById.get(record.ptyId)?.connected === true) {
      return false
    }
    this.parkSleptLeafHandle(leafKey, ptyGeneration)
    return this.adoptFirstPtyForLeafHandle(leafKey, ptyId, ptyGeneration)
  }

  /** The handle a slept pane answers to: parked with no terminal, or, after a restart, still bound
   *  to the exact process Agent Sleep stopped. Null when the pane runs a process or never slept. */
  protected sleptLeafHandle(
    leaf: Pick<RuntimeLeafRecord, 'tabId' | 'leafId' | 'ptyId'>
  ): string | null {
    const handle = this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId))
    if (!handle || this.handles.get(handle)?.ptyId !== leaf.ptyId) {
      return null
    }
    if (leaf.ptyId === null) {
      return this.sleptLeafHandles.has(handle) ? handle : null
    }
    return isTerminalLeafId(leaf.leafId) &&
      this.ptysById.get(leaf.ptyId)?.connected !== true &&
      this.isAgentSleepStop(makePaneKey(leaf.tabId, leaf.leafId), leaf.ptyId)
      ? handle
      : null
  }

  protected isSleptAgentLeaf(leaf: Pick<RuntimeLeafRecord, 'tabId' | 'leafId' | 'ptyId'>): boolean {
    return this.sleptLeafHandle(leaf) !== null
  }

  /** The handle a spawn into this slept pane takes, so its process exports the pane's old name. */
  sleptPaneHandleForSpawn(paneKey: string | null | undefined): string | null {
    const pane = paneKey ? parsePaneKey(paneKey) : null
    const leaf = pane ? this.leaves.get(this.getLeafKey(pane.tabId, pane.leafId)) : undefined
    return leaf ? this.sleptLeafHandle(leaf) : null
  }

  /** A slept agent's handle and its stopped process, whose kept output stands for the idle agent. */
  protected sleptAgentHandle(handle: string): { pty: RuntimePtyWorktreeRecord | null } | null {
    const record = this.handles.get(handle)
    const leaf = record ? this.leaves.get(this.getLeafKey(record.tabId, record.leafId)) : undefined
    if (!record || !leaf || this.sleptLeafHandle(leaf) !== handle) {
      return null
    }
    const ptyId = record.ptyId ?? this.sleptLeafHandles.get(handle)
    return { pty: (ptyId && this.ptysById.get(ptyId)) || null }
  }
}
