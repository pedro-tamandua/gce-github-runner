const core = require('@actions/core');
const github = require('@actions/github');

// Mock @actions/core
jest.mock('@actions/core', () => ({
  getInput: jest.fn(),
  setOutput: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  setFailed: jest.fn(),
}));

// Mock @actions/github
jest.mock('@actions/github', () => ({
  context: {
    repo: {
      owner: 'test-owner',
      repo: 'test-repo',
    },
  },
  getOctokit: jest.fn(),
}));

// Mock Google Cloud Compute SDK
jest.mock('@google-cloud/compute', () => ({
  InstancesClient: jest.fn().mockImplementation(() => ({
    insert: jest.fn(),
    delete: jest.fn(),
    get: jest.fn(),
    getSerialPortOutput: jest.fn(),
  })),
  ZoneOperationsClient: jest.fn().mockImplementation(() => ({
    wait: jest.fn(),
  })),
}));

// Default input values used across tests
const defaultInputs = {
  'mode': 'start',
  'github-token': 'test-token',
  'os': 'linux',
  'project-id': 'test-project',
  'image': 'projects/debian-cloud/global/images/family/debian-12',
  'machine-type': 'e2-small',
  'zone': 'us-central1-a',
  'region': '',
  'subnet': 'default',
  'network': '',
  'network-tags': '[]',
  'no-external-ip': 'false',
  'label': '',
  'instance-id': '',
  'instance-zone': '',
  'service-account-email': '',
  'service-account-scopes': '["https://www.googleapis.com/auth/cloud-platform"]',
  'spot': '',
  'pre-runner-script': '',
  'runner-home-dir': '',
  'startup-quiet-period-seconds': '',
  'startup-retry-interval-seconds': '',
  'startup-timeout-minutes': '5',
  'run-runner-as-service': 'false',
  'run-runner-as-user': '',
  'boot-disk-size': '',
  'boot-disk-type': 'pd-balanced',
  'zones-config': '',
  'packages': '[]',
  'resource-labels': '[]',
  'use-jit': 'false',
  'runner-group-id': '1',
  'runner-debug': 'false',
};

function setupInputs(overrides = {}) {
  const inputs = { ...defaultInputs, ...overrides };
  core.getInput.mockImplementation((name) => (inputs[name] !== undefined ? inputs[name] : ''));
}

function createConfig() {
  const { Config } = require('../config');
  return new Config();
}

// Load a fresh gcp module with custom inputs using jest.isolateModules
function loadFreshGcp(inputOverrides = {}) {
  setupInputs(inputOverrides);

  let gcp;
  jest.isolateModules(() => {
    gcp = require('../gcp');
  });
  return gcp;
}

describe('Config - JIT inputs', () => {
  test('reads useJit as false by default', () => {
    setupInputs();
    const config = createConfig();
    expect(config.input.useJit).toBe(false);
  });

  test('reads useJit as true when set', () => {
    setupInputs({ 'use-jit': 'true' });
    const config = createConfig();
    expect(config.input.useJit).toBe(true);
  });

  test('reads runnerGroupId with default value of 1', () => {
    setupInputs();
    const config = createConfig();
    expect(config.input.runnerGroupId).toBe(1);
  });

  test('reads custom runnerGroupId', () => {
    setupInputs({ 'runner-group-id': '42' });
    const config = createConfig();
    expect(config.input.runnerGroupId).toBe(42);
  });

  test('throws when useJit and runAsService are both true', () => {
    setupInputs({ 'use-jit': 'true', 'run-runner-as-service': 'true' });
    expect(() => createConfig()).toThrow(
      "The 'use-jit' and 'run-runner-as-service' inputs are incompatible"
    );
  });

  test('allows useJit without runAsService', () => {
    setupInputs({ 'use-jit': 'true', 'run-runner-as-service': 'false' });
    expect(() => createConfig()).not.toThrow();
  });
});

