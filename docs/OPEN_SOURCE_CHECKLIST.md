# Open Source Release Checklist

Use this checklist before making the repository public.

## Repository

- [ ] Confirm `LICENSE`, `NOTICE`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, and `CODE_OF_CONDUCT.md` are present.
- [ ] Configure repository description, topics, homepage, and social preview.
- [ ] Enable GitHub private vulnerability reporting.
- [ ] Add `vir@qable.io` as the repository security contact.
- [ ] Configure branch protection for the default branch.
- [ ] Require the `CI` workflow before merging pull requests.

## Code and Data

- [ ] Remove generated files, uploads, logs, screenshots, database dumps, and local build output from Git tracking.
- [ ] Scan the full Git history for secrets.
- [ ] Rotate any secret that may have existed in the repository history.
- [ ] Review `deploy/`, `infra/`, and `.github/` for internal domains, account IDs, or operational details.
- [ ] Confirm all third-party assets can be redistributed under the project license.

## Documentation

- [ ] Verify the quick start works on a fresh machine.
- [ ] Document all required environment variables.
- [ ] Document Docker Compose setup for local development.
- [ ] Document production deployment expectations separately from local setup.
- [ ] Confirm the first public release only documents the simple test case management product surface.

## Release

- [ ] Create an initial public release tag, such as `v0.1.0`.
- [ ] Add release notes that describe current maturity and known limitations.
- [ ] Publish a roadmap or contribution priorities if you want community help.
