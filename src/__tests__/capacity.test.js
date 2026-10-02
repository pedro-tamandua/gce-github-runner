const core = require('@actions/core');

jest.mock('@actions/core', () => ({
  getInput: jest.fn(),
  setOutput: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  setFailed: jest.fn(),
}));

jest.mock('@actions/github', () => ({
  context: { repo: { owner: 'test-owner', repo: 'test-repo' } },
  getOctokit: jest.fn(),
}));

// Shared mocks so tests can drive every client instance the module creates.
const mockInsert = jest.fn();
const mockWait = jest.fn();
const mockMachineTypeGet = jest.fn();
const mockZonesList = jest.fn();
const mockAdviceRequest = jest.fn();

jest.mock('@google-cloud/compute', () => ({
  InstancesClient: jest.fn().mockImplementation(() => ({ insert: mockInsert })),
  ZoneOperationsClient: jest.fn().mockImplementation(() => ({ wait: mockWait })),
  MachineTypesClient: jest.fn().mockImplementation(() => ({ get: mockMachineTypeGet })),
  ZonesClient: jest.fn().mockImplementation(() => ({ listAsync: mockZonesList })),
}));

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: jest.fn().mockResolvedValue({ request: mockAdviceRequest }),
  })),
}));

const defaultInputs = {
  mode: 'start',
  'github-token': 'test-token',
  os: 'linux',
  'project-id': 'test-project',
  image: 'projects/my/global/images/family/runner-arm64',
  'machine-type': 'n4a-standard-4',
  zone: 'us-central1-a',
  region: '',
  subnet: 'default',
  'network-tags': '[]',
  'service-account-scopes': '["https://www.googleapis.com/auth/cloud-platform"]',
  'boot-disk-type': 'pd-balanced',
  'resource-labels': '[]',
  packages: '[]',
  'provisioning-model': 'spot',
  'provisioning-fallback': 'true',
  'capacity-retry-minutes': '0',
  'capacity-retry-interval-seconds': '0',
  'capacity-advisor': 'false',
};

function setupInputs(overrides = {}) {
  const inputs = { ...defaultInputs, ...overrides };
  core.getInput.mockImplementation((name) => (inputs[name] !== undefined ? inputs[name] : ''));
}

function createConfig(overrides = {}) {
  setupInputs(overrides);
  const { Config } = require('../config');
  return new Config();
}

function loadFreshGcp(overrides = {}) {
  setupInputs(overrides);
  let gcp;
  jest.isolateModules(() => {
    gcp = require('../gcp');
  });
  return gcp;
}

function stockout() {
  return new Error("ZONE_RESOURCE_POOL_EXHAUSTED: The zone 'projects/test-project/zones/x' does not have enough resources available");
}

// "zone/machineType/model" of every insert attempt, in order.
function attempts() {
  return mockInsert.mock.calls.map(([req]) => {
    const machineType = req.instanceResource.machineType.split('/').pop();
    const model = req.instanceResource.scheduling ? 'spot' : 'standard';
    return `${req.zone}/${machineType}/${model}`;
  });
}

