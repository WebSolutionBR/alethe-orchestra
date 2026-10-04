import { invoke } from '@tauri-apps/api/core'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'

export type DiskInfo = {
  name: string
  mount_point: string
  total_gb: number
  used_gb: number
  used_percent: number
}

export type GpuInfo = {
  name: string
  utilization_percent: number
  vram_used_mb: number
  vram_total_mb: number
  temperature_c: number
  power_watts: number
}

export type SystemMetrics = {
  cpu_percent: number
  ram_used_mb: number
  ram_total_mb: number
  disks: DiskInfo[]
  disk_read_mbps: number
  disk_write_mbps: number
  gpus: GpuInfo[]
}

/** CPU, RAM, disk (space + live throughput) and NVIDIA GPU. Polled by the monitor. */
export async function getSystemMetrics(): Promise<SystemMetrics> {
  return invoke<SystemMetrics>('get_system_metrics')
}

/**
 * Open the external monitor window. Created from the frontend so the child
 * window inherits this window's origin (the Vite dev server in dev, the bundled
 * assets in release) with the Tauri API injected — a Rust-side `WebviewUrl::App`
 * resolves to stale/absent assets during `tauri dev`, and `External` would load
 * a remote URL with no IPC. If one is already open, it is recreated so it always
 * loads fresh.
 */
export async function openDashboardWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel('dashboard')
  if (existing) {
    await existing.close()
  }
  const monitor = new WebviewWindow('dashboard', {
    url: 'index.html',
    title: 'Alethe — Monitor',
    width: 420,
    height: 640,
    minWidth: 320,
    minHeight: 420,
    decorations: false,
    resizable: true,
  })
  await new Promise<void>((resolve, reject) => {
    void monitor.once('tauri://created', () => resolve())
    void monitor.once('tauri://error', (event) => reject(new Error(String(event.payload))))
  })
}

/** Toggle always-on-top for the monitor window. */
export async function setDashboardAlwaysOnTop(enabled: boolean): Promise<void> {
  await invoke('set_dashboard_always_on_top', { enabled })
}
