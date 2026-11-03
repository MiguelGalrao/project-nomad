/**
 * Opt-in GPU access for Supply Depot custom apps (#1447).
 *
 * The custom-app path stores only a boolean opt-in (a container label) and resolves the device
 * config at container creation from the detected GPU, reusing the exact config the AI Assistant
 * gets. These tests pin that config per GPU type and the boundary that keeps raw device config
 * out of user input.
 *
 * Pure functions only, no Docker, MySQL, Redis, Qdrant or Ollama needed:
 *   npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CUSTOM_APP_GPU_LABEL,
  amdGpuDevices,
  applyGpuHostConfig,
  customAppWantsGpu,
  nvidiaDeviceRequests,
  setCustomAppGpuFlag,
} from '../../app/utils/gpu_passthrough.js'
import { customAppValidator, updateCustomAppValidator } from '../../app/validators/system.js'

/** HostConfig shape the custom-app controller builds before any GPU is applied. */
function customHostConfig() {
  return {
    RestartPolicy: { Name: 'unless-stopped' },
    PortBindings: { '80/tcp': [{ HostPort: '8600' }] },
    Memory: 1024 * 1024 * 1024,
    NanoCpus: 1e9,
    Binds: ['/opt/project-nomad/storage/whisper:/data'],
  }
}

// ── Device config, shared with the AI Assistant ─────────────────────────────

test('NVIDIA requests every GPU, exactly what the AI Assistant has always used', () => {
  assert.deepEqual(nvidiaDeviceRequests(), [
    { Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] },
  ])
})

test('AMD passes /dev/kfd and the whole /dev/dri tree', () => {
  assert.deepEqual(amdGpuDevices(), [
    { PathOnHost: '/dev/kfd', PathInContainer: '/dev/kfd', CgroupPermissions: 'rwm' },
    { PathOnHost: '/dev/dri', PathInContainer: '/dev/dri', CgroupPermissions: 'rwm' },
  ])
})

test('nvidia adds DeviceRequests and keeps every other HostConfig key', () => {
  const hc = applyGpuHostConfig(customHostConfig(), 'nvidia')
  assert.deepEqual(hc, { ...customHostConfig(), DeviceRequests: nvidiaDeviceRequests() })
  assert.equal('Devices' in hc, false)
})

test('amd adds Devices, no DeviceRequests, and no GroupAdd that could fail on slim images', () => {
  const hc = applyGpuHostConfig(customHostConfig(), 'amd')
  assert.deepEqual(hc, { ...customHostConfig(), Devices: amdGpuDevices() })
  assert.equal('DeviceRequests' in hc, false)
  assert.equal('GroupAdd' in hc, false)
})

test('none leaves the HostConfig as it was (CPU-only, never a failure)', () => {
  assert.deepEqual(applyGpuHostConfig(customHostConfig(), 'none'), customHostConfig())
})

test('applying GPU config never mutates the stored HostConfig', () => {
  const original = customHostConfig()
  applyGpuHostConfig(original, 'nvidia')
  applyGpuHostConfig(original, 'amd')
  assert.deepEqual(original, customHostConfig())
})

test('each call returns fresh device arrays, so one container config cannot leak into another', () => {
  const a = applyGpuHostConfig({}, 'nvidia')
  const b = applyGpuHostConfig({}, 'nvidia')
  assert.notEqual(a.DeviceRequests, b.DeviceRequests)
  a.DeviceRequests![0].Count = 1
  assert.equal(b.DeviceRequests![0].Count, -1)
})

// ── The stored opt-in ───────────────────────────────────────────────────────

test('the opt-in round-trips through the stored container config', () => {
  const config: Record<string, any> = { HostConfig: customHostConfig() }
  assert.equal(customAppWantsGpu(config), false)

  setCustomAppGpuFlag(config, true)
  assert.equal(config.Labels[CUSTOM_APP_GPU_LABEL], 'true')
  // container_config is persisted as JSON, so the flag has to survive serialization.
  assert.equal(customAppWantsGpu(JSON.parse(JSON.stringify(config))), true)

  setCustomAppGpuFlag(config, false)
  assert.equal(customAppWantsGpu(config), false)
})

