# Changelog

## v0.5.0

- `machine-type` accepts a comma-separated preference list (e.g.
  `n4a-standard-4,c4a-standard-4`); `zones-config` entries accept `machineType`.
  Boot disk type (Hyperdisk vs PD) is chosen per attempt.
- Zone/machine-type combinations not offered by GCE are skipped before trying.
- `region` accepts a comma-separated list with `zone: any` (multi-region failover).
- `capacity-retry-minutes` / `capacity-retry-interval-seconds`: retry all
  combinations on stockout/quota errors; refreshes the registration token.
- `capacity-advisor`: rank Spot attempts by Capacity Advisor (Preview) scores.
- New outputs: `machine-type`, `provisioning-model`.

## v1.0.0

Initial release. GCP Compute Engine port of the
[machulav/ec2-github-runner](https://github.com/machulav/ec2-github-runner) action.

- `start` / `stop` modes to create and delete an on-demand self-hosted runner on
  Google Compute Engine.
- Authentication via Application Default Credentials — works with both
  [google-github-actions/auth](https://github.com/google-github-actions/auth)
  Workload Identity Federation and service account JSON keys.
- Feature parity with the AWS action:
  - JIT (Just-In-Time) runners.
  - Spot VMs.
  - Multi-zone failover (`zones-config`).
  - Serial console debug polling (`runner-debug`).
  - `packages`, `pre-runner-script`, custom boot disk, service account,
    network tags, resource labels, run-as-service / run-as-user.
