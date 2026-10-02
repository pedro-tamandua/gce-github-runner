const compute = require('@google-cloud/compute');
const { GoogleAuth } = require('google-auth-library');

const core = require('@actions/core');
const config = require('./config');

const GCP_METADATA = 'http://metadata.google.internal/computeMetadata/v1/instance';

// Derive the region (e.g. "us-central1") from a zone (e.g. "us-central1-a").
function regionFromZone(zone) {
  return zone.replace(/-[a-z]$/, '');
}

// Build the commands to run on the instance via the metadata startup-script.
function buildRunCommands(githubRegistrationToken, label) {
  const debug = config.input.runnerDebug;

  // Helper: only include a command when debug is enabled
  const dbg = (cmd) => (debug ? cmd : null);

  // Common preamble: fail-fast and log capture
  const preamble = [
    '#!/bin/bash',
    'LOGFILE=/tmp/runner-setup.log',
    'exec > >(tee -a "$LOGFILE") 2>&1',
    'set -e',
    dbg('echo "[RUNNER] =========================================="'),
    dbg('echo "[RUNNER] Setup script started at $(date -u)"'),
    dbg('echo "[RUNNER] =========================================="'),
    dbg(`echo "[RUNNER] Instance name: $(curl -sf -H 'Metadata-Flavor: Google' ${GCP_METADATA}/name || echo unknown)"`),
    dbg(`echo "[RUNNER] Machine type: $(curl -sf -H 'Metadata-Flavor: Google' ${GCP_METADATA}/machine-type || echo unknown)"`),
    dbg(`echo "[RUNNER] Zone: $(curl -sf -H 'Metadata-Flavor: Google' ${GCP_METADATA}/zone || echo unknown)"`),
    dbg('echo "[RUNNER] Hostname: $(hostname)"'),
    dbg('echo "[RUNNER] Kernel: $(uname -r)"'),
    dbg('echo "[RUNNER] Disk usage:" && df -h'),
    dbg('echo "[RUNNER] Memory:" && free -h'),
  ].filter(Boolean);

  // Optional package installation (apt-get / yum / dnf auto-detected)
  const packageCommands = [];
  if (config.input.packages && config.input.packages.length > 0) {
    const pkgs = config.input.packages.join(' ');
    packageCommands.push(
      dbg('echo "[RUNNER] Installing packages: ' + pkgs + '"'),
      `if command -v apt-get >/dev/null; then export DEBIAN_FRONTEND=noninteractive; apt-get update -y && apt-get install -y ${pkgs};` +
        ` elif command -v dnf >/dev/null; then dnf install -y ${pkgs};` +
        ` elif command -v yum >/dev/null; then yum install -y ${pkgs}; fi`
    );
  }

  let userData;
  if (config.input.runnerHomeDir) {
    core.info('Runner home directory is specified, so it is expected that the actions-runner software (and dependencies) are pre-installed in the image.');
    userData = [
      ...preamble,
      ...packageCommands.filter(Boolean),
      dbg(`echo "[RUNNER] Changing to runner home dir: ${config.input.runnerHomeDir}"`),
      `cd "${config.input.runnerHomeDir}"`,
      dbg('echo "[RUNNER] Directory contents:" && ls -la'),
      dbg('echo "[RUNNER] Sourcing pre-runner script..."'),
      'source /tmp/pre-runner-script.sh',
      dbg('echo "[RUNNER] Pre-runner script completed"'),
      'export RUNNER_ALLOW_RUNASROOT=1',
      // Remove stale runner config from the image so config.sh doesn't refuse to run
      'rm -f .runner .credentials .credentials_rsaparams',
      dbg(`echo "[RUNNER] Configuring runner with label: ${label}, name: gce-${label}"`),
      `./config.sh --unattended --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label} --name gce-${label} --replace`,
      dbg('echo "[RUNNER] config.sh completed successfully"'),
    ].filter(Boolean);
  } else {
    core.info('Runner home directory is not specified, so the latest actions-runner software will be downloaded and installed.');
    userData = [
      ...preamble,
      ...packageCommands.filter(Boolean),
      dbg('echo "[RUNNER] Creating actions-runner directory"'),
      'mkdir actions-runner && cd actions-runner',
      dbg('echo "[RUNNER] Working directory: $(pwd)"'),
      dbg('echo "[RUNNER] Sourcing pre-runner script..."'),
      'source /tmp/pre-runner-script.sh',
      dbg('echo "[RUNNER] Pre-runner script completed"'),
      dbg('echo "[RUNNER] Detecting architecture..."'),
      'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}',
      dbg('echo "[RUNNER] Architecture: ${RUNNER_ARCH}"'),
      dbg('echo "[RUNNER] Fetching latest runner version from GitHub API..."'),
      `RUNNER_VERSION=$(curl -s "https://api.github.com/repos/actions/runner/releases/latest" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/' | tr -d "v")`,
      dbg('echo "[RUNNER] Runner version: v${RUNNER_VERSION}"'),
      dbg('echo "[RUNNER] Downloading runner tarball..."'),
      'curl -O -L https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz',
      dbg('echo "[RUNNER] Download complete. Extracting..."'),
      'tar xzf ./actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz',
      dbg('echo "[RUNNER] Extraction complete. Directory contents:" && ls -la'),
      'export RUNNER_ALLOW_RUNASROOT=1',
      dbg(`echo "[RUNNER] Configuring runner with label: ${label}, name: gce-${label}"`),
      `./config.sh --unattended --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label} --name gce-${label} --replace`,
      dbg('echo "[RUNNER] config.sh completed successfully"'),
    ].filter(Boolean);
  }
  if (config.input.runAsUser) {
    userData.push(`chown -R ${config.input.runAsUser} . 2>&1 || true`);
  }
  if (config.input.runAsService) {
    core.info('Runner will be started with service wrapper');
    userData.push(`./svc.sh install ${config.input.runAsUser || ''}`);
    userData.push('./svc.sh start');
    userData.push(dbg('./svc.sh status || echo "[RUNNER] WARNING: svc.sh status returned non-zero"'));
  } else {
    core.info('Runner will be started without service wrapper');
    if (config.input.runAsUser) {
      userData.push(`runuser -u ${config.input.runAsUser} -- ./run.sh`);
    } else {
      userData.push('./run.sh');
    }
  }
  if (debug) {
    userData.push('echo "[RUNNER] =========================================="');
    userData.push('echo "[RUNNER] Setup script finished at $(date -u)"');
    userData.push('echo "[RUNNER] =========================================="');
  }
  return userData.filter(Boolean);
}

