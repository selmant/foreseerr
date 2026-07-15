# foreseer-chart

Helm chart for deploying [Foreseer](https://github.com/selmant/seerr) on Kubernetes.

Foreseer is a Seerr fork with SuggestArr-inspired features. Config mounts remain Seerr-compatible at `/app/config`.

## Install

```bash
helm install foreseer oci://ghcr.io/selmant/seerr/foreseer-chart
```

See `values.yaml` in this directory and the project README for more.

## Update Notes

### From `seerr-chart`

This chart was renamed from `seerr-chart`. Install path and helper template names use `foreseer.*`. The container still mounts config at `/app/config`.
