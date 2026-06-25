const gcp = require('./gcp');
const gh = require('./gh');
const config = require('./config');
const core = require('@actions/core');

function setOutput(label, instanceId, zone) {
  core.setOutput('label', label);
  core.setOutput('instance-id', instanceId);
  core.setOutput('zone', zone);
}

async function start() {
  const label = config.input.label ? config.input.label : config.generateUniqueLabel();

  let githubRegistrationToken = null;
  let encodedJitConfig = null;

  if (config.input.useJit) {
    const jitConfig = await gh.getJitRunnerConfig(label);
    encodedJitConfig = jitConfig.encodedJitConfig;
    core.info(`JIT runner created with runner ID: ${jitConfig.runnerId}`);
  } else {
    githubRegistrationToken = await gh.getRegistrationToken();
  }

  const result = await gcp.startInstance(label, githubRegistrationToken, encodedJitConfig);
  const instanceId = result.instanceId;
  const zone = result.zone;

  // Set outputs
  setOutput(label, instanceId, zone);

  // Wait for the instance to be running
  await gcp.waitForInstanceRunning(instanceId, zone);

  let pollCallback = null;

  if (config.input.runnerDebug) {
    // Track how much console output we've already printed to avoid duplicates
    let lastOutputLength = 0;

    // Poll callback: fetch serial console output and log any new content
    pollCallback = async () => {
      const output = await gcp.getInstanceConsoleOutput(instanceId, zone);
      if (output && output.length > lastOutputLength) {
        const newOutput = output.substring(lastOutputLength);
        core.info(`--- GCE Serial Console Output ---\n${newOutput}--- End Console Output ---`);
        lastOutputLength = output.length;
      }
    };
  }

  await gh.waitForRunnerRegistered(label, pollCallback);
}

async function stop() {
  await gcp.terminateInstance();

  if (config.input.useJit) {
    core.info('JIT runner auto-deregisters after job completion. Skipping runner removal.');
  } else {
    await gh.removeRunner();
  }
}

(async function () {
  try {
    config.input.mode === 'start' ? await start() : await stop();
  } catch (error) {
    core.error(error);
    core.setFailed(error.message);
  }
})();