// Build the commands to run on the instance for JIT mode.
// JIT runners skip config.sh entirely and pass the encoded config directly to run.sh.
function buildJitRunCommands(encodedJitConfig) {
  const debug = config.input.runnerDebug;
  const dbg = (cmd) => (debug ? cmd : null);

  const preamble = [
    '#!/bin/bash',
    'LOGFILE=/tmp/runner-setup.log',
    'exec > >(tee -a "$LOGFILE") 2>&1',
    'set -e',
    dbg('echo "[RUNNER] =========================================="'),
    dbg('echo "[RUNNER] JIT Setup script started at $(date -u)"'),
    dbg('echo "[RUNNER] =========================================="'),
  ].filter(Boolean);

  const packageCommands = [];
  if (config.input.packages && config.input.packages.length > 0) {
    const pkgs = config.input.packages.join(' ');
    packageCommands.push(
      `if command -v apt-get >/dev/null; then export DEBIAN_FRONTEND=noninteractive; apt-get update -y && apt-get install -y ${pkgs};` +
        ` elif command -v dnf >/dev/null; then dnf install -y ${pkgs};` +
        ` elif command -v yum >/dev/null; then yum install -y ${pkgs}; fi`
    );
  }

  let userData;
  if (config.input.runnerHomeDir) {
    userData = [
      ...preamble,
      ...packageCommands,
      `cd "${config.input.runnerHomeDir}"`,
      'source /tmp/pre-runner-script.sh',
      'export RUNNER_ALLOW_RUNASROOT=1',
      // Remove stale runner config from the image so run.sh doesn't get confused
      'rm -f .runner .credentials .credentials_rsaparams',
    ];
  } else {
    userData = [
      ...preamble,
      ...packageCommands,
      'mkdir actions-runner && cd actions-runner',
      'source /tmp/pre-runner-script.sh',
      'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}',
      `RUNNER_VERSION=$(curl -s "https://api.github.com/repos/actions/runner/releases/latest" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/' | tr -d "v")`,
      'curl -O -L https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz',
      'tar xzf ./actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz',
      'export RUNNER_ALLOW_RUNASROOT=1',
    ];
  }

  if (config.input.runAsUser) {
    userData.push(`chown -R ${config.input.runAsUser} . 2>&1 || true`);
    userData.push(`runuser -u ${config.input.runAsUser} -- ./run.sh --jitconfig ${encodedJitConfig}`);
  } else {
    userData.push(`./run.sh --jitconfig ${encodedJitConfig}`);
  }

  return userData;
}

