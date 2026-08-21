# Operations

EdgeMneme is pre-launch. This runbook covers the only procedures that exist
today: provisioning, deployment, rollback, migration, and local validation.
Operational mechanisms that belong to a live service (unattended rollback,
deployment fingerprinting, quiescence reconciliation, production canaries, PAT
rotation drills, partial-sync and outbox recovery manuals) were removed and are
listed under [Roadmap](#roadmap).

## Provisioning order

Resource creation, migrations, and the first deployment are explicit operator
gates. Normal source deployment then runs from the protected GitHub
`production` environment.

1. Create `MEMORY_DB` and `SEARCH_DB`; store their UUIDs as protected GitHub
   environment variables. Never edit the tracked Wrangler placeholders.
2. Create the private projection R2 bucket used by the runtime Workers.
3. Create a separate default-jurisdiction, backup-only R2 bucket for production
   D1 migration exports. Do not bind it to any Worker, give it no custom
   domain, keep `r2.dev` disabled, and configure exactly one enabled
   object-deletion lifecycle rule for `system/backups/d1-migrations/` with ID
   `edgemneme-d1-migration-backups-retention` and age
   `D1_MIGRATION_BACKUP_RETENTION_DAYS * 86400` seconds. Store the bucket name
   and retention days (30-365) as protected `production` environment variables.
4. Create the Vectorize index with 1,024 dimensions and cosine distance. Before
   inserting any vector, create String metadata indexes for `model_generation`,
   `status`, `repository_partition`, `kind`, `memory_class`, and `scope_key`,
   plus Number metadata indexes for `valid_from_epoch_ms` and
   `valid_until_epoch_ms`. Do not create a `project_id` metadata index; the
   project boundary uses the Vectorize namespace.
5. Create the main Queue and dead-letter Queue.
6. Allocate three distinct positive rate-limit namespace IDs and store them as
   protected environment variables.
7. Configure the Cloudflare CI credential, account ID, gateway runtime secrets,
   and an explicit `ENABLE_GITHUB_SYNC=false` in the `production` environment.
8. Apply D1 migrations with the manual `Apply D1 Migrations` workflow; type
   `APPLY` exactly.
9. Deploy `memory-orchestrator`, then `memory-gateway`. Keep `github-sync`
   disabled and without a Cron until its Workflow entrypoints, credential, and
   repository-access baseline are separately verified.
10. Insert an approved project, principals, grants, repositories, and GitHub
    access baseline.

## Deployment

Pushes to `main` run `Deploy Workers` from the protected `production`
environment. The workflow validates source templates, renders ignored
configuration, deploys `memory-orchestrator` before `memory-gateway`, and
reconciles `github-sync` to the explicit `ENABLE_GITHUB_SYNC` gate.

Deployment secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`TOKEN_DIGEST_PEPPER`, and the GitHub token when sync is enabled) live in the
protected environment. Rotate the gateway pepper interactively with
`wrangler secret put` against the rendered config.

## Rollback

Roll back by redeploying the previous known-good commit, or instantly with:

```bash
pnpm exec wrangler rollback --config wrangler/.wrangler/<worker>.generated.jsonc
```

A failed or cancelled deployment leaves the last active Worker version serving;
rerun the deploy workflow after fixing the cause.

## Production D1 migration

Use the manual `Apply D1 Migrations` workflow and type `APPLY` exactly. The
workflow validates the backup bucket and lifecycle, exports both databases,
applies SEARCH_DB before MEMORY_DB, and fails closed on unexpected control-plane
state. A partial success is recovered by roll-forward only; there are no down
migrations.

## Local validation

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm exec wrangler d1 migrations apply MEMORY_DB \
  --local --config wrangler/memory-gateway.jsonc
pnpm exec wrangler d1 migrations apply SEARCH_DB \
  --local --config wrangler/memory-gateway.jsonc
```

## Roadmap

The following mechanisms were removed while the service is pre-launch. Rebuild
them, with the corresponding tests, when real traffic justifies them:

- Unattended rollback and the `production-rollback` environment
- Deployment state capture, drift gates, and configuration fingerprints
- GitHub sync disable/drain quiescence reconciliation
- Isolated production synthetic canary (to return as PR preview-environment
  checks)
- PAT rotation, partial-sync, outbox recovery, and in-place D1 upgrade manuals
