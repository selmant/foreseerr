# foreseerr-chart

Helm chart for deploying [Foreseerr](https://github.com/selmant/foreseerr) on Kubernetes.

Foreseerr is a Seerr fork with Discover sources (Trakt, AniList, Simkl,
MDBList), a TMDB mapping layer, Library, Calendar, and Servarr interventions.
Config mounts remain Seerr-compatible at `/app/config`.

## Installation

```bash
helm install foreseerr oci://ghcr.io/selmant/foreseerr/foreseerr-chart
```

## Configuration

See [`values.yaml`](./values.yaml) for all options. The chart supports custom
`dnsPolicy` and `dnsConfig` settings, pod user namespaces through `hostUsers`,
and scheduling through `priorityClassName`. `replicaCount` may be `0` (scaled
down, for example during a migration) or `1`; Foreseerr does not run as
multiple replicas.

### AI features

Saved AI credentials (API keys, ChatGPT sign-ins) are encrypted with a key that
Foreseerr creates as `secret.key` on the config volume. To keep the key apart
from the database, store it in a Secret and set `secretKey.existingSecret`:

```bash
# A new install, or one without saved AI credentials yet:
kubectl create secret generic foreseerr-secret-key \
  --from-literal=secret-key="$(openssl rand -hex 32)"
# An install that already saved credentials: reuse the current key instead,
# or they can no longer be opened.
kubectl exec foreseerr-0 -- cat /app/config/secret.key > secret.key
kubectl create secret generic foreseerr-secret-key --from-file=secret-key=secret.key
```

The key is mounted read-only for group `podSecurityContext.fsGroup` (mode
`0440`), which is how the non-root Foreseerr user reads it. Keep `fsGroup` set
(the default is `1000`); without it the key can't be read and AI settings fail.

Set `searxng.enabled=true` to run a private [SearXNG](https://docs.searxng.org)
instance for web search. It runs unprivileged with a read-only root filesystem,
and by default a NetworkPolicy lets only Foreseerr reach it, since SearXNG has
no login. Then turn it on in Settings → AI → Web search with the URL the
install notes print.

Without `searxng.existingSecret`, the chart generates SearXNG's signing key and
keeps it across `helm upgrade`. GitOps tools that render with `helm template`
(Argo CD, Flux's post-renderers) can't look up the existing Secret, so each
render would make a new key and the app would never settle. With those tools,
create the Secret yourself, set `searxng.existingSecret`, and set
`searxng.gitOps=true` so the chart rejects a missing Secret name:

```bash
# Set RELEASE_NAMESPACE to the namespace of your Helm release.
kubectl --namespace "$RELEASE_NAMESPACE" create secret generic foreseerr-searxng \
  --from-literal=secret-key="$(openssl rand -hex 32)"
```

## Update Notes

### From `seerr-chart`

This chart was renamed from `seerr-chart`. Helper templates use `foreseerr.*`. Config still mounts at `/app/config`.
