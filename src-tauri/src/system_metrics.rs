//! System resource metrics for the external monitor window: CPU, RAM, disk
//! (space + live read/write throughput) and NVIDIA GPU. Polled on demand by the
//! monitor HUD; it keeps a shared `System` so CPU usage and disk throughput are
//! measured as deltas between successive calls.

use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use sysinfo::{Disks, ProcessesToUpdate, System};

const BYTES_PER_MB: f64 = 1024.0 * 1024.0;
const BYTES_PER_GB: f64 = 1024.0 * 1024.0 * 1024.0;

#[derive(Serialize, Clone, Debug)]
pub struct DiskInfo {
    pub name: String,
    pub mount_point: String,
    pub total_gb: f64,
    pub used_gb: f64,
    pub used_percent: f64,
}

#[derive(Serialize, Clone, Debug)]
pub struct GpuInfo {
    pub name: String,
    pub utilization_percent: f64,
    pub vram_used_mb: f64,
    pub vram_total_mb: f64,
    pub temperature_c: f64,
    pub power_watts: f64,
}

#[derive(Serialize, Clone, Debug)]
pub struct SystemMetrics {
    pub cpu_percent: f64,
    pub ram_used_mb: f64,
    pub ram_total_mb: f64,
    pub disks: Vec<DiskInfo>,
    /// System-wide disk throughput since the previous sample, in MB/s.
    pub disk_read_mbps: f64,
    pub disk_write_mbps: f64,
    /// NVIDIA GPUs. Empty when no NVIDIA driver/NVML is present.
    pub gpus: Vec<GpuInfo>,
}

struct MetricsState {
    sys: System,
    last_sample: Instant,
}

fn metrics_state() -> &'static Mutex<MetricsState> {
    static STATE: OnceLock<Mutex<MetricsState>> = OnceLock::new();
    STATE.get_or_init(|| {
        let mut sys = System::new();
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        sys.refresh_processes(ProcessesToUpdate::All);
        Mutex::new(MetricsState {
            sys,
            last_sample: Instant::now(),
        })
    })
}

fn collect_disks() -> Vec<DiskInfo> {
    let disks = Disks::new_with_refreshed_list();
    let mut seen = std::collections::HashSet::<String>::new();
    let mut out = Vec::new();
    for disk in &disks {
        let mount = disk.mount_point().to_string_lossy().to_string();
        // On Windows each drive letter is one entry; skip duplicates just in case.
        if !seen.insert(mount.clone()) {
            continue;
        }
        let total = disk.total_space() as f64;
        let available = disk.available_space() as f64;
        if total <= 0.0 {
            continue;
        }
        let used = (total - available).max(0.0);
        out.push(DiskInfo {
            name: disk.name().to_string_lossy().to_string(),
            mount_point: mount,
            total_gb: total / BYTES_PER_GB,
            used_gb: used / BYTES_PER_GB,
            used_percent: (used / total) * 100.0,
        });
    }
    out
}

/// Initialize NVML once. Returns `None` on any machine without an NVIDIA driver.
fn nvml() -> Option<&'static nvml_wrapper::Nvml> {
    static NVML: OnceLock<Option<nvml_wrapper::Nvml>> = OnceLock::new();
    NVML.get_or_init(|| nvml_wrapper::Nvml::init().ok())
        .as_ref()
}

fn collect_gpus() -> Vec<GpuInfo> {
    use nvml_wrapper::enum_wrappers::device::TemperatureSensor;
    let Some(nvml) = nvml() else {
        return Vec::new();
    };
    let Ok(count) = nvml.device_count() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for index in 0..count {
        let Ok(device) = nvml.device_by_index(index) else {
            continue;
        };
        let name = device.name().unwrap_or_else(|_| "NVIDIA GPU".to_string());
        let utilization_percent = device
            .utilization_rates()
            .map(|u| u.gpu as f64)
            .unwrap_or(0.0);
        let (vram_used_mb, vram_total_mb) = device
            .memory_info()
            .map(|m| (m.used as f64 / BYTES_PER_MB, m.total as f64 / BYTES_PER_MB))
            .unwrap_or((0.0, 0.0));
        let temperature_c = device
            .temperature(TemperatureSensor::Gpu)
            .map(|t| t as f64)
            .unwrap_or(0.0);
        // NVML reports power in milliwatts.
        let power_watts = device.power_usage().map(|p| p as f64 / 1000.0).unwrap_or(0.0);
        out.push(GpuInfo {
            name,
            utilization_percent,
            vram_used_mb,
            vram_total_mb,
            temperature_c,
            power_watts,
        });
    }
    out
}

fn collect() -> SystemMetrics {
    let state_lock = metrics_state();
    let mut state = state_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let elapsed = state.last_sample.elapsed().as_secs_f64().max(0.001);

    state.sys.refresh_cpu_usage();
    state.sys.refresh_memory();
    state.sys.refresh_processes(ProcessesToUpdate::All);

    let cpu_percent = state.sys.global_cpu_usage() as f64;
    let ram_total_mb = state.sys.total_memory() as f64 / BYTES_PER_MB;
    let ram_used_mb =
        (state.sys.total_memory() as f64 - state.sys.available_memory() as f64).max(0.0)
            / BYTES_PER_MB;

    // System-wide disk throughput = sum of every process's read/written bytes
    // since the previous refresh, converted to a rate. Cross-platform and does
    // not depend on fragile Windows performance counters.
    let mut read_bytes: u64 = 0;
    let mut written_bytes: u64 = 0;
    for process in state.sys.processes().values() {
        let usage = process.disk_usage();
        read_bytes += usage.read_bytes;
        written_bytes += usage.written_bytes;
    }
    let disk_read_mbps = read_bytes as f64 / BYTES_PER_MB / elapsed;
    let disk_write_mbps = written_bytes as f64 / BYTES_PER_MB / elapsed;

    state.last_sample = Instant::now();

    SystemMetrics {
        cpu_percent,
        ram_used_mb,
        ram_total_mb,
        disks: collect_disks(),
        disk_read_mbps,
        disk_write_mbps,
        gpus: collect_gpus(),
    }
}

/// System resource snapshot for the external monitor window.
#[tauri::command]
pub fn get_system_metrics() -> SystemMetrics {
    collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_reports_nonzero_ram_total() {
        let metrics = collect();
        assert!(metrics.ram_total_mb > 0.0);
    }

    #[test]
    fn disks_have_consistent_used_space() {
        let metrics = collect();
        for disk in &metrics.disks {
            assert!(disk.used_gb <= disk.total_gb + 0.01);
            assert!(disk.used_percent >= 0.0 && disk.used_percent <= 100.01);
        }
    }
}
