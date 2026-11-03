/**
 * GPU passthrough config shared by the AI Assistant (Ollama) and opt-in custom apps (#1447).
 *
 * Kept pure so the exact Docker payload is unit-testable without a daemon. DockerService owns
 * detection (`_detectGPUType()`), broadcasting and the ROCm image swap for Ollama; this module
 * only answers "what goes into HostConfig for this GPU type", so Ollama and custom apps cannot
 * drift apart on the device config itself.
 */

export type DetectedGpuType = 'nvidia' | 'amd' | 'none'

export type GpuDeviceRequest = { Driver: string; Count: number; Capabilities: string[][] }
export type GpuDeviceMapping = {
  PathOnHost: string
  PathInContainer: string
  CgroupPermissions: string
}

/**
 * Container label that records a custom app's opt-in to GPU access.
 *
 * The flag lives in the stored container_config (as a label) rather than as raw
 * DeviceRequests/Devices so that (a) detection runs at container-creation time, picking up a
 * GPU added or a toolkit installed since the app was configured, and (b) users never get to
 * hand NOMAD arbitrary device config: the validators strip any HostConfig/DeviceRequests keys,
 * and this boolean is the only GPU input a custom app can carry. Being a real Docker label, it
 * also shows up in `docker inspect`, which a later "GPU claims" view can key on.
 */
export const CUSTOM_APP_GPU_LABEL = 'io.project-nomad.gpu'

/** All NVIDIA GPUs, exactly what `docker run --gpus all` requests. */
export function nvidiaDeviceRequests(): GpuDeviceRequest[] {
  return [
    {
      Driver: 'nvidia',
      Count: -1, // -1 means all GPUs
      Capabilities: [['gpu']],
    },
  ]
}

/**
 * Docker Devices for AMD GPU passthrough.
 *
 * /dev/kfd is the Kernel Fusion Driver ROCm requires; /dev/dri is the DRM device tree. Passing
 * /dev/dri as a single directory entry mirrors Docker CLI --device behavior — the daemon expands
 * it to all child devices (card*, renderD*) regardless of how the host enumerates them. This
 * avoids the brittle hardcoded fallback (card0/renderD128) an earlier implementation used, which
 * was wrong on systems where the AMD GPU enumerates as card1+ (e.g. UM890 Pro 780M iGPU).
 */
export function amdGpuDevices(): GpuDeviceMapping[] {
  return [
    { PathOnHost: '/dev/kfd', PathInContainer: '/dev/kfd', CgroupPermissions: 'rwm' },
    { PathOnHost: '/dev/dri', PathInContainer: '/dev/dri', CgroupPermissions: 'rwm' },
  ]
}

/**
 * Return `hostConfig` with GPU passthrough for `gpuType` merged in. Never mutates the input.
 *
 * `'none'` returns the config unchanged — callers broadcast the CPU-only notice themselves.
 *
 * Deliberately no `GroupAdd: ['video', 'render']` for AMD. Docker resolves group *names* against
 * the image's own /etc/group and refuses to start the container when one is missing, and slim
 * Debian/Ubuntu bases ship no `render` group. Ollama has never needed it (it runs as root), and
 * a custom app that drops privileges can add its own group mapping in its image.
 */
export function applyGpuHostConfig<T extends Record<string, any>>(
  hostConfig: T,
  gpuType: DetectedGpuType
): T & { DeviceRequests?: GpuDeviceRequest[]; Devices?: GpuDeviceMapping[] } {
  if (gpuType === 'nvidia') return { ...hostConfig, DeviceRequests: nvidiaDeviceRequests() }
  if (gpuType === 'amd') return { ...hostConfig, Devices: amdGpuDevices() }
  return { ...hostConfig }
}

/** Whether a stored custom-app container config has opted into GPU access. */
export function customAppWantsGpu(
  containerConfig: Record<string, any> | null | undefined
): boolean {
  return containerConfig?.Labels?.[CUSTOM_APP_GPU_LABEL] === 'true'
}

/**
 * Set or clear the GPU opt-in on a container config, in place. Clearing removes the label (and an
 * emptied Labels object) rather than writing "false", so a config that never used the flag
 * round-trips unchanged.
 */
export function setCustomAppGpuFlag(containerConfig: Record<string, any>, enabled: boolean): void {
  if (enabled) {
    containerConfig.Labels = { ...(containerConfig.Labels ?? {}), [CUSTOM_APP_GPU_LABEL]: 'true' }
    return
  }
  if (!containerConfig.Labels) return
  delete containerConfig.Labels[CUSTOM_APP_GPU_LABEL]
  if (Object.keys(containerConfig.Labels).length === 0) delete containerConfig.Labels
}
