# Tech Stack

## CloudFormation templates

- Written in YAML (`AWSTemplateFormatVersion: "2010-09-09"`).
- Linted with **cfn-lint** (Python: `pip install cfn-lint`), configured in `.cfnlintrc`.
- Security-scanned with **cfn-nag** (Ruby: `gem install cfn-nag`), configured in `.cfn_nag.yml`.
- Cross-stack values are shared exclusively via `Fn::ImportValue` / `Export` using the naming convention `${Environment}-<LogicalName>` (e.g. `dev-VpcId`).
- Sensitive values (e.g. ACM certificate ARN) are read from SSM Parameter Store at deploy time and never committed to the repository.

## Test harness

- **Language:** TypeScript 5, targeting ES2022/ESNext modules (`noEmit: true` — TypeScript is type-checking only, not compiling to JS).
- **Test runner:** Vitest 2 (`vitest.config.ts`), 30-second timeout for property-based tests.
- **Property-based testing:** fast-check 3 for generating arbitrary inputs across properties 1–11.
- **YAML parsing:** js-yaml 4 (with a CFN-aware wrapper in `test/harness/cfn-schema.ts` to handle CloudFormation-specific YAML tags).
- Tests cover: subnet CIDR derivation, cross-stack import resolution, export naming, Fargate CPU/memory constraints, autoscaling bounds, parameter file bijection, deploy ordering, and dispatch payload validation.

## CI/CD

- **GitHub Actions** runs three workflows:
  - `cfn-validate.yml` — lints and scans templates on every PR.
  - `deploy-infra.yml` — manually triggered (`workflow_dispatch`); deploys layers 00–03 to `dev` or `prod`.
  - `deploy-dispatch.yml` — triggered by `repository_dispatch` (`web-app-image-pushed`); deploys only layer 04 (`04-ecs-service`).
- AWS authentication uses **OIDC federation** via `aws-actions/configure-aws-credentials@v4` (no stored access keys).

## Common commands

```bash
# Run all validation (lint + scan + test)
make validate
# or
npm run validate

# CloudFormation lint only
make lint
# or
npm run lint:cfn

# cfn-nag security scan only
make scan
# or
npm run scan:cfn

# TypeScript property-based tests only
make test
# or
npm test

# Watch mode for tests during development
npm run test:watch
```

## Prerequisites

- Node.js 20+
- cfn-lint (`pip install cfn-lint`)
- cfn-nag (`gem install cfn-nag`)