describe('Config - GCP specifics', () => {
  test('resolves project id from input', () => {
    setupInputs({ 'project-id': 'my-project' });
    const config = createConfig();
    expect(config.projectId).toBe('my-project');
  });

  test('falls back to GCP_PROJECT_ID env var', () => {
    setupInputs({ 'project-id': '' });
    process.env.GCP_PROJECT_ID = 'env-project';
    const config = createConfig();
    expect(config.projectId).toBe('env-project');
    delete process.env.GCP_PROJECT_ID;
  });

  test('throws when no project id is available in start mode', () => {
    setupInputs({ 'project-id': '' });
    delete process.env.GCP_PROJECT_ID;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCLOUD_PROJECT;
    delete process.env.CLOUDSDK_CORE_PROJECT;
    expect(() => createConfig()).toThrow('No Google Cloud project id found');
  });

  test('builds a single zone config from individual params', () => {
    setupInputs();
    const config = createConfig();
    expect(config.zones).toHaveLength(1);
    expect(config.zones[0]).toMatchObject({
      image: 'projects/debian-cloud/global/images/family/debian-12',
      zone: 'us-central1-a',
      subnet: 'default',
    });
  });

  test('throws when machine-type is missing in start mode', () => {
    setupInputs({ 'machine-type': '' });
    expect(() => createConfig()).toThrow("The 'machine-type' input is required");
  });

  test('parses zones-config for multi-zone failover', () => {
    setupInputs({
      'zones-config': JSON.stringify([
        { image: 'img-a', zone: 'us-central1-a', subnet: 'default' },
        { image: 'img-b', zone: 'us-east1-b', subnet: 'default' },
      ]),
    });
    const config = createConfig();
    expect(config.zones).toHaveLength(2);
    expect(config.zones[1].zone).toBe('us-east1-b');
  });

  test('builds resource labels map from stringified array', () => {
    setupInputs({ 'resource-labels': '[{"Key":"team","Value":"ci"}]' });
    const config = createConfig();
    expect(config.resourceLabels).toEqual({ team: 'ci' });
  });

  test('zone=any sets anyZone and requires region', () => {
    setupInputs({ zone: 'any', region: 'us-central1' });
    const config = createConfig();
    expect(config.anyZone).toBe(true);
    expect(config.anyZoneRegion).toBe('us-central1');
    expect(config.zones).toHaveLength(0); // resolved at runtime
  });

  test('zone=any without region throws', () => {
    setupInputs({ zone: 'any', region: '' });
    expect(() => createConfig()).toThrow("The 'region' input is required when 'zone' is 'any'");
  });

  test('zone=any still requires image and subnet', () => {
    setupInputs({ zone: 'any', region: 'us-central1', image: '' });
    expect(() => createConfig()).toThrow("'image' and 'subnet' are also required");
  });

  test('default provisioning model is spot with fallback', () => {
    setupInputs();
    const config = createConfig();
    expect(config.provisioningModel).toBe('spot');
    expect(config.provisioningFallback).toBe(true);
  });

  test('provisioning-model standard is honored', () => {
    setupInputs({ 'provisioning-model': 'standard' });
    const config = createConfig();
    expect(config.provisioningModel).toBe('standard');
  });

  test('provisioning-fallback false disables fallback', () => {
    setupInputs({ 'provisioning-fallback': 'false' });
    const config = createConfig();
    expect(config.provisioningFallback).toBe(false);
  });

  test('legacy spot=true aliases to provisioning-model spot', () => {
    setupInputs({ 'spot': 'true', 'provisioning-model': 'standard' });
    const config = createConfig();
    expect(config.provisioningModel).toBe('spot');
  });

  test('invalid provisioning-model throws', () => {
    setupInputs({ 'provisioning-model': 'cheap' });
    expect(() => createConfig()).toThrow("Invalid 'provisioning-model'");
  });

  test('stop mode requires instance-id and instance-zone', () => {
    setupInputs({ 'mode': 'stop', 'instance-id': '', 'instance-zone': '' });
    expect(() => createConfig()).toThrow("The 'instance-id' input is required");
  });
});