// Build the PowerShell run commands for a Windows runner.
function buildWindowsRunCommands(githubRegistrationToken, label, encodedJitConfig) {
  const debug = config.input.runnerDebug;
  const dbg = (cmd) => (debug ? cmd : null);
  const repoUrl = `https://github.com/${config.githubContext.owner}/${config.githubContext.repo}`;

  const lines = [
    '$ErrorActionPreference = "Stop"',
    dbg('Write-Host "[RUNNER] =========================================="'),
    dbg('Write-Host "[RUNNER] Windows setup started at $(Get-Date -Format o)"'),
    dbg('Write-Host "[RUNNER] Hostname: $env:COMPUTERNAME"'),
  ].filter(Boolean);

  if (config.input.runnerHomeDir) {
    core.info('Runner home directory is specified, so it is expected that the actions-runner software is pre-installed in the image.');
    lines.push(`Set-Location "${config.input.runnerHomeDir}"`);
    // Remove stale runner config from the image so config.cmd doesn't refuse to run
    lines.push('Remove-Item -Force .runner,.credentials,.credentials_rsaparams -ErrorAction SilentlyContinue');
  } else {
    core.info('Runner home directory is not specified, so the latest actions-runner software will be downloaded and installed.');
    lines.push('New-Item -ItemType Directory -Path C:\\actions-runner -Force | Out-Null');
    lines.push('Set-Location C:\\actions-runner');
    lines.push(dbg('Write-Host "[RUNNER] Fetching latest runner version..."'));
    lines.push('$RUNNER_VERSION = (Invoke-RestMethod -Uri "https://api.github.com/repos/actions/runner/releases/latest").tag_name.TrimStart("v")');
    lines.push(dbg('Write-Host "[RUNNER] Runner version: $RUNNER_VERSION"'));
    lines.push('Invoke-WebRequest -Uri "https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-win-x64-$RUNNER_VERSION.zip" -OutFile actions-runner.zip');
    lines.push('Add-Type -AssemblyName System.IO.Compression.FileSystem');
    lines.push('[System.IO.Compression.ZipFile]::ExtractToDirectory("$PWD\\actions-runner.zip", "$PWD")');
  }

  if (encodedJitConfig) {
    lines.push(dbg('Write-Host "[RUNNER] Starting JIT runner"'));
    // Detach run.cmd so the GCE startup-script can finish while the runner keeps running.
    lines.push(`Start-Process -FilePath ".\\run.cmd" -ArgumentList "--jitconfig","${encodedJitConfig}" -WindowStyle Hidden`);
  } else {
    lines.push(dbg(`Write-Host "[RUNNER] Configuring runner with label: ${label}"`));
    lines.push(`.\\config.cmd --unattended --url ${repoUrl} --token ${githubRegistrationToken} --labels ${label} --name gce-${label} --replace`);
    lines.push(dbg('Write-Host "[RUNNER] config.cmd completed"'));
    lines.push('Start-Process -FilePath ".\\run.cmd" -WindowStyle Hidden');
  }
  return lines.filter(Boolean);
}

// Build the metadata windows-startup-script-ps1 content (PowerShell) for Windows.
function buildWindowsStartupScript(githubRegistrationToken, label, encodedJitConfig) {
  const lines = [];
  if (config.input.preRunnerScript) {
    lines.push('# --- pre-runner script ---');
    lines.push(config.input.preRunnerScript);
    lines.push('# --- end pre-runner script ---');
  }
  lines.push(...buildWindowsRunCommands(githubRegistrationToken, label, encodedJitConfig));
  // Windows startup scripts expect CRLF line endings.
  return lines.join('\r\n') + '\r\n';
}

