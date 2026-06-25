# Changelog

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
