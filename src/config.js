const core = require('@actions/core');
const github = require('@actions/github');

class Config {
  constructor() {
    this.input = {
      image: core.getInput('image'),
      instanceId: core.getInput('instance-id'),
      instanceZone: core.getInput('instance-zone'),
      machineType: core.getInput('machine-type'),
      githubToken: core.getInput('github-token'),
      serviceAccountEmail: core.getInput('service-account-email'),
      serviceAccountScopes: JSON.parse(core.getInput('service-account-scopes') || '["https://www.googleapis.com/auth/cloud-platform"]'),
      label: core.getInput('label'),
      spot: core.getInput('spot') === 'true',
      mode: core.getInput('mode'),
      preRunnerScript: core.getInput('pre-runner-script'),
      runnerHomeDir: core.getInput('runner-home-dir'),
      zone: core.getInput('zone'),
      subnet: core.getInput('subnet'),
      network: core.getInput('network'),
      networkTags: JSON.parse(core.getInput('network-tags') || '[]'),
      noExternalIp: core.getInput('no-external-ip') === 'true',
      startupQuietPeriodSeconds: core.getInput('startup-quiet-period-seconds'),
      startupRetryIntervalSeconds: core.getInput('startup-retry-interval-seconds'),
      startupTimeoutMinutes: core.getInput('startup-timeout-minutes'),
      runAsService: core.getInput('run-runner-as-service') === 'true',
      runAsUser: core.getInput('run-runner-as-user'),
      bootDiskSize: core.getInput('boot-disk-size'),
      bootDiskType: core.getInput('boot-disk-type'),
      zonesConfig: core.getInput('zones-config'),
      packages: JSON.parse(core.getInput('packages') || '[]'),
      useJit: core.getInput('use-jit') === 'true',
      runnerGroupId: parseInt(core.getInput('runner-group-id') || '1', 10),
      runnerDebug: core.getInput('runner-debug') === 'true',
    };

    // Resolve the Google Cloud project id from the input or the environment
    // variables exported by google-github-actions/auth (and the gcloud SDK).
    this.projectId =
      core.getInput('project-id') ||
      process.env.GCP_PROJECT_ID ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GCLOUD_PROJECT ||
      process.env.CLOUDSDK_CORE_PROJECT;

    // Resource labels (GCP equivalent of AWS tags). Stored as a plain object map.
    const labels = JSON.parse(core.getInput('resource-labels') || '[]');
    this.resourceLabels = {};
    if (labels.length > 0) {
      labels.forEach((tag) => {
        this.resourceLabels[tag.Key] = tag.Value;
      });
    }

    // the values of github.context.repo.owner and github.context.repo.repo are taken from
    // the environment variable GITHUB_REPOSITORY specified in "owner/repo" format and
    // provided by the GitHub Action on the runtime
    this.githubContext = {
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
    };

    //
    // validate input
    //

    if (!this.input.mode) {
      throw new Error(`The 'mode' input is not specified`);
    }

    if (!this.input.githubToken) {
      throw new Error(`The 'github-token' input is not specified`);
    }

    // Initialize zones as an empty array
    this.zones = [];

    if (this.input.mode === 'start') {
      if (!this.projectId) {
        throw new Error(
          `No Google Cloud project id found. Provide the 'project-id' input or set GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT.`
        );
      }

      // Parse zones config if provided
      if (this.input.zonesConfig) {
        try {
          this.zones = JSON.parse(this.input.zonesConfig);

          if (!Array.isArray(this.zones)) {
            throw new Error('zones-config must be a JSON array');
          }

          this.zones.forEach((z, index) => {
            if (!z.image) {
              throw new Error(`Missing image in zones-config at index ${index}`);
            }
            if (!z.zone) {
              throw new Error(`Missing zone in zones-config at index ${index}`);
            }
            if (!z.subnet) {
              throw new Error(`Missing subnet in zones-config at index ${index}`);
            }
            // Optional fields with defaults
            if (!z.network) {
              z.network = this.input.network || 'default';
            }
            if (!z.networkTags) {
              z.networkTags = this.input.networkTags;
            }
          });
        } catch (error) {
          throw new Error(`Failed to parse zones-config: ${error.message}`);
        }
      }

      // Check for required machine type regardless of config method
      if (!this.input.machineType) {
        throw new Error(`The 'machine-type' input is required for the 'start' mode.`);
      }

      // If no zones config provided, build one from the individual parameters
      if (this.zones.length === 0) {
        if (!this.input.image || !this.input.zone || !this.input.subnet) {
          throw new Error(
            `Either provide 'zones-config' or all of the following: 'image', 'zone', 'subnet'`
          );
        }

        this.zones.push({
          image: this.input.image,
          zone: this.input.zone,
          subnet: this.input.subnet,
          network: this.input.network || 'default',
          networkTags: this.input.networkTags,
        });

        core.info('Using individual parameters as a single zone configuration');
      }

      if (this.input.useJit && this.input.runAsService) {
        throw new Error(
          "The 'use-jit' and 'run-runner-as-service' inputs are incompatible. " +
            'JIT runners are single-use and cannot run as a service.'
        );
      }
    } else if (this.input.mode === 'stop') {
      if (!this.input.instanceId) {
        throw new Error(`The 'instance-id' input is required for the 'stop' mode.`);
      }
      if (!this.input.instanceZone) {
        throw new Error(`The 'instance-zone' input is required for the 'stop' mode.`);
      }
      if (!this.projectId) {
        throw new Error(
          `No Google Cloud project id found. Provide the 'project-id' input or set GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT.`
        );
      }
      if (!this.input.label) {
        core.warning(`The 'label' input is not specified for the 'stop' mode. The runner will be removed by the 'instance-id' input.`);
      }
    } else {
      throw new Error('Wrong mode. Allowed values: start, stop.');
    }
  }

  generateUniqueLabel() {
    return Math.random().toString(36).substr(2, 5);
  }

  // Compute Engine instance names must be 1-63 chars, lowercase letters,
  // numbers and dashes, and start with a letter.
  generateInstanceName(label) {
    return `gce-runner-${label}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').substring(0, 63);
  }
}

try {
  module.exports = new Config();
} catch (error) {
  core.error(error);
  core.setFailed(error.message);
}

module.exports.Config = Config;
