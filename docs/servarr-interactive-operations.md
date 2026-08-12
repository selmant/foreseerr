# Servarr interactive operations

Interactive Servarr management (search, release selection, grabs, queue polling, manual import) stores short-lived operation tokens in an in-process `NodeCache` inside [`server/routes/mediaServarr.ts`](../server/routes/mediaServarr.ts).

## Deployment constraint

Run **one Foreseerr application instance** per interactive management session, or terminate TLS on a load balancer with **sticky sessions** so start and poll requests for the same operation hit the same process.

Multi-replica deployments without sticky sessions can return `This operation has expired` even when the operation is still valid on another replica.

## Validation checklist

- Interactive Servarr management is enabled only when the deployment topology satisfies the constraint above.
- Health checks do not assume shared operation state across replicas.
- Restarts invalidate in-flight interactive operations; clients must restart the flow after a process restart.

## Future work

A shared store (database or Redis) for operation tokens would remove this constraint. That is intentionally out of scope for the post-fork consistency roadmap.
