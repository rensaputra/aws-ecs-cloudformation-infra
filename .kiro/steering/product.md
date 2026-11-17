# Product

This repository provides modular, layered AWS CloudFormation templates for deploying ECS Fargate workloads, along with a property-based test harness that validates the templates without deploying to AWS.

## What it does

- Provisions a full ECS Fargate platform across five stacked CloudFormation layers: VPC, Security Groups, ALB, ECS Cluster, and ECS Service.
- Supports two environments: `dev` and `prod`.
- Automates infrastructure deployment via GitHub Actions with OIDC-based AWS authentication (no long-lived credentials).
- Separates infrastructure deployment (`deploy-infra.yml`) from service image updates (`deploy-dispatch.yml`), which is triggered by an upstream build repository via `repository_dispatch`.

## Target environments

| Environment | Usage |
|---|---|
| `dev` | Development / testing |
| `prod` | Production |

Stack naming convention: `${environment}-${layer}` (e.g. `dev-vpc`, `prod-alb`).