test('clearing the opt-in drops an emptied Labels object but keeps other labels', () => {
  const bare: Record<string, any> = {}
  setCustomAppGpuFlag(bare, true)
  setCustomAppGpuFlag(bare, false)
  assert.deepEqual(bare, {})

  const labelled: Record<string, any> = { Labels: { 'com.example': 'x' } }
  setCustomAppGpuFlag(labelled, true)
  setCustomAppGpuFlag(labelled, false)
  assert.deepEqual(labelled, { Labels: { 'com.example': 'x' } })
})

test('clearing a flag that was never set leaves the config untouched', () => {
  const config: Record<string, any> = { HostConfig: customHostConfig() }
  setCustomAppGpuFlag(config, false)
  assert.deepEqual(config, { HostConfig: customHostConfig() })
})

test('only the exact "true" label opts in', () => {
  assert.equal(customAppWantsGpu(null), false)
  assert.equal(customAppWantsGpu({}), false)
  assert.equal(customAppWantsGpu({ Labels: { [CUSTOM_APP_GPU_LABEL]: 'false' } }), false)
  assert.equal(customAppWantsGpu({ Labels: { [CUSTOM_APP_GPU_LABEL]: 'true' } }), true)
})

test('a raw DeviceRequests in a stored config does not count as the opt-in', () => {
  assert.equal(customAppWantsGpu({ HostConfig: { DeviceRequests: nvidiaDeviceRequests() } }), false)
})

// ── End to end: stored config → HostConfig at container creation ────────────

for (const gpuType of ['nvidia', 'amd', 'none'] as const) {
  test(`opted-in app on a ${gpuType} host gets the matching HostConfig`, () => {
    const config: Record<string, any> = { HostConfig: customHostConfig() }
    setCustomAppGpuFlag(config, true)
    const stored = JSON.parse(JSON.stringify(config))
    assert.equal(customAppWantsGpu(stored), true)
    const hc = applyGpuHostConfig(stored.HostConfig, gpuType)
    assert.deepEqual(hc.DeviceRequests, gpuType === 'nvidia' ? nvidiaDeviceRequests() : undefined)
    assert.deepEqual(hc.Devices, gpuType === 'amd' ? amdGpuDevices() : undefined)
  })
}

// ── Validators: accept the flag, never raw device config ────────────────────

const BASE_CREATE = { friendly_name: 'Whisper', image: 'ghcr.io/example/whisper:1.0.0' }
const BASE_UPDATE = { ...BASE_CREATE, service_name: 'nomad_custom_whisper' }

for (const [name, validator, base] of [
  ['create', customAppValidator, BASE_CREATE],
  ['update', updateCustomAppValidator, BASE_UPDATE],
] as const) {
  test(`${name} validator accepts gpu true/false and leaves it optional`, async () => {
    const on = await validator.validate({ ...base, gpu: true })
    const off = await validator.validate({ ...base, gpu: false })
    const omitted = await validator.validate({ ...base })
    assert.equal(on.gpu, true)
    assert.equal(off.gpu, false)
    assert.equal(omitted.gpu, undefined)
  })

  test(`${name} validator rejects a non-boolean gpu`, async () => {
    await assert.rejects(validator.validate({ ...base, gpu: 'all' }))
    await assert.rejects(validator.validate({ ...base, gpu: { Driver: 'nvidia' } }))
  })

  test(`${name} validator strips raw device config a client tries to send`, async () => {
    const out: Record<string, any> = await validator.validate({
      ...base,
      gpu: true,
      DeviceRequests: [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }],
      Devices: [{ PathOnHost: '/dev/sda', PathInContainer: '/dev/sda', CgroupPermissions: 'rwm' }],
      HostConfig: { Privileged: true, DeviceRequests: [] },
      Labels: { [CUSTOM_APP_GPU_LABEL]: 'true' },
    })
    assert.equal(out.gpu, true)
    for (const key of ['DeviceRequests', 'Devices', 'HostConfig', 'Labels']) {
      assert.equal(key in out, false, `${key} must not survive validation`)
    }
  })
}