// Make the inserts for the given "zone/machineType/model" keys succeed; everything else stocks out.
function succeedOn(...keys) {
  mockInsert.mockImplementation(async (req) => {
    const machineType = req.instanceResource.machineType.split('/').pop();
    const model = req.instanceResource.scheduling ? 'spot' : 'standard';
    if (keys.includes(`${req.zone}/${machineType}/${model}`)) {
      return [{ latestResponse: { name: 'op-1' } }];
    }
    throw stockout();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWait.mockResolvedValue([{ status: 'DONE' }]);
  mockMachineTypeGet.mockResolvedValue([{}]);
  mockInsert.mockRejectedValue(stockout());
});

describe('Config - multiple machine types and regions', () => {
  test('machine-type accepts a comma-separated preference list', () => {
    const config = createConfig({ 'machine-type': 'n4a-standard-4, c4a-standard-4' });
    expect(config.machineTypes).toEqual(['n4a-standard-4', 'c4a-standard-4']);
  });

  test('a single machine-type still works', () => {
    const config = createConfig();
    expect(config.machineTypes).toEqual(['n4a-standard-4']);
  });

  test('zones-config accepts a per-entry machineType', () => {
    const config = createConfig({
      'zones-config': JSON.stringify([{ image: 'img', zone: 'us-central1-a', subnet: 's', machineType: 'c4a-standard-4' }]),
    });
    expect(config.zones[0].machineType).toBe('c4a-standard-4');
  });

  test('zones-config rejects an empty machineType', () => {
    expect(() =>
      createConfig({ 'zones-config': JSON.stringify([{ image: 'img', zone: 'us-central1-a', subnet: 's', machineType: '' }]) })
    ).toThrow('Invalid machineType in zones-config at index 0');
  });

  test('zone=any accepts a comma-separated region list', () => {
    const config = createConfig({ zone: 'any', region: 'us-central1, us-east4' });
    expect(config.anyZoneRegions).toEqual(['us-central1', 'us-east4']);
  });

  test('invalid capacity-retry-minutes throws', () => {
    expect(() => createConfig({ 'capacity-retry-minutes': 'abc' })).toThrow("Invalid 'capacity-retry-minutes'");
  });

  test('capacity retry and advisor inputs are read', () => {
    const config = createConfig({ 'capacity-retry-minutes': '90', 'capacity-retry-interval-seconds': '30', 'capacity-advisor': 'true' });
    expect(config.input.capacityRetryMinutes).toBe(90);
    expect(config.input.capacityRetryIntervalSeconds).toBe(30);
    expect(config.input.capacityAdvisor).toBe(true);
  });

  test('warns when ARM and x86 machine types are mixed', () => {
    createConfig({ 'machine-type': 'n4a-standard-4,e2-standard-4' });
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('mix ARM and x86'));
  });
});

describe('gcp.js - candidate ordering', () => {
  test('machine-type preference is the outer loop; pinned entries are tried once', () => {
    const gcp = loadFreshGcp();
    const zones = [
      { zone: 'us-central1-a', image: 'img', subnet: 's' },
      { zone: 'us-central1-b', image: 'img', subnet: 's', machineType: 't2a-standard-4' },
      { zone: 'us-east4-a', image: 'img', subnet: 's' },
    ];
    const candidates = gcp._buildCandidatesForTest(zones, ['n4a-standard-4', 'c4a-standard-4']);
    expect(candidates.map((c) => `${c.zone}/${c.machineType}`)).toEqual([
      'us-central1-a/n4a-standard-4',
      'us-central1-b/t2a-standard-4',
      'us-east4-a/n4a-standard-4',
      'us-central1-a/c4a-standard-4',
      'us-east4-a/c4a-standard-4',
    ]);
  });

  test('classifies stockout and quota errors as capacity errors', () => {
    const gcp = loadFreshGcp();
    expect(gcp._isCapacityErrorForTest(stockout())).toBe(true);
    expect(gcp._isCapacityErrorForTest(new Error("GCE operation failed: QUOTA_EXCEEDED: Quota 'CPUS' exceeded"))).toBe(true);
    expect(gcp._isCapacityErrorForTest(new Error('Invalid value for field resource.machineType'))).toBe(false);
  });
});

