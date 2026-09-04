# foreseerr-chart

Helm chart for deploying [Foreseerr](https://github.com/selmant/foreseerr) on Kubernetes.

Foreseerr is a Seerr fork with Discover sources (Trakt, AniList, Simkl,
MDBList), a TMDB mapping layer, Library, Calendar, and Servarr interventions.
Config mounts remain Seerr-compatible at `/app/config`. The current app
version for this chart is `v0.7.2`.

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
