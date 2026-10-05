/**
 * Orchestrations the app was closed on: their manifests are found once per run, offered in the
 * "interrupted" strip (read, resume, discard) and leave the list when resumed or discarded.
 */
import { isTauri } from '@tauri-apps/api/core'
import { create } from 'zustand'

import {
  orchestraEnd,
  orchestraFolderExists,
  orchestraManifestList,
  orchestraManifestRemove,
} from '../../../lib/tauri/orchestra'
import { type OrchestraManifest, parseManifest } from './manifest'

const ID = /^[a-z0-9-]{1,32}$/

type InterruptedState = {
  /** Most recently saved first. */
  manifests: OrchestraManifest[]
  /** Ids of records that cannot be read (damaged, or from a newer build): only discardable. */
  damaged: string[]
  /** Whether each manifest's folder still exists; missing until checked. */
  folders: Record<string, boolean>
  loaded: boolean
  /** Reads the manifests on disk once per run, leaving out the sessions running now. */
  load: (running: string[]) => Promise<void>
  /** Checks again whether a manifest's folder exists; resolves to the answer. */
  checkFolder: (id: string) => Promise<boolean>
  /** Takes one off the list because it is being resumed; resolves to it, if it was there. */
  take: (id: string) => OrchestraManifest | null
  /** Puts back one whose resume failed. */
  putBack: (manifest: OrchestraManifest) => void
  /** Deletes its manifest and kept transcripts: it can no longer be read or resumed. */
  discard: (id: string) => Promise<void>
}

const byRecency = (a: OrchestraManifest, b: OrchestraManifest) => b.savedAt - a.savedAt

/** Whether `path` is an existing folder; an error counts as no, so nothing runs elsewhere. */
const folderExists = (path: string | null) =>
  path
    ? Promise.resolve()
        .then(() => orchestraFolderExists(path))
        .catch(() => false)
    : Promise.resolve(false)

/** A record the backend could not read: `{ id, damaged: true }`. */
function damagedId(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { id, damaged } = raw as { id?: unknown; damaged?: unknown }
  return damaged === true && typeof id === 'string' && ID.test(id) ? id : null
}

let loading: Promise<void> | null = null

export const useInterrupted = create<InterruptedState>((set, get) => ({
  manifests: [],
  damaged: [],
  folders: {},
  loaded: false,

  load: (running) => {
    if (get().loaded) return Promise.resolve()
    // Outside the app (a browser preview, tests) there is no app data to read.
    if (!isTauri()) {
      set({ loaded: true })
      return Promise.resolve()
    }
    loading ??= Promise.resolve()
      .then(() => orchestraManifestList())
      .then(async (raw) => {
        const live = new Set(running)
        const manifests = raw
          .map(parseManifest)
          .filter((m): m is OrchestraManifest => m !== null && !live.has(m.id))
          .sort(byRecency)
        const damaged = raw
          .map(damagedId)
          .filter((id): id is string => id !== null && !live.has(id))
        const answers = await Promise.all(manifests.map((m) => folderExists(m.cwd)))
        const folders = Object.fromEntries(manifests.map((m, i) => [m.id, answers[i]]))
        set({ manifests, damaged, folders, loaded: true })
      })
      .catch((error: unknown) => {
        console.warn('[orchestra] could not read the interrupted orchestrations', error)
        set({ loaded: true })
      })
      .finally(() => {
        loading = null
      })
    return loading
  },

  checkFolder: async (id) => {
    const manifest = get().manifests.find((m) => m.id === id)
    const exists = await folderExists(manifest?.cwd ?? null)
    set((s) => ({ folders: { ...s.folders, [id]: exists } }))
    return exists
  },

  take: (id) => {
    const manifest = get().manifests.find((m) => m.id === id) ?? null
    if (manifest) set((s) => ({ manifests: s.manifests.filter((m) => m.id !== id) }))
    return manifest
  },

  putBack: (manifest) =>
    set((s) =>
      s.manifests.some((m) => m.id === manifest.id)
        ? s
        : { manifests: [...s.manifests, manifest].sort(byRecency) },
    ),

  discard: async (id) => {
    set((s) => ({
      manifests: s.manifests.filter((m) => m.id !== id),
      damaged: s.damaged.filter((d) => d !== id),
    }))
    await Promise.resolve()
      .then(() => orchestraManifestRemove(id))
      .catch((error: unknown) => {
        console.warn('[orchestra] could not discard the interrupted orchestration', error)
      })
    // Its hooks settings and task files in the temp dir go too.
    await Promise.resolve()
      .then(() => orchestraEnd(id))
      .catch(() => {})
  },
}))
