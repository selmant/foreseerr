# foreseerr-chart

Helm chart for deploying [Foreseerr](https://github.com/selmant/foreseerr) on Kubernetes.

Foreseerr is a Seerr fork with SuggestArr-inspired features. Config mounts remain Seerr-compatible at `/app/config`.

## Install

```bash
helm install foreseerr oci://ghcr.io/selmant/foreseerr/foreseerr-chart
```

See `values.yaml` in this directory and the project README for more.

## Update Notes

### From `seerr-chart`

This chart was renamed from `seerr-chart`. Install path and helper template names use `foreseerr.*`. The container still mounts config at `/app/config`.
