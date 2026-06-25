const compute = require('@google-cloud/compute');

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

// Build the metadata startup-script content (a plain bash script for GCE).
function buildStartupScript(githubRegistrationToken, label, encodedJitConfig) {
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
function buildScheduling() {
  if (!config.input.spot) {
    return undefined;
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
  // switch to hyperdisk-balanced so the instance can boot.
  const family = (config.input.machineType || '').split('-')[0].toLowerCase();
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

async function createInstanceWithParams(zoneConfig, instanceName, label, githubRegistrationToken, encodedJitConfig) {
  const instancesClient = new compute.InstancesClient();
  const operationsClient = new compute.ZoneOperationsClient();

  const startupScript = buildStartupScript(githubRegistrationToken, label, encodedJitConfig);

  const metadataItems = [{ key: 'startup-script', value: startupScript }];

  const instanceResource = {
    name: instanceName,
    machineType: `zones/${zoneConfig.zone}/machineTypes/${config.input.machineType}`,
    disks: [buildBootDisk(zoneConfig)],
    networkInterfaces: [buildNetworkInterface(zoneConfig)],
    metadata: { items: metadataItems },
    scheduling: buildScheduling(),
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

async function startInstance(label, githubRegistrationToken, encodedJitConfig) {
  core.info(`Attempting to start GCE instance using ${config.zones.length} zone configuration(s)`);

  const instanceName = config.generateInstanceName(label);
  const errors = [];

  for (let i = 0; i < config.zones.length; i++) {
    const zoneConfig = config.zones[i];
    core.info(`Trying zone configuration ${i + 1}/${config.zones.length}`);
    core.info(`Using image: ${zoneConfig.image}, zone: ${zoneConfig.zone}, subnet: ${zoneConfig.subnet}`);

    try {
      await createInstanceWithParams(zoneConfig, instanceName, label, githubRegistrationToken, encodedJitConfig);
      core.info(`Successfully started GCE instance ${instanceName} using zone configuration ${i + 1} in zone ${zoneConfig.zone}`);
      return { instanceId: instanceName, zone: zoneConfig.zone };
    } catch (error) {
      const errorMessage = `Failed to start GCE instance with configuration ${i + 1} in zone ${zoneConfig.zone}: ${error.message}`;
      core.warning(errorMessage);
      errors.push(errorMessage);
      continue;
    }
  }

  core.error('All zone configurations failed');
  throw new Error(`Failed to start GCE instance in any zone. Errors: ${errors.join('; ')}`);
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
};
