# On-demand self-hosted GCP Compute Engine runner for GitHub Actions

Start your Google Compute Engine [self-hosted runner](https://docs.github.com/en/free-pro-team@latest/actions/hosting-your-own-runners) right before you need it.
Run the job on it.
Finally, stop it when you finish.
And all this automatically as a part of your GitHub Actions workflow.

This action is a GCP port of [machulav/ec2-github-runner](https://github.com/machulav/ec2-github-runner). It keeps the same `start` / `stop` flow and feature set, but creates **Compute Engine VM instances** instead of AWS EC2 instances.

**Table of Contents**

- [Use cases](#use-cases)
- [How it works](#how-it-works)
- [Usage](#usage)
  - [1. Authenticate to Google Cloud](#1-authenticate-to-google-cloud)
  - [2. Prepare a GitHub personal access token](#2-prepare-a-github-personal-access-token)
  - [3. Prepare a VM image](#3-prepare-a-vm-image)
  - [4. Prepare network and firewall](#4-prepare-network-and-firewall)
  - [5. Configure the workflow](#5-configure-the-workflow)
- [Inputs](#inputs)
- [Outputs](#outputs)
- [Example](#example)
- [Advanced: JIT runners](#advanced-jit-runners)
- [Advanced: Multi-zone failover](#advanced-multi-zone-failover)
- [Advanced: Spot VMs](#advanced-spot-vms)
- [Advanced: Debug mode](#advanced-debug-mode)
- [Mapping from the AWS action](#mapping-from-the-aws-action)
- [License](#license)

## Use cases

- **Access private resources in your VPC** — launch the runner in any subnetwork, including private ones, to reach internal databases and services.
- **Customize hardware** — pick any Compute Engine machine type (more CPU, more RAM, GPUs, etc.) instead of the fixed GitHub-hosted configuration.
- **Save costs** — pay Google Cloud only for the time the runner exists; combine with [Spot VMs](#advanced-spot-vms) for the cheapest option.

## How it works

- **start mode** — the action requests a runner registration token (or a JIT config) from GitHub, then creates a Compute Engine instance whose `startup-script` downloads and configures the GitHub Actions runner. It waits until the runner registers and becomes `online`.
- **stop mode** — the action deletes the Compute Engine instance and removes the runner from GitHub.

## Usage

### 1. Authenticate to Google Cloud

This action uses [Application Default Credentials (ADC)](https://cloud.google.com/docs/authentication/application-default-credentials), so **both** authentication methods supported by [`google-github-actions/auth`](https://github.com/google-github-actions/auth) work out of the box:

**Option A — Workload Identity Federation (recommended, no long-lived keys):**

```yml
      - name: Authenticate to Google Cloud
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: projects/123456789/locations/global/workloadIdentityPools/my-pool/providers/my-provider
          service_account: github-runner-launcher@my-project.iam.gserviceaccount.com
```

**Option B — Service account JSON key:**

```yml
      - name: Authenticate to Google Cloud
        uses: google-github-actions/auth@v2
        with:
          credentials_json: ${{ secrets.GCP_SA_KEY }}
```

The service account used to launch instances needs (at minimum) these IAM permissions on the project:

```
compute.instances.create
compute.instances.delete
compute.instances.get
compute.instances.getSerialPortOutput   # only if you use runner-debug
compute.disks.create
compute.subnetworks.use
compute.subnetworks.useExternalIp       # only if instances get an external IP
compute.instances.setMetadata
compute.zoneOperations.get
```

The predefined role **`roles/compute.instanceAdmin.v1`** covers all of these. If you attach a service account to the runner (`service-account-email`), the launcher also needs **`roles/iam.serviceAccountUser`** on that service account.

> `google-github-actions/auth` exports the project id via the `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT` environment variables, so the `project-id` input is usually optional. Set it explicitly if you authenticate some other way.

### 2. Prepare a GitHub personal access token

Create a GitHub personal access token with the `repo` scope and add it to your repository secrets. The action uses it to register and remove self-hosted runners.

### 3. Prepare a VM image

You can use a stock public image (e.g. `projects/debian-cloud/global/images/family/debian-12`) and install everything via `packages` / `pre-runner-script`, or bake a [custom image](https://cloud.google.com/compute/docs/images/create-custom) with `docker`, `git` and your tools pre-installed for faster startup.

For a Debian/Ubuntu base, the minimal dependencies are:

```shell
sudo apt-get update -y && sudo apt-get install -y docker.io git
sudo systemctl enable docker
```

> If your custom image was created from a machine that previously ran a runner, delete the stale `.runner`, `.credentials`, and `.credentials_rsaparams` files before creating the image. The action also removes them automatically.

### 4. Prepare network and firewall

1. Use an existing VPC network and subnetwork, or create new ones.
2. The runner only needs **outbound** TCP/443 to pull jobs from GitHub — no inbound rules are required. In GCP, firewall rules are matched against **network tags**, so apply tags via the `network-tags` input and create matching firewall rules.
3. If you set `no-external-ip: true`, configure [Cloud NAT](https://cloud.google.com/nat/docs/overview) so the private instance can still reach GitHub.

### 5. Configure the workflow

Create three jobs: `start-runner`, your actual job (`runs-on` the runner label), and `stop-runner` (with `if: ${{ always() }}` so the VM is always cleaned up). See the [example](#example) below.

## Inputs

| Name | Required | Description |
| --- | --- | --- |
| `mode` | Always | `start` to start a new runner, `stop` to stop the previously created one. |
| `github-token` | Always | GitHub Personal Access Token with the `repo` scope. |
| `project-id` | Optional | Google Cloud project id. Falls back to `GCP_PROJECT_ID` / `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT`. |
| `image` | `start` (unless `zones-config`) | Source image for the boot disk, e.g. `projects/debian-cloud/global/images/family/debian-12`. |
| `machine-type` | `start` | Compute Engine machine type, e.g. `e2-small`, `n2-standard-4`. |
| `zone` | `start` (unless `zones-config`) | Compute Engine zone, e.g. `us-central1-a`. |
| `subnet` | `start` (unless `zones-config`) | Subnetwork name (or self-link) in the region of the chosen zone. |
| `network` | Optional | VPC network name. Default: `default`. |
| `network-tags` | Optional | JSON array of network tags for firewall matching. Example: `'["github-runner"]'`. |
| `no-external-ip` | Optional | `true` to create the instance without an external IP (requires Cloud NAT). Default: `false`. |
| `label` | `stop` | Unique runner label provided by the `start` output. |
| `instance-id` | `stop` | Compute Engine instance name provided by the `start` output. |
| `instance-zone` | `stop` | Zone of the instance to delete (the `zone` output of `start`). |
| `service-account-email` | Optional | Service account to attach to the runner so it can call GCP APIs. |
| `service-account-scopes` | Optional | JSON array of OAuth scopes. Default: `'["https://www.googleapis.com/auth/cloud-platform"]'`. |
| `resource-labels` | Optional | Stringified array of `{"Key","Value"}` objects applied as instance labels. |
| `runner-home-dir` | Optional | Directory with pre-installed actions-runner software (skips download). |
| `pre-runner-script` | Optional | Bash commands to run before the runner starts. |
| `spot` | Optional | `true` to create a Spot VM. Default: `false`. |
| `zones-config` | Optional | JSON array of `{image, zone, subnet, network?, networkTags?}` for multi-zone failover. |
| `startup-quiet-period-seconds` | Optional | Quiet period before checking registration. Default: `30`. |
| `startup-retry-interval-seconds` | Optional | Retry interval for registration checks. Default: `10`. |
| `startup-timeout-minutes` | Optional | Registration timeout. Default: `5`. |
| `run-runner-as-service` | Optional | Start the runner via `svc.sh` instead of `run.sh`. Default: `false`. |
| `run-runner-as-user` | Optional | User to run the runner as. |
| `boot-disk-size` | Optional | Boot disk size in GB. Uses the image default if omitted. |
| `boot-disk-type` | Optional | Boot disk type (`pd-standard`, `pd-balanced`, `pd-ssd`). Default: `pd-balanced`. |
| `packages` | Optional | JSON array of packages to install at boot. Example: `'["git","docker.io"]'`. |
| `use-jit` | Optional | Use single-use JIT runners. Default: `false`. Incompatible with `run-runner-as-service`. |
| `runner-group-id` | Optional | Runner group id for JIT runners. Default: `1`. |
| `runner-debug` | Optional | Verbose logging + serial console polling. Default: `false`. |

## Outputs

| Name | Description |
| --- | --- |
| `label` | Unique label assigned to the runner. Use it as `runs-on` and to remove the runner. |
| `instance-id` | Compute Engine instance name. Pass it to `stop` mode to delete the VM. |
| `zone` | Zone where the instance was created. Pass it to `stop` mode as `instance-zone`. |

## Example

```yml
name: do-the-job
on: pull_request
jobs:
  start-runner:
    name: Start self-hosted GCE runner
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write   # required for Workload Identity Federation
    outputs:
      label: ${{ steps.start-gce-runner.outputs.label }}
      instance-id: ${{ steps.start-gce-runner.outputs.instance-id }}
      zone: ${{ steps.start-gce-runner.outputs.zone }}
    steps:
      - name: Authenticate to Google Cloud
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.GCP_WIF_PROVIDER }}
          service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}
      - name: Start GCE runner
        id: start-gce-runner
        uses: your-org/gce-github-runner@v1
        with:
          mode: start
          github-token: ${{ secrets.GH_PERSONAL_ACCESS_TOKEN }}
          image: projects/debian-cloud/global/images/family/debian-12
          machine-type: e2-small
          zone: us-central1-a
          subnet: default
          network-tags: '["github-runner"]'
          packages: '["git", "docker.io"]'
  do-the-job:
    name: Do the job on the runner
    needs: start-runner
    runs-on: ${{ needs.start-runner.outputs.label }}
    steps:
      - name: Hello World
        run: echo 'Hello World!'
  stop-runner:
    name: Stop self-hosted GCE runner
    needs:
      - start-runner
      - do-the-job
    runs-on: ubuntu-latest
    if: ${{ always() }}
    permissions:
      contents: read
      id-token: write
    steps:
      - name: Authenticate to Google Cloud
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.GCP_WIF_PROVIDER }}
          service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}
      - name: Stop GCE runner
        uses: your-org/gce-github-runner@v1
        with:
          mode: stop
          github-token: ${{ secrets.GH_PERSONAL_ACCESS_TOKEN }}
          label: ${{ needs.start-runner.outputs.label }}
          instance-id: ${{ needs.start-runner.outputs.instance-id }}
          instance-zone: ${{ needs.start-runner.outputs.zone }}
```

## Advanced: JIT runners

JIT (Just-In-Time) runners use GitHub's `generate-jitconfig` API to create single-use runners that auto-deregister after one job. Set `use-jit: true`. The encoded config is passed directly to `./run.sh --jitconfig`, so `stop` mode only deletes the VM (no GitHub runner removal needed).

> JIT mode is incompatible with `run-runner-as-service: true`.

## Advanced: Multi-zone failover

`zones-config` lets you list multiple zone configurations. The action tries each in sequence until an instance launches — useful for capacity or Spot availability issues.

```yml
      - name: Start GCE runner
        uses: your-org/gce-github-runner@v1
        with:
          mode: start
          github-token: ${{ secrets.GH_PERSONAL_ACCESS_TOKEN }}
          machine-type: e2-small
          spot: true
          zones-config: >
            [
              {"image": "projects/debian-cloud/global/images/family/debian-12", "zone": "us-central1-a", "subnet": "default"},
              {"image": "projects/debian-cloud/global/images/family/debian-12", "zone": "us-east1-b", "subnet": "default"}
            ]
```

## Advanced: Spot VMs

Set `spot: true` to launch a [Spot VM](https://cloud.google.com/compute/docs/instances/spot) — significantly cheaper, but can be reclaimed by GCP at any time. The instance is configured to be deleted on preemption to avoid dangling resources. Combine with multi-zone failover for resilience.

## Advanced: Debug mode

Set `runner-debug: true` to inject detailed echo statements into the startup script and poll the **serial port output** during registration, streaming it to the Actions log. Requires the `compute.instances.getSerialPortOutput` permission.

> For full logs, the startup script also writes to `/tmp/runner-setup.log` on the instance.

## Mapping from the AWS action

| AWS (`ec2-github-runner`) | GCP (`gce-github-runner`) |
| --- | --- |
| `ec2-image-id` (AMI) | `image` (source image / image family) |
| `ec2-instance-type` | `machine-type` |
| region + `subnet-id` (AZ) | `zone` |
| `subnet-id` | `subnet` |
| `security-group-id` | `network-tags` (+ firewall rules) |
| `iam-role-name` | `service-account-email` |
| `aws-resource-tags` | `resource-labels` |
| `market-type: spot` | `spot: true` |
| `block-device-mappings` / `ec2-volume-*` | `boot-disk-size` / `boot-disk-type` |
| `availability-zones-config` | `zones-config` |
| `ec2-instance-id` (output) | `instance-id` (instance name) |
| `region` (output) | `zone` (output) |
| AWS credentials env vars | Application Default Credentials (`google-github-actions/auth`) |

## License

This code is made available under the [MIT license](LICENSE).