// Build the metadata startup-script content (bash for Linux, PowerShell for Windows).
function buildStartupScript(githubRegistrationToken, label, encodedJitConfig) {
  if (config.input.os === 'windows') {
    return buildWindowsStartupScript(githubRegistrationToken, label, encodedJitConfig);
  }

  const runCommands = encodedJitConfig
    ? buildJitRunCommands(encodedJitConfig)
    : buildRunCommands(githubRegistrationToken, label);

  const preRunner = config.input.preRunnerScript || '#!/bin/bash';

  // The startup-script writes the pre-runner script to disk, then runs the
  // main setup script in the background so cloud-init / google startup-script
  // doesn't block on the long-running ./run.sh process.
  const script = [
    '#!/bin/bash',
    'set -e',
    "cat > /tmp/pre-runner-script.sh <<'PRE_RUNNER_EOF'",
    preRunner,
    'PRE_RUNNER_EOF',
    'chmod +x /tmp/pre-runner-script.sh',
    "cat > /opt/runner-setup.sh <<'RUNNER_SETUP_EOF'",
    ...runCommands,
    'RUNNER_SETUP_EOF',
    'chmod +x /opt/runner-setup.sh',
    'nohup /opt/runner-setup.sh &',
  ];

  return script.join('\n') + '\n';
}

// Build the scheduling block for Spot VMs.
function buildScheduling(provisioningModel) {
  if (provisioningModel !== 'spot') {
    return undefined; // standard / on-demand
  }
  return {
    provisioningModel: 'SPOT',
    // Spot VMs are reclaimed by GCP; deleting on preemption avoids dangling instances.
    instanceTerminationAction: 'DELETE',
    automaticRestart: false,
    onHostMaintenance: 'TERMINATE',
  };
}

// Build the network interface, resolving subnet/network short names to self-links.
function buildNetworkInterface(zoneConfig) {
  const region = regionFromZone(zoneConfig.zone);

  const subnetwork = zoneConfig.subnet.startsWith('http') || zoneConfig.subnet.includes('/')
    ? zoneConfig.subnet
    : `projects/${config.projectId}/regions/${region}/subnetworks/${zoneConfig.subnet}`;

  const networkInterface = { subnetwork };

  // Only set 'network' when explicitly provided. When omitted, GCE infers the
  // network from the subnetwork, which avoids "Subnetwork does not belong to the
  // network" errors when the subnet lives in a non-default VPC.
  if (zoneConfig.network) {
    networkInterface.network = zoneConfig.network.startsWith('http') || zoneConfig.network.includes('/')
      ? zoneConfig.network
      : `projects/${config.projectId}/global/networks/${zoneConfig.network}`;
  }

  if (!config.input.noExternalIp) {
    // Ephemeral external IP so the runner can reach GitHub without Cloud NAT.
    networkInterface.accessConfigs = [
      {
        name: 'External NAT',
        type: 'ONE_TO_ONE_NAT',
      },
    ];
  }

  return networkInterface;
}

// Machine families that only support Hyperdisk (Persistent Disk is rejected).
const HYPERDISK_ONLY_FAMILIES = ['n4', 'n4a', 'c4', 'c4a', 'c4d', 'x4', 'm4'];

function buildBootDisk(zoneConfig) {
  const region = regionFromZone(zoneConfig.zone);
  let diskType = config.input.bootDiskType || 'pd-balanced';

  // Newer machine families (N4, N4A, C4, C4A, ...) reject pd-* disks. When such
  // a machine type is requested with a Persistent Disk type, transparently
  // switch to hyperdisk-balanced so the instance can boot. Decided per attempt,
  // since each candidate may use a different machine type.
  const family = (zoneConfig.machineType || '').split('-')[0].toLowerCase();
  if (HYPERDISK_ONLY_FAMILIES.includes(family) && diskType.startsWith('pd-')) {
    core.info(`Machine family '${family}' requires Hyperdisk; overriding boot disk type '${diskType}' with 'hyperdisk-balanced'`);
    diskType = 'hyperdisk-balanced';
  }

  const initializeParams = {
    sourceImage: zoneConfig.image,
    diskType: `projects/${config.projectId}/zones/${zoneConfig.zone}/diskTypes/${diskType}`,
  };
  if (config.input.bootDiskSize) {
    initializeParams.diskSizeGb = parseInt(config.input.bootDiskSize, 10);
  }
  // region is intentionally unused for zonal boot disks; kept for clarity.
  void region;

  return {
    boot: true,
    autoDelete: true,
    initializeParams,
  };
}