describe('gh.js - getJitRunnerConfig', () => {
  test('calls generate-jitconfig API and returns config', async () => {
    setupInputs({ 'use-jit': 'true' });

    const mockRequest = jest.fn().mockResolvedValue({
      data: {
        runner: { id: 123, name: 'gce-abc12' },
        encoded_jit_config: 'base64encodedconfig',
      },
    });
    github.getOctokit.mockReturnValue({ request: mockRequest });

    let gh;
    jest.isolateModules(() => {
      gh = require('../gh');
    });

    const result = await gh.getJitRunnerConfig('abc12');

    expect(mockRequest).toHaveBeenCalledWith(
      'POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig',
      expect.objectContaining({
        owner: 'test-owner',
        repo: 'test-repo',
        name: 'gce-abc12',
        runner_group_id: 1,
        labels: ['abc12'],
        work_folder: '_work',
      })
    );
    expect(result).toEqual({
      runnerId: 123,
      encodedJitConfig: 'base64encodedconfig',
    });
  });

  test('throws on API error', async () => {
    setupInputs({ 'use-jit': 'true' });

    const mockRequest = jest.fn().mockRejectedValue(new Error('API error'));
    github.getOctokit.mockReturnValue({ request: mockRequest });

    let gh;
    jest.isolateModules(() => {
      gh = require('../gh');
    });

    await expect(gh.getJitRunnerConfig('abc12')).rejects.toThrow('API error');
    expect(core.error).toHaveBeenCalledWith('GitHub JIT runner configuration generation error');
  });
});

describe('gcp.js - startup-script generation', () => {
  test('JIT startup-script does not contain config.sh', () => {
    const gcp = loadFreshGcp({ 'use-jit': 'true' });
    const script = gcp._buildStartupScriptForTest(null, 'testlabel', 'encodedconfig123');
    expect(script).not.toContain('config.sh');
    expect(script).toContain('--jitconfig encodedconfig123');
  });

  test('JIT startup-script with runnerHomeDir skips download', () => {
    const gcp = loadFreshGcp({ 'use-jit': 'true', 'runner-home-dir': '/home/runner/actions-runner' });
    const script = gcp._buildStartupScriptForTest(null, 'testlabel', 'encodedconfig123');
    expect(script).toContain('/home/runner/actions-runner');
    expect(script).not.toContain('mkdir actions-runner');
    expect(script).not.toContain('config.sh');
    expect(script).toContain('--jitconfig encodedconfig123');
  });

  test('JIT startup-script with runAsUser uses runuser', () => {
    const gcp = loadFreshGcp({ 'use-jit': 'true', 'run-runner-as-user': 'ubuntu' });
    const script = gcp._buildStartupScriptForTest(null, 'testlabel', 'encodedconfig123');
    expect(script).toContain('runuser -u ubuntu -- ./run.sh --jitconfig encodedconfig123');
  });

  test('standard (non-JIT) startup-script contains config.sh', () => {
    const gcp = loadFreshGcp();
    const script = gcp._buildStartupScriptForTest('regtoken123', 'testlabel', null);
    expect(script).toContain('config.sh');
    expect(script).toContain('--token regtoken123');
    expect(script).not.toContain('--jitconfig');
  });

  test('standard startup-script with runAsService includes svc.sh', () => {
    const gcp = loadFreshGcp({ 'run-runner-as-service': 'true' });
    const script = gcp._buildStartupScriptForTest('regtoken123', 'testlabel', null);
    expect(script).toContain('svc.sh install');
    expect(script).toContain('svc.sh start');
  });

  test('JIT startup-script does not include svc.sh', () => {
    const gcp = loadFreshGcp({ 'use-jit': 'true' });
    const script = gcp._buildStartupScriptForTest(null, 'testlabel', 'encodedconfig123');
    expect(script).not.toContain('svc.sh');
  });

  test('startup-script writes setup script to /opt/ and runs with nohup', () => {
    const gcp = loadFreshGcp();
    const script = gcp._buildStartupScriptForTest('regtoken123', 'testlabel', null);
    expect(script).toContain('/opt/runner-setup.sh');
    expect(script).toContain('nohup /opt/runner-setup.sh &');
  });

  test('startup-script writes the pre-runner script', () => {
    const gcp = loadFreshGcp({ 'pre-runner-script': 'echo hello' });
    const script = gcp._buildStartupScriptForTest('regtoken123', 'testlabel', null);
    expect(script).toContain('/tmp/pre-runner-script.sh');
    expect(script).toContain('echo hello');
  });

  test('standard startup-script removes stale runner config files', () => {
    const gcp = loadFreshGcp({ 'runner-home-dir': '/home/runner/actions-runner' });
    const script = gcp._buildStartupScriptForTest('regtoken123', 'testlabel', null);
    expect(script).toContain('rm -f .runner .credentials .credentials_rsaparams');
  });

  test('JIT startup-script removes stale runner config files', () => {
    const gcp = loadFreshGcp({ 'use-jit': 'true', 'runner-home-dir': '/home/runner/actions-runner' });
    const script = gcp._buildStartupScriptForTest(null, 'testlabel', 'encodedconfig123');
    expect(script).toContain('rm -f .runner .credentials .credentials_rsaparams');
  });

  test('standard startup-script with runAsUser uses runuser', () => {
    const gcp = loadFreshGcp({ 'run-runner-as-user': 'gce-user' });
    const script = gcp._buildStartupScriptForTest('regtoken123', 'testlabel', null);
    expect(script).toContain('runuser -u gce-user -- ./run.sh');
  });

  test('standard startup-script with runAsUser uses tolerant chown', () => {
    const gcp = loadFreshGcp({ 'run-runner-as-user': 'gce-user' });
    const script = gcp._buildStartupScriptForTest('regtoken123', 'testlabel', null);
    expect(script).toContain('chown -R gce-user . 2>&1 || true');
  });

  test('startup-script installs packages when specified', () => {
    const gcp = loadFreshGcp({ 'packages': '["git", "docker.io"]' });
    const script = gcp._buildStartupScriptForTest('regtoken123', 'testlabel', null);
    expect(script).toContain('git docker.io');
    expect(script).toContain('apt-get install -y');
  });
});

