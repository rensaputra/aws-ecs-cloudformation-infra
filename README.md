# AWS ECS CloudFormation Infrastructure

Modular, layered AWS CloudFormation templates that provision production-grade
infrastructure for containerized workloads on **ECS Fargate**, along with the
GitHub Actions CI/CD pipelines that validate and deploy them.

## Layer / deploy model

The infrastructure is decomposed into five independently deployable layers, each
a single CloudFormation stack. Layers communicate **only** through CloudFormation
cross-stack references (`Export` / `Fn::ImportValue`); values are never duplicated
as parameters. Every export name is prefixed with the environment identifier
(`dev-` / `prod-`) so environments never collide.

Deploy order (each stack after the previous succeeds):

| Order | Template | Purpose |
| --- | --- | --- |
| 1 | `templates/00-vpc.yml` | VPC, public/private subnets, IGW, NAT gateways, routes |
| 2 | `templates/01-security-groups.yml` | ALB and ECS service security groups |
| 3 | `templates/02-alb.yml` | Internet-facing ALB, HTTPS 443, HTTP 80 → 443 redirect |
| 4 | `templates/03-ecs-cluster.yml` | ECS cluster, Cloud Map namespace, Container Insights |
| 5 | `templates/04-ecs-service.yml` | Task definition, service, Service Connect, target group, autoscaling |

The first four layers deploy via the manual workflow. The service stack (layer 5)
is deployed separately — via a manual run or automatically by the dispatch
workflow when an upstream repository pushes a new container image to ECR.

### Per-environment parameters

Each template has one parameter file per environment under `parameters/dev/` and
`parameters/prod/`, as flat `Key: Value` JSON consumed by `aws cloudformation deploy`.

### Workflows

- `.github/workflows/cfn-validate.yml` — runs `cfn-lint` + `cfn-nag` on pull requests.
- `.github/workflows/deploy-infra.yml` — manual (`workflow_dispatch`) deploy of layers 1–4.
- `.github/workflows/deploy-dispatch.yml` — `repository_dispatch` deploy of only the service stack.

## Repository layout

```
templates/            CloudFormation templates (YAML)
parameters/dev/       dev parameter files (one per template)
parameters/prod/      prod parameter files (one per template)
.github/workflows/    CI/CD workflows
test/                 TypeScript property-based test harness (vitest + fast-check)
.cfnlintrc            cfn-lint configuration
.cfn_nag.yml          cfn-nag rule configuration
```

## Local validation

The same three checks the CI validation workflow runs — cfn-lint, cfn-nag, and
the test harness — can all be run locally. The test harness is a TypeScript
project using [vitest](https://vitest.dev/) and
[fast-check](https://github.com/dubzzz/fast-check), parsing the templates,
parameter files, and workflows with [js-yaml](https://github.com/nodeca/js-yaml).

### Prerequisites

- Node.js 20+ and npm — for the test harness
- [`cfn-lint`](https://github.com/aws-cloudformation/cfn-lint) — `pip install cfn-lint`
- [`cfn-nag`](https://github.com/stelligent/cfn_nag) — `gem install cfn-nag`

Install the Node dependencies once:

```bash
npm install
```

### Running the checks

You can run the checks either through the `Makefile` or the npm scripts; they
are equivalent.

| Check | Makefile | npm |
| --- | --- | --- |
| Lint templates (`cfn-lint templates/`) | `make lint` | `npm run lint:cfn` |
| Security scan (`cfn_nag_scan --input-path templates/`) | `make scan` | `npm run scan:cfn` |
| Test harness (vitest) | `make test` | `npm test` |
| All three | `make validate` | `npm run validate` |

For example, to run everything before opening a pull request:

```bash
make validate
# or
npm run validate
```

The test harness alone (fast; no `cfn-lint`/`cfn-nag` needed) is:

```bash
npm test          # single run
npm run test:watch  # watch mode
```