async function waitForZoneOperation(operationsClient, projectId, zone, operationName) {
  let operation = { name: operationName, status: 'RUNNING' };
  while (operation.status !== 'DONE') {
    [operation] = await operationsClient.wait({
      operation: operation.name,
      project: projectId,
      zone,
    });
  }
  // A GCE operation can finish with status DONE but still carry an error
  // (e.g. resource exhausted, quota, image architecture mismatch). Surface it
  // instead of silently proceeding to a non-existent instance.
  if (operation.error) {
    const details = (operation.error.errors || [])
      .map((e) => `${e.code}: ${e.message}`)
      .join('; ');
    throw new Error(`GCE operation failed: ${details || JSON.stringify(operation.error)}`);
  }
  return operation;
}

async function createInstanceWithParams(zoneConfig, instanceName, label, githubRegistrationToken, encodedJitConfig, provisioningModel) {
  const instancesClient = new compute.InstancesClient();
  const operationsClient = new compute.ZoneOperationsClient();

  const startupScript = buildStartupScript(githubRegistrationToken, label, encodedJitConfig);

  // Windows VMs use a different metadata key (PowerShell) than Linux.
  const metadataKey = config.input.os === 'windows' ? 'windows-startup-script-ps1' : 'startup-script';
  const metadataItems = [{ key: metadataKey, value: startupScript }];

  const instanceResource = {
    name: instanceName,
    machineType: `zones/${zoneConfig.zone}/machineTypes/${zoneConfig.machineType}`,
    disks: [buildBootDisk(zoneConfig)],
    networkInterfaces: [buildNetworkInterface(zoneConfig)],
    metadata: { items: metadataItems },
    scheduling: buildScheduling(provisioningModel),
  };

  if (zoneConfig.networkTags && zoneConfig.networkTags.length > 0) {
    instanceResource.tags = { items: zoneConfig.networkTags };
  }

  if (Object.keys(config.resourceLabels).length > 0) {
    instanceResource.labels = config.resourceLabels;
  }

  if (config.input.serviceAccountEmail) {
    instanceResource.serviceAccounts = [
      {
        email: config.input.serviceAccountEmail,
        scopes: config.input.serviceAccountScopes,
      },
    ];
  }

  const [response] = await instancesClient.insert({
    project: config.projectId,
    zone: zoneConfig.zone,
    instanceResource,
  });

  await waitForZoneOperation(operationsClient, config.projectId, zoneConfig.zone, response.latestResponse.name);

  return instanceName;
}

// List the UP zones of the given regions (used by the 'zone: any' failover mode),
// keeping the regions in the order they were given.
async function listUpZonesInRegions(regions) {
  const zonesClient = new compute.ZonesClient();
  const zonesByRegion = new Map(regions.map((r) => [r, []]));
  const iterable = zonesClient.listAsync({ project: config.projectId });
  for await (const zone of iterable) {
    const region = zone.region ? zone.region.split('/').pop() : '';
    if (zone.status === 'UP' && zonesByRegion.has(region)) {
      zonesByRegion.get(region).push(zone.name);
    }
  }
  const zones = [];
  for (const [region, regionZones] of zonesByRegion) {
    if (regionZones.length === 0) {
      core.warning(`No UP zones found in region '${region}'.`);
    }
    zones.push(...regionZones.sort());
  }
  if (zones.length === 0) {
    throw new Error(`No UP zones found in region(s) '${regions.join(', ')}'. Check the region names and permissions (compute.zones.list).`);
  }
  return zones;
}