describe('gcp.js - startInstance failover', () => {
  test('falls back to the next machine type after all zones stock out', async () => {
    const gcp = loadFreshGcp({
      'machine-type': 'n4a-standard-4,c4a-standard-4',
      'zones-config': JSON.stringify([
        { image: 'img', zone: 'us-central1-a', subnet: 's' },
        { image: 'img', zone: 'us-east4-a', subnet: 's' },
      ]),
    });
    succeedOn('us-east4-a/c4a-standard-4/spot');

    const result = await gcp.startInstance('lbl', 'tok', null);

    expect(result).toEqual({ instanceId: 'gce-runner-lbl', zone: 'us-east4-a', machineType: 'c4a-standard-4', provisioningModel: 'spot' });
    expect(attempts()).toEqual([
      'us-central1-a/n4a-standard-4/spot',
      'us-east4-a/n4a-standard-4/spot',
      'us-central1-a/c4a-standard-4/spot',
      'us-east4-a/c4a-standard-4/spot',
    ]);
  });

  test('uses hyperdisk for C4A/N4A and pd for T2A in the same run', async () => {
    const gcp = loadFreshGcp({ 'machine-type': 'n4a-standard-4,t2a-standard-4' });
    succeedOn('us-central1-a/t2a-standard-4/spot');

    await gcp.startInstance('lbl', 'tok', null);

    const diskTypes = mockInsert.mock.calls.map(([req]) => req.instanceResource.disks[0].initializeParams.diskType.split('/').pop());
    expect(diskTypes).toEqual(['hyperdisk-balanced', 'pd-balanced']);
  });

  test('skips zone/machine-type combinations GCE does not offer', async () => {
    const gcp = loadFreshGcp({ 'machine-type': 't2a-standard-4,n4a-standard-4' });
    mockMachineTypeGet.mockImplementation(async ({ machineType }) => {
      if (machineType === 't2a-standard-4') {
        throw Object.assign(new Error('not found'), { code: 5 });
      }
      return [{}];
    });
    succeedOn('us-central1-a/n4a-standard-4/spot');

    await gcp.startInstance('lbl', 'tok', null);

    expect(attempts()).toEqual(['us-central1-a/n4a-standard-4/spot']);
  });

  test('fails clearly when no machine type is offered anywhere', async () => {
    const gcp = loadFreshGcp();
    mockMachineTypeGet.mockRejectedValue(Object.assign(new Error('not found'), { code: 5 }));

    await expect(gcp.startInstance('lbl', 'tok', null)).rejects.toThrow('is offered in the configured zones');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('zone=any expands every listed region in order', async () => {
    const gcp = loadFreshGcp({ zone: 'any', region: 'us-east4,us-central1' });
    mockZonesList.mockImplementation(async function* () {
      yield { name: 'us-central1-b', status: 'UP', region: 'regions/us-central1' };
      yield { name: 'us-central1-a', status: 'UP', region: 'regions/us-central1' };
      yield { name: 'us-east4-a', status: 'UP', region: 'regions/us-east4' };
      yield { name: 'us-west1-a', status: 'UP', region: 'regions/us-west1' };
    });

    await expect(gcp.startInstance('lbl', 'tok', null)).rejects.toThrow('Failed to start GCE instance');

    expect(attempts().filter((a) => a.endsWith('/spot'))).toEqual([
      'us-east4-a/n4a-standard-4/spot',
      'us-central1-a/n4a-standard-4/spot',
      'us-central1-b/n4a-standard-4/spot',
    ]);
  });
});

describe('gcp.js - capacity advisor', () => {
  function adviceFor(scoresByKey) {
    mockAdviceRequest.mockImplementation(async ({ data }) => {
      const machineType = data.instanceFlexibilityPolicy.instanceSelections.candidate.machineTypes[0];
      const zone = data.distributionPolicy.zones[0].zone.split('/').pop();
      const [obtainability, uptime] = scoresByKey[`${zone}/${machineType}`];
      return { data: { recommendations: [{ scores: { obtainability, estimatedUptime: `${uptime}s` } }] } };
    });
  }

  const twoZones = JSON.stringify([
    { image: 'img', zone: 'us-central1-a', subnet: 's' },
    { image: 'img', zone: 'us-central1-b', subnet: 's' },
  ]);

  test('ranks spot attempts by obtainability, keeping preference among near-equal scores', async () => {
    const gcp = loadFreshGcp({ 'capacity-advisor': 'true', 'machine-type': 'n4a-standard-4,c4a-standard-4', 'zones-config': twoZones });
    adviceFor({
      'us-central1-a/n4a-standard-4': [0.2, 3600],
      'us-central1-b/n4a-standard-4': [0.91, 3600],
      'us-central1-a/c4a-standard-4': [0.9, 3600],
      'us-central1-b/c4a-standard-4': [0.5, 3600],
    });

    await expect(gcp.startInstance('lbl', 'tok', null)).rejects.toThrow();

    expect(attempts().filter((a) => a.endsWith('/spot'))).toEqual([
      'us-central1-b/n4a-standard-4/spot',
      'us-central1-a/c4a-standard-4/spot',
      'us-central1-b/c4a-standard-4/spot',
      'us-central1-a/n4a-standard-4/spot',
    ]);
    // Standard attempts are not ranked by the (Spot-only) advisor.
    expect(attempts().filter((a) => a.endsWith('/standard'))).toEqual([
      'us-central1-a/n4a-standard-4/standard',
      'us-central1-b/n4a-standard-4/standard',
      'us-central1-a/c4a-standard-4/standard',
      'us-central1-b/c4a-standard-4/standard',
    ]);
  });

  test('keeps the configured order when the advisor is unavailable', async () => {
    const gcp = loadFreshGcp({ 'capacity-advisor': 'true', 'zones-config': twoZones });
    mockAdviceRequest.mockRejectedValue(new Error('The service is not available for this project.'));
    succeedOn('us-central1-a/n4a-standard-4/spot');

    await gcp.startInstance('lbl', 'tok', null);

    expect(attempts()).toEqual(['us-central1-a/n4a-standard-4/spot']);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Capacity Advisor unavailable'));
  });

  test('is not called when capacity-advisor is false', async () => {
    const gcp = loadFreshGcp({ 'zones-config': twoZones });
    succeedOn('us-central1-a/n4a-standard-4/spot');

    await gcp.startInstance('lbl', 'tok', null);

    expect(mockAdviceRequest).not.toHaveBeenCalled();
  });
});

describe('gcp.js - capacity retry', () => {
  test('without capacity-retry-minutes it fails after one round', async () => {
    const gcp = loadFreshGcp();

    await expect(gcp.startInstance('lbl', 'tok', null)).rejects.toThrow('Failed to start GCE instance');
    expect(attempts()).toEqual(['us-central1-a/n4a-standard-4/spot', 'us-central1-a/n4a-standard-4/standard']);
  });

  test('retries whole rounds on stockout until capacity appears', async () => {
    const gcp = loadFreshGcp({ 'capacity-retry-minutes': '30', 'provisioning-fallback': 'false' });
    mockInsert.mockRejectedValueOnce(stockout()).mockRejectedValueOnce(stockout()).mockResolvedValue([{ latestResponse: { name: 'op' } }]);

    const result = await gcp.startInstance('lbl', 'tok', null);

    expect(result.zone).toBe('us-central1-a');
    expect(mockInsert).toHaveBeenCalledTimes(3);
  });

  test('does not retry when no attempt failed for capacity reasons', async () => {
    const gcp = loadFreshGcp({ 'capacity-retry-minutes': '30' });
    mockInsert.mockRejectedValue(new Error('Invalid value for field resource.disks[0].initializeParams.sourceImage'));

    await expect(gcp.startInstance('lbl', 'tok', null)).rejects.toThrow('sourceImage');
    expect(mockInsert).toHaveBeenCalledTimes(2);
  });

  test('stops retrying when the deadline passes', async () => {
    let now = 0;
    const dateNow = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const gcp = loadFreshGcp({ 'capacity-retry-minutes': '10', 'provisioning-fallback': 'false' });
    mockInsert.mockImplementation(async () => {
      now += 4 * 60 * 1000;
      throw stockout();
    });

    await expect(gcp.startInstance('lbl', 'tok', null)).rejects.toThrow('Failed to start GCE instance');
    expect(mockInsert).toHaveBeenCalledTimes(3);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('exhausted after 3 round(s)'));
    dateNow.mockRestore();
  });

  test('refreshes the registration token on long retries', async () => {
    let now = 0;
    const dateNow = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const gcp = loadFreshGcp({ 'capacity-retry-minutes': '120', 'provisioning-fallback': 'false' });
    let calls = 0;
    mockInsert.mockImplementation(async () => {
      calls++;
      if (calls < 3) {
        now += 30 * 60 * 1000;
        throw stockout();
      }
      return [{ latestResponse: { name: 'op' } }];
    });
    const refreshRegistrationToken = jest.fn().mockResolvedValue('fresh-token');

    await gcp.startInstance('lbl', 'old-token', null, { refreshRegistrationToken });

    expect(refreshRegistrationToken).toHaveBeenCalledTimes(1);
    const startupScript = (call) => call[0].instanceResource.metadata.items[0].value;
    expect(startupScript(mockInsert.mock.calls[0])).toContain('old-token');
    expect(startupScript(mockInsert.mock.calls[2])).toContain('fresh-token');
    dateNow.mockRestore();
  });
});