describe('gcp.js - runner-debug', () => {
  test('debug mode includes echo statements', () => {
    const gcp = loadFreshGcp({ 'runner-debug': 'true' });
    const script = gcp._buildStartupScriptForTest('regtoken123', 'testlabel', null);
    expect(script).toContain('[RUNNER]');
    expect(script).toContain('echo "[RUNNER] Setup script started at');
  });

  test('non-debug mode excludes echo statements', () => {
    const gcp = loadFreshGcp({ 'runner-debug': 'false' });
    const script = gcp._buildStartupScriptForTest('regtoken123', 'testlabel', null);
    expect(script).not.toContain('[RUNNER] Setup script started');
  });
});

describe('gcp.js - Windows os', () => {
  test('config accepts os=windows', () => {
    setupInputs({ os: 'windows' });
    const config = createConfig();
    expect(config.input.os).toBe('windows');
  });

  test('config rejects invalid os', () => {
    setupInputs({ os: 'macos' });
    expect(() => createConfig()).toThrow("Invalid 'os' input");
  });

  test('windows startup-script uses PowerShell + config.cmd/run.cmd', () => {
    const gcp = loadFreshGcp({ os: 'windows' });
    const script = gcp._buildStartupScriptForTest('regtoken123', 'testlabel', null);
    expect(script).toContain('actions-runner-win-x64');
    expect(script).toContain('config.cmd --unattended');
    expect(script).toContain('--token regtoken123');
    expect(script).toContain('run.cmd');
    expect(script).not.toContain('config.sh');
    expect(script).not.toContain('#!/bin/bash');
  });

  test('windows JIT uses run.cmd --jitconfig and no config.cmd', () => {
    const gcp = loadFreshGcp({ os: 'windows', 'use-jit': 'true' });
    const script = gcp._buildStartupScriptForTest(null, 'testlabel', 'encodedconfig123');
    expect(script).toContain('--jitconfig');
    expect(script).toContain('encodedconfig123');
    expect(script).not.toContain('config.cmd');
  });

  test('windows startup-script removes stale runner config when home dir set', () => {
    const gcp = loadFreshGcp({ os: 'windows', 'runner-home-dir': 'C:\\\\actions-runner' });
    const script = gcp._buildStartupScriptForTest('regtoken123', 'testlabel', null);
    expect(script).toContain('Remove-Item');
    expect(script).not.toContain('actions-runner-win-x64');
  });

  test('linux remains the default os', () => {
    const gcp = loadFreshGcp();
    const script = gcp._buildStartupScriptForTest('regtoken123', 'testlabel', null);
    expect(script).toContain('#!/bin/bash');
    expect(script).toContain('config.sh');
  });
});

describe('Config - runner-debug input', () => {
  test('reads runnerDebug as false by default', () => {
    setupInputs();
    const config = createConfig();
    expect(config.input.runnerDebug).toBe(false);
  });

  test('reads runnerDebug as true when set', () => {
    setupInputs({ 'runner-debug': 'true' });
    const config = createConfig();
    expect(config.input.runnerDebug).toBe(true);
  });
});