// Expand zone configs x machine types into the ordered list of attempts. The
// machine-type preference is the outer loop (every zone is tried with the first
// type before moving to the next one); zones-config entries that pin their own
// machineType are tried once, in the first pass.
function buildCandidates(zones, machineTypes) {
  const candidates = [];
  const seen = new Set();
  for (const machineType of machineTypes) {
    for (const zoneConfig of zones) {
      const candidate = { ...zoneConfig, machineType: (zoneConfig.machineType || machineType).trim() };
      const key = [candidate.zone, candidate.machineType, candidate.image, candidate.subnet].join('|');
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function pairKey(zone, machineType) {
  return `${zone}/${machineType}`;
}

// Unique (zone, machineType) pairs of a candidate list.
function uniquePairs(candidates) {
  const pairs = new Map();
  candidates.forEach((c) => pairs.set(pairKey(c.zone, c.machineType), { zone: c.zone, machineType: c.machineType }));
  return [...pairs.values()];
}

async function mapWithConcurrency(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      await fn(queue.shift());
    }
  });
  await Promise.all(workers);
}

// gRPC status returned by machineTypes.get when the type is not offered in the zone.
const GRPC_NOT_FOUND = 5;

// Drop the zone/machine-type combinations GCE does not offer (e.g. T2A only exists
// in a few zones), so they don't burn attempts. Any other lookup error keeps the
// candidate and lets the insert decide.
async function filterOfferedCandidates(candidates) {
  const machineTypesClient = new compute.MachineTypesClient();
  const notOffered = new Set();
  await mapWithConcurrency(uniquePairs(candidates), 20, async ({ zone, machineType }) => {
    try {
      await machineTypesClient.get({ project: config.projectId, zone, machineType });
    } catch (error) {
      if (error.code === GRPC_NOT_FOUND || error.code === 404) {
        notOffered.add(pairKey(zone, machineType));
      } else {
        core.warning(`Could not check if ${machineType} is offered in ${zone} (${error.message}); trying it anyway`);
      }
    }
  });

  if (notOffered.size > 0) {
    core.info(`Skipping machine types not offered in the zone: ${[...notOffered].join(', ')}`);
  }
  const offered = candidates.filter((c) => !notOffered.has(pairKey(c.zone, c.machineType)));
  if (offered.length === 0) {
    throw new Error(`None of the machine types (${config.machineTypes.join(', ')}) is offered in the configured zones.`);
  }
  return offered;
}

// Spot obtainability for one zone/machine type from the Capacity Advisor
// (compute beta advice.capacity, Preview). Not exposed by the Node client yet.
async function getCapacityAdvice(authClient, zone, machineType) {
  const region = regionFromZone(zone);
  const response = await authClient.request({
    url: `https://compute.googleapis.com/compute/beta/projects/${config.projectId}/regions/${region}/advice/capacity`,
    method: 'POST',
    data: {
      instanceFlexibilityPolicy: { instanceSelections: { candidate: { machineTypes: [machineType] } } },
      distributionPolicy: { targetShape: 'ANY_SINGLE_ZONE', zones: [{ zone: `zones/${zone}` }] },
      size: 1,
      instanceProperties: { scheduling: { provisioningModel: 'SPOT' } },
    },
  });
  const recommendation = (response.data.recommendations || [])[0];
  if (!recommendation || !recommendation.scores) {
    return { obtainability: 0, uptimeSeconds: 0 };
  }
  return {
    obtainability: recommendation.scores.obtainability || 0,
    uptimeSeconds: parseInt(recommendation.scores.estimatedUptime || '0', 10) || 0,
  };
}

// Reorder the Spot attempts by Capacity Advisor scores: obtainability in 0.1
// buckets (so near-equal scores keep the configured preference), then estimated
// uptime, then the configured order. Fails open: on any error the configured
// order is kept, since the API is Preview and only a hint.
async function rankByCapacityAdvisor(candidates) {
  let authClient;
  try {
    authClient = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
  } catch (error) {
    core.warning(`Capacity Advisor unavailable (${error.message}); keeping the configured order`);
    return candidates;
  }

  const scores = new Map();
  const failures = [];
  await mapWithConcurrency(uniquePairs(candidates), 8, async ({ zone, machineType }) => {
    try {
      scores.set(pairKey(zone, machineType), await getCapacityAdvice(authClient, zone, machineType));
    } catch (error) {
      failures.push(`${pairKey(zone, machineType)}: ${error.message}`);
    }
  });

  if (scores.size === 0) {
    core.warning(`Capacity Advisor unavailable (${failures[0]}); keeping the configured order`);
    return candidates;
  }
  if (failures.length > 0) {
    core.warning(`Capacity Advisor failed for ${failures.length} combination(s), trying them last: ${failures.join('; ')}`);
  }

  const ranked = candidates.map((candidate, index) => {
    const score = scores.get(pairKey(candidate.zone, candidate.machineType));
    return {
      candidate,
      index,
      score,
      bucket: score ? Math.floor(score.obtainability * 10 + 1e-9) : -1,
      uptime: score ? score.uptimeSeconds : -1,
    };
  });
  ranked.sort((a, b) => b.bucket - a.bucket || b.uptime - a.uptime || a.index - b.index);

  core.info('Capacity Advisor (Spot) ranking:');
  ranked.forEach(({ candidate, score }, i) => {
    const detail = score ? `obtainability=${score.obtainability}, estimatedUptime=${score.uptimeSeconds}s` : 'no score';
    core.info(`  ${i + 1}. ${candidate.zone} ${candidate.machineType}: ${detail}`);
  });
  return ranked.map((r) => r.candidate);
}

