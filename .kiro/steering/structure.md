# Project Structure

```
aws-ecs-cloudformation-infra/
├── templates/                        # CloudFormation templates, one per layer
│   ├── 00-vpc.yml                    # Layer 0: VPC, subnets, IGW, NAT gateways, route tables
│   ├── 01-security-groups.yml        # Layer 1: ALB and ECS service security groups
│   ├── 02-alb.yml                    # Layer 2: Internet-facing ALB, HTTPS/HTTP listeners
│   ├── 03-ecs-cluster.yml            # Layer 3: ECS cluster, Fargate capacity providers, Cloud Map namespace
│   └── 04-ecs-service.yml            # Layer 4: ECS Fargate service, task definition, autoscaling, ALB target group
│
├── parameters/                       # Per-environment parameter files (flat JSON key/value objects)
│   ├── dev/
│   │   ├── 00-vpc.json
│   │   ├── 01-security-groups.json
│   │   ├── 02-alb.json
│   │   ├── 03-ecs-cluster.json
│   │   └── 04-ecs-service.json
│   └── prod/
│       └── (same filenames as dev/)
│
├── test/
│   ├── harness/
│   │   ├── model.ts                  # Central artifact model: parses all templates, parameter files, and workflows
│   │   ├── cfn-schema.ts             # js-yaml schema extension for CloudFormation-specific YAML tags
│   │   ├── model.sanity.test.ts      # Sanity checks that the model loads correctly
│   │   └── export-inventory.test.ts  # Enumerates all cross-stack exports
│   ├── properties/                   # Property-based tests (fast-check), numbered property-01 through property-11
│   ├── snapshot/                     # Structural presence tests (assert expected resources exist)
│   ├── edge/                         # Edge-case parameter validation tests
│   ├── workflow/                     # GitHub Actions workflow control-flow tests
│   └── harness.smoke.test.ts         # Top-level smoke test for the harness
│
├── .github/workflows/
│   ├── cfn-validate.yml              # PR validation: cfn-lint + cfn-nag + npm test
│   ├── deploy-infra.yml              # Manual deploy of layers 00–03 (workflow_dispatch)
│   └── deploy-dispatch.yml           # Event-driven deploy of layer 04 (repository_dispatch)
│
├── docs/
│   └── prerequisites.md              # AWS setup guide (IAM, OIDC, ACM, SSM, ECR)
│
├── .cfnlintrc                        # cfn-lint configuration (regions, template glob)
├── .cfn_nag.yml                      # cfn-nag rule suppression configuration
├── Makefile                          # Shortcuts: lint, scan, test, validate
├── package.json
├── tsconfig.json                     # TypeScript: strict, ES2022, noEmit, includes test/**
└── vitest.config.ts
```

## Key conventions

- **Layer ordering:** Templates are prefixed `00`–`04` and must be deployed in that order. Layers 00–03 are deployed by `deploy-infra.yml`; layer 04 is deployed separately by `deploy-dispatch.yml`.
- **Cross-stack references:** Every `Export.Name` and `Fn::ImportValue` follows `${Environment}-<LogicalName>` (e.g. `dev-VpcId`). Never use hardcoded stack names in imports.
- **Parameter files:** One flat JSON object per template per environment under `parameters/<env>/<template-basename>.json`. Keys must match the template's `Parameters` section exactly (tested by property-07 and property-08). Sensitive values (e.g. `CertificateArn`) are injected at deploy time from SSM and must not be stored here.
- **Test placement:** Each test file targets one concern. Property-based tests live in `test/properties/` and are numbered to match the property catalogue. Shared parsing logic belongs in `test/harness/model.ts`, not duplicated in individual tests.
- **No compiled output:** TypeScript is used for type-checking only (`noEmit: true`). Vitest runs `.ts` files directly via its built-in transform.
