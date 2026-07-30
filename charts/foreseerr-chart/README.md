# foreseerr-chart

Helm chart for deploying [Foreseerr](https://github.com/selmant/foreseerr) on Kubernetes.

Foreseerr is a Seerr fork with SuggestArr-inspired features. Config mounts remain Seerr-compatible at `/app/config`.

## Installation

```bash
helm install foreseerr oci://ghcr.io/selmant/foreseerr/foreseerr-chart
```

## Configuration

See [`values.yaml`](./values.yaml) for all options. The chart supports custom
`dnsPolicy` and `dnsConfig` settings, pod user namespaces through `hostUsers`,
and scheduling through `priorityClassName`.

## Update Notes

### From `seerr-chart`

This chart was renamed from `seerr-chart`. Helper templates use `foreseerr.*`. Config still mounts at `/app/config`.