// GCE errors meaning "no capacity right now" (worth retrying later), as opposed
// to configuration errors that would fail the same way on every retry.
const CAPACITY_ERROR_PATTERN =
  /ZONE_RESOURCE_POOL_EXHAUSTED|RESOURCE_POOL_EXHAUSTED|STOCKOUT|does not have enough resources|RESOURCE_EXHAUSTED|QUOTA_EXCEEDED|Quota .*exceeded|UNAVAILABLE/i;

function isCapacityError(error) {
  return CAPACITY_ERROR_PATTERN.test((error && error.message) || '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// GitHub registration tokens expire after one hour; refresh well before that.
const REGISTRATION_TOKEN_MAX_AGE_MS = 45 * 60 * 1000;

async function startInstance(label, githubRegistrationToken, encodedJitConfig, options = {}) {
  // Resolve 'zone: any' into a concrete list of zones to try (failover).
  if (config.anyZone) {
    const zones = await listUpZonesInRegions(config.anyZoneRegions);
    config.zones = zones.map((z) => ({ ...config.anyZoneTemplate, zone: z }));
    core.info(`zone=any resolved to ${zones.length} zone(s) in ${config.anyZoneRegions.join(', ')}: ${zones.join(', ')}`);
  }

  const candidates = await filterOfferedCandidates(buildCandidates(config.zones, config.machineTypes));

  // Provisioning models to try, in order. The preferred one is attempted across
  // ALL candidates first; only if it has no capacity anywhere do we fall back to the other.
  const other = config.provisioningModel === 'spot' ? 'standard' : 'spot';
  const models = config.provisioningFallback ? [config.provisioningModel, other] : [config.provisioningModel];

  core.info(
    `Attempting to start GCE instance across ${candidates.length} zone/machine-type combination(s); ` +
      `machine types: ${config.machineTypes.join(' -> ')}; provisioning model preference: ${models.join(' -> ')}`
  );

  const instanceName = config.generateInstanceName(label);
  const retryMinutes = config.input.capacityRetryMinutes;
  const retryIntervalMs = config.input.capacityRetryIntervalSeconds * 1000;
  const retryDeadline = Date.now() + retryMinutes * 60 * 1000;
  let registrationToken = githubRegistrationToken;
  let registrationTokenIssuedAt = Date.now();
  let errors = [];

  for (let round = 1; ; round++) {
    errors = [];
    let capacityErrors = 0;

    for (const model of models) {
      const ordered = model === 'spot' && config.input.capacityAdvisor ? await rankByCapacityAdvisor(candidates) : candidates;
      core.info(`=== Trying provisioning model: ${model}${round > 1 ? ` (round ${round})` : ''} ===`);

      for (let i = 0; i < ordered.length; i++) {
        const candidate = ordered[i];
        core.info(
          `[${model}] ${i + 1}/${ordered.length} — zone: ${candidate.zone}, machine type: ${candidate.machineType}, ` +
            `image: ${candidate.image}, subnet: ${candidate.subnet}`
        );

        try {
          await createInstanceWithParams(candidate, instanceName, label, registrationToken, encodedJitConfig, model);
          core.info(`Successfully started GCE instance ${instanceName} (${candidate.machineType}, ${model}) in zone ${candidate.zone}`);
          return { instanceId: instanceName, zone: candidate.zone, machineType: candidate.machineType, provisioningModel: model };
        } catch (error) {
          const errorMessage = `[${model}] ${candidate.zone}/${candidate.machineType} failed: ${error.message}`;
          core.warning(errorMessage);
          errors.push(errorMessage);
          if (isCapacityError(error)) {
            capacityErrors++;
          }
        }
      }
      core.warning(`No capacity for provisioning model '${model}' in any zone/machine type.`);
    }

    if (retryMinutes <= 0) {
      break;
    }
    if (capacityErrors === 0) {
      core.warning('No attempt failed for lack of capacity; not retrying (fix the errors above).');
      break;
    }
    if (Date.now() + retryIntervalMs >= retryDeadline) {
      core.warning(`capacity-retry-minutes (${retryMinutes}) exhausted after ${round} round(s).`);
      break;
    }

    core.info(
      `No capacity in round ${round}; retrying in ${config.input.capacityRetryIntervalSeconds}s ` +
        `(until ${new Date(retryDeadline).toISOString()})`
    );
    await sleep(retryIntervalMs);

    if (registrationToken && options.refreshRegistrationToken && Date.now() - registrationTokenIssuedAt > REGISTRATION_TOKEN_MAX_AGE_MS) {
      registrationToken = await options.refreshRegistrationToken();
      registrationTokenIssuedAt = Date.now();
    }
  }

  core.error('All provisioning models, zones and machine types failed');
  throw new Error(`Failed to start GCE instance. Errors: ${errors.join('; ')}`);
}

async function terminateInstance() {
  const instancesClient = new compute.InstancesClient();
  const operationsClient = new compute.ZoneOperationsClient();

  try {
    const [response] = await instancesClient.delete({
      project: config.projectId,
      zone: config.input.instanceZone,
      instance: config.input.instanceId,
    });
    await waitForZoneOperation(operationsClient, config.projectId, config.input.instanceZone, response.latestResponse.name);
    core.info(`GCE instance ${config.input.instanceId} is terminated`);
    return;
  } catch (error) {
    core.error(`GCE instance ${config.input.instanceId} termination error`);
    throw error;
  }
}

async function waitForInstanceRunning(instanceName, zone) {
  const instancesClient = new compute.InstancesClient();

  core.info(`Checking for instance ${instanceName} in zone ${zone} to be up and running`);

  const maxWaitMs = 300 * 1000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const [instance] = await instancesClient.get({
        project: config.projectId,
        zone,
        instance: instanceName,
      });
      if (instance.status === 'RUNNING') {
        core.info(`GCE instance ${instanceName} is up and running`);
        return;
      }
      core.info(`Instance ${instanceName} status: ${instance.status}`);
    } catch (error) {
      core.warning(`Error checking instance ${instanceName} status: ${error.message}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  throw new Error(`GCE instance ${instanceName} did not reach RUNNING state within the timeout`);
}

/**
 * Fetches the serial port output from a GCE instance.
 * This captures boot logs, kernel messages, and startup-script output.
 */
async function getInstanceConsoleOutput(instanceName, zone) {
  const instancesClient = new compute.InstancesClient();
  try {
    if (config.input.runnerDebug) {
      core.info(`Fetching serial console output for instance ${instanceName}...`);
    }
    const [result] = await instancesClient.getSerialPortOutput({
      project: config.projectId,
      zone,
      instance: instanceName,
      port: 1,
    });
    if (result.contents) {
      if (config.input.runnerDebug) {
        core.info(`Serial console output received: ${result.contents.length} bytes`);
      }
      return result.contents;
    }
    if (config.input.runnerDebug) {
      core.info('Serial console output not yet available (empty response - this is normal during early boot)');
    }
    return null;
  } catch (error) {
    core.warning(`Failed to fetch serial console output for ${instanceName}: ${error.message}`);
    return null;
  }
}

module.exports = {
  startInstance,
  terminateInstance,
  waitForInstanceRunning,
  getInstanceConsoleOutput,
  // Exposed for testing only
  _buildStartupScriptForTest: buildStartupScript,
  _buildCandidatesForTest: buildCandidates,
  _isCapacityErrorForTest: isCapacityError,
};
