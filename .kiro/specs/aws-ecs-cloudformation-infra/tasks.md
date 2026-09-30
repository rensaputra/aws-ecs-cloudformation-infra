# Implementation Plan: AWS ECS CloudFormation Infrastructure

## Overview

This plan builds a modular, layered set of AWS CloudFormation templates (YAML) for ECS Fargate workloads, their per-environment parameter files, and three GitHub Actions workflows, together with a TypeScript property-based test harness (using **fast-check** and **js-yaml**) that verifies the 11 correctness properties over the parsed artifacts.

Work proceeds in dependency order. First the repository skeleton and shared test scaffolding are established. Then each CloudFormation template is authored incrementally in the deploy order (VPC → security groups → ALB → cluster → service), each with its parameters, validation, resources, and env-prefixed exports/imports. Parameter files for both environments follow each template. The three workflows are authored next. Finally the property/example/edge/snapshot tests are implemented (mapping to Properties 1-11) and local tooling (cfn-lint + cfn-nag) is wired in.

The templates are declarative CloudFormation and are validated by cfn-lint, cfn-nag, and snapshot/synth assertions. The property tests operate over the parsed template/param/workflow model. Test sub-tasks are marked optional with `*`.

## Tasks

- [~] 1. Set up repository skeleton and shared test harness scaffolding
  - Create directories: `templates/`, `parameters/dev/`, `parameters/prod/`, `.github/workflows/`, and `test/` for the harness
  - Initialize the TypeScript test project: `package.json`, `tsconfig.json`, a test runner config (vitest or jest), and dev dependencies `fast-check`, `js-yaml`, and their `@types`
  - Add a top-level `README.md` stub describing the layer/deploy model and how to run lint/scan/tests
  - Add `cfn-lint`/`cfn-nag` config placeholders (e.g., `.cfnlintrc`, cfn-nag rule config) referenced later
  - _Requirements: 6.1, 7.3, 8.1, 8.2_

- [ ] 2. Author the VPC template (`templates/00-vpc.yml`)
  - [~] 2.1 Define VPC parameters with validation
    - `Environment` (String, `AllowedValues: [dev, prod]`), `VpcCidr` (String, `AllowedPattern` regex accepting only valid IPv4 CIDR with prefix /16-/28), `AvailabilityZoneCount` (Number, `AllowedValues: [2, 3]`, default 2)
    - _Requirements: 1.1, 1.2_
  - [~] 2.2 Define VPC, IGW, subnets, NAT gateways, and route tables
    - `AWS::EC2::VPC`; `AWS::EC2::InternetGateway` + `AWS::EC2::VPCGatewayAttachment`; one public and one private subnet per AZ with CIDRs derived via `Fn::Cidr`/`Fn::Select` over `Fn::GetAZs` (non-overlapping); one `AWS::EC2::NatGateway` + `AWS::EC2::EIP` per AZ in the same-AZ public subnet; public route table `0.0.0.0/0 -> IGW`; per-AZ private route tables `0.0.0.0/0 -> same-AZ NAT`
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 1.7_
  - [~] 2.3 Define env-prefixed VPC exports
    - Outputs with `Export.Name: !Sub "${Environment}-<logical>"` for `VpcId`, `PublicSubnetIds` (comma-joined), `PrivateSubnetIds` (comma-joined), plus per-AZ `PublicSubnet{N}Id`/`PrivateSubnet{N}Id`
    - _Requirements: 1.8, 6.2_

- [ ] 3. Author the Security Groups template (`templates/01-security-groups.yml`)
  - [~] 3.1 Define SG parameters with validation
    - `Environment` (`AllowedValues: [dev, prod]`), `AlbIngressCidr` (String, `AllowedPattern` CIDR regex), `ContainerListenerPort` (Number, `MinValue: 1`, `MaxValue: 65535`)
    - _Requirements: 2.2, 2.6_
  - [~] 3.2 Define the two security groups, ingress rules, and VPC import
    - `AlbSecurityGroup` ingress TCP 443 from `AlbIngressCidr` only; `EcsServiceSecurityGroup` with a separate `AWS::EC2::SecurityGroupIngress` allowing TCP `ContainerListenerPort` from `SourceSecurityGroupId = AlbSecurityGroup` (default-deny otherwise); import `${Environment}-VpcId` via `Fn::ImportValue`
    - _Requirements: 2.1, 2.3, 2.4, 2.7_
  - [~] 3.3 Define env-prefixed SG exports
    - `${Environment}-AlbSecurityGroupId`, `${Environment}-EcsServiceSecurityGroupId`
    - _Requirements: 2.5, 6.2_

- [ ] 4. Author the ALB template (`templates/02-alb.yml`)
  - [~] 4.1 Define ALB parameters with validation
    - `Environment` (`AllowedValues: [dev, prod]`), `CertificateArn` (String, `AllowedPattern` matching `arn:aws:acm:...:certificate/...` and rejecting empty)
    - _Requirements: 3.4_
  - [~] 4.2 Define the ALB, listeners, and imports
    - `AWS::ElasticLoadBalancingV2::LoadBalancer` internet-facing across imported `${Environment}-PublicSubnetIds` (>=2 AZs), `SecurityGroups` = imported `${Environment}-AlbSecurityGroupId`; HTTPS listener on 443 with `Certificates: [{ CertificateArn }]` and default 503 fixed-response; HTTP listener on 80 with redirect to 443 `HTTP_301` preserving `#{host}`/`#{path}`/`#{query}`
    - _Requirements: 3.1, 3.2, 3.3, 3.5_
  - [~] 4.3 Define env-prefixed ALB exports
    - `${Environment}-AlbArn`, `${Environment}-AlbDnsName`, `${Environment}-HttpsListenerArn`
    - _Requirements: 3.6, 6.2_

- [ ] 5. Author the ECS Cluster template (`templates/03-ecs-cluster.yml`)
  - [~] 5.1 Define cluster parameters and resources
    - `Environment` (`AllowedValues: [dev, prod]`), `NamespaceName` (String); `AWS::ECS::Cluster` with `ClusterSettings` containerInsights=enabled and `ServiceConnectDefaults.Namespace`; `AWS::ECS::ClusterCapacityProviderAssociations` with `[FARGATE, FARGATE_SPOT]`; `AWS::ServiceDiscovery::HttpNamespace`
    - _Requirements: 4.1, 4.2, 4.3, 4.4_
  - [~] 5.2 Define env-prefixed cluster exports
    - `${Environment}-ClusterName`, `${Environment}-ClusterArn`, `${Environment}-NamespaceArn`
    - _Requirements: 4.5, 4.6, 4.7, 6.2_

- [ ] 6. Author the ECS Service template (`templates/04-ecs-service.yml`)
  - [~] 6.1 Define service parameters, `AllowedValues`, and `Rules` validation
    - `Environment`, `ServiceName`, `ContainerImageUri`, `ContainerPort` (`MinValue: 1`, `MaxValue: 65535`), `TaskCpu`/`TaskMemory` (`AllowedValues` for Fargate values), `ServiceConnectPort`, `DesiredCount` (`MinValue: 0`), `MinTaskCount`/`MaxTaskCount`, `TargetCpuUtilization` (`MinValue: 1`, `MaxValue: 100`)
    - `Rules` section asserting valid Fargate CPU/memory combinations and `MinTaskCount <= MaxTaskCount` with `AssertDescription`s
    - _Requirements: 5.1, 5.2, 5.7, 5.8, 5.9_
  - [~] 6.2 Define task definition, service, Service Connect, target group, and autoscaling with imports
    - `AWS::ECS::TaskDefinition` FARGATE/awsvpc with container `Image: ContainerImageUri`, named `PortMappings` with `AppProtocol: http2` on `ServiceConnectPort`; `AWS::ECS::Service` in imported `${Environment}-PrivateSubnetIds`, `SecurityGroups` = imported `${Environment}-EcsServiceSecurityGroupId`, `AssignPublicIp: DISABLED`, `ServiceConnectConfiguration` using imported `${Environment}-NamespaceArn`, registered to imported `${Environment}-ClusterName`; `AWS::ElasticLoadBalancingV2::TargetGroup` (`TargetType: ip`, `Protocol: HTTP`, `Port: ContainerPort`) + `ListenerRule` on imported `${Environment}-HttpsListenerArn`; `ScalableTarget` (Min/Max) + `ScalingPolicy` target-tracking on `ECSServiceAverageCPUUtilization = TargetCpuUtilization`
    - Optional env-prefixed export `${Environment}-${ServiceName}-ServiceArn`
    - _Requirements: 5.3, 5.4, 5.5, 5.6, 5.7, 6.2_

- [~] 7. Checkpoint - templates lint clean
  - Ensure all tests pass, ask the user if questions arise.
  - Run cfn-lint and cfn-nag locally against `templates/` and resolve any error/failing findings

- [ ] 8. Author per-environment parameter files
  - [~] 8.1 Author dev parameter files
    - Create `parameters/dev/00-vpc.json`, `01-security-groups.json`, `02-alb.json`, `03-ecs-cluster.json`, `04-ecs-service.json` as flat `Key: Value` JSON objects; every key must match a declared template `Parameters` entry
    - _Requirements: 7.1, 7.3_
  - [~] 8.2 Author prod parameter files
    - Create the identical file set under `parameters/prod/` with prod-appropriate values
    - _Requirements: 7.2, 7.3_

- [~] 9. Author the CI validation workflow (`.github/workflows/cfn-validate.yml`)
  - Trigger on `pull_request` to `main` (opened/synchronize/reopened); `timeout-minutes: 15`; discover `templates/**` recursively (zero templates = passing no-op); run cfn-lint (fail + report path/location on error findings) and cfn-nag (fail + report path/rule id on failing findings); pass when both are clean; no AWS credentials
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

- [~] 10. Author the manual deploy workflow (`.github/workflows/deploy-infra.yml`)
  - `workflow_dispatch` with `environment` input (`type: choice`, `options: [dev, prod]`); `permissions: id-token: write, contents: read`; OIDC auth via `aws-actions/configure-aws-credentials` before any deploy; sequential (non `continue-on-error`) steps: per-step parameter-file existence pre-check (fail naming missing file) then `aws cloudformation deploy` for `00-vpc` → `01-security-groups` → `02-alb` → `03-ecs-cluster`, each gated on the previous, stopping on first failure and naming the failing template; service stack excluded
  - _Requirements: 7.4, 7.5, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

- [~] 11. Author the dispatch deploy workflow (`.github/workflows/deploy-dispatch.yml`)
  - `repository_dispatch` `types: [web-app-image-pushed]`; validation-first job asserting `environment` ∈ {dev, prod} and non-empty `image_uri` (and other required values), failing otherwise; `permissions: id-token: write`; OIDC auth before any update; `aws cloudformation deploy` targeting **only** `04-ecs-service.yml` for the payload environment, overriding `ContainerImageUri` and merging `parameters/${env}/04-ecs-service.json`; no other stack referenced
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7_

- [~] 12. Checkpoint - artifacts complete, workflows reviewed
  - Ensure all tests pass, ask the user if questions arise.

- [~] 13. Implement the shared artifact-parsing model for the test harness
  - Parse the five templates, both environments' parameter files, and the three workflow YAML files into typed in-memory models: per-template parameters (with constraints), resources, and `Export.Name`/`Fn::ImportValue` edges; per-file parameter keys; workflow triggers, deploy steps, and payload-validation logic. This model is the substrate all property tests quantify over.
  - _Requirements: 6.1_

- [ ] 14. Implement property-based tests over the artifact model
  - [~] 14.1 Property 1 test — subnet CIDR layout non-overlapping and complete per AZ
    - **Property 1: Subnet CIDR layout is non-overlapping and complete per AZ**
    - Generate valid VPC CIDRs (/16-/28) and AZ counts (2-3); assert exactly one public + one private subnet per AZ, all derived CIDRs pairwise non-overlapping and within the VPC CIDR; min 100 iterations
    - **Validates: Requirements 1.3**
  - [~] 14.2 Property 2 test — every import resolves to a produced export
    - **Property 2: Every import resolves to a produced export (no duplicated parameters)**
    - For each `Fn::ImportValue` in the set, assert a matching `Export.Name` exists in another template and the value is not carried as a duplicated parameter
    - **Validates: Requirements 2.4, 5.3, 5.5, 5.6, 6.1, 6.3**
  - [~] 14.3 Property 3 test — every export name is environment-prefixed
    - **Property 3: Every export name is environment-prefixed**
    - For each export and each env ∈ {dev, prod}, assert the resolved name begins with `<env>-` and dev/prod names differ
    - **Validates: Requirements 1.8, 2.5, 3.6, 4.5, 4.6, 4.7, 6.2**
  - [~] 14.4 Property 4 test — export names unique within an environment
    - **Property 4: Export names are unique within an environment**
    - For each env, assert resolved export names across all templates are pairwise unique
    - **Validates: Requirements 6.5**
  - [~] 14.5 Property 5 test — Fargate CPU/memory accepted iff valid
    - **Property 5: Fargate CPU/memory combinations are accepted exactly when valid**
    - Generate (CPU, memory) pairs from valid and invalid sets; assert the template's validation logic accepts iff the pair is in the official valid set; min 100 iterations
    - **Validates: Requirements 5.1, 5.8**
  - [~] 14.6 Property 6 test — autoscaling bounds accepted iff min <= max
    - **Property 6: Autoscaling accepts bounds exactly when min does not exceed max**
    - Generate (min, max) integer pairs; assert accepted iff min <= max; min 100 iterations
    - **Validates: Requirements 5.9**
  - [~] 14.7 Property 7 test — deployed templates have matching param files per env
    - **Property 7: Every deployed template has matching parameter files in each environment**
    - For each env, assert a bijection between deployed templates and parameter files under `parameters/{env}/`
    - **Validates: Requirements 7.1, 7.2**
  - [~] 14.8 Property 8 test — param-file keys correspond to declared parameters
    - **Property 8: Parameter-file keys correspond to declared template parameters**
    - For each param file and each key, assert the key names a declared `Parameters` entry in the targeted template
    - **Validates: Requirements 7.3**
  - [~] 14.9 Property 9 test — deploy order is a valid topological order
    - **Property 9: Deploy order is a valid topological order of the dependency graph**
    - For each import edge, assert the producer template appears strictly before the consumer in the Deploy_Workflow sequence
    - **Validates: Requirements 9.1**
  - [~] 14.10 Property 10 test — dispatch workflow targets only the service stack
    - **Property 10: The dispatch workflow targets only the service stack**
    - For each deploy/update action in the Dispatch_Workflow, assert it acts on `04-ecs-service.yml` and no VPC/SG/ALB/cluster template is referenced
    - **Validates: Requirements 10.1, 10.2**
  - [~] 14.11 Property 11 test — dispatch payload validation accepts iff complete and valid
    - **Property 11: Dispatch payload validation accepts exactly complete, valid payloads**
    - Generate synthetic `client_payload` objects (each required key present/absent, environment inside/outside {dev, prod}); assert accepted iff non-empty `environment` ∈ {dev, prod} and non-empty `image_uri`; min 100 iterations
    - **Validates: Requirements 10.5, 10.6**

- [ ] 15. Implement example, edge-case, and snapshot tests
  - [~] 15.1 Write snapshot/synth structural-presence tests
    - Assert IGW attachment (1.4), NAT placement (1.5), route tables (1.6, 1.7), exactly two SGs + ingress (2.1-2.3), ALB scheme/listeners + 301 redirect preserving host/path/query (3.1-3.5), capacity providers/Container Insights/HTTP namespace (4.1-4.3), Service Connect http2 + target-group/listener wiring (5.4, 5.5)
    - _Requirements: 1.4, 1.5, 1.6, 1.7, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.5, 4.1, 4.2, 4.3, 5.4, 5.5_
  - [~] 15.2 Write edge-case parameter-validation tests
    - Feed boundary/malformed inputs: invalid/boundary CIDRs (1.2, 2.6), empty/invalid ACM ARNs (3.4), out-of-range container ports (5.2) and target CPU (5.7), reusing Property 5/6 generators
    - _Requirements: 1.2, 2.6, 3.4, 5.2, 5.7_
  - [~] 15.3 Write workflow example/control-flow tests
    - Assert env `choice` dev/prod (9.2, 9.3), sequential non-`continue-on-error` deploy steps that stop and name failure (9.6), auth-before-deploy/update ordering (9.4, 10.4), `timeout-minutes: 15` (8.6), missing-param-file failure naming the file (7.5), dispatch payload reads (10.3)
    - _Requirements: 7.5, 8.6, 9.2, 9.3, 9.4, 9.6, 10.3, 10.4_

- [~] 16. Wire local tooling and validate cross-stack export naming consistency
  - Add npm scripts / a `Makefile` to run cfn-lint, cfn-nag (`cfn_nag_scan --input-path templates/`), and the test harness locally; document in `README.md`
  - Verify the env-prefixed export naming convention (`${Environment}-<logical>`) is applied consistently across all five templates and matches the canonical export inventory
  - _Requirements: 6.2, 8.1, 8.2_

- [~] 17. Final checkpoint - all tests pass
  - Ensure all tests pass, ask the user if questions arise.
  - Confirm cfn-lint/cfn-nag are clean and all property/example/edge/snapshot tests pass

## Notes

- Tasks marked with `*` are optional (test tasks) and can be skipped for a faster MVP, but they encode the design's correctness properties and are recommended.
- Each task references specific requirement sub-clauses and/or correctness properties for traceability.
- Checkpoints ensure incremental validation of the declarative artifacts.
- Property tests (Properties 1-11) validate universal invariants over the parsed template/param/workflow model using fast-check (min 100 iterations each); each property is a single test tagged `Feature: aws-ecs-cloudformation-infra, Property {n}: {text}`.
- Snapshot/synth, edge-case, and workflow example tests cover the declarative provisioning and control-flow criteria that do not vary with input.
- Runtime/AWS-owned behaviors (unresolved-import failure 2.7/6.3, cluster rollback 4.4, in-use export protection 6.4, OIDC auth outcomes) are integration concerns outside PBT scope and are exercised by targeted integration tests, not represented as parallelizable coding tasks here.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1", "2.2", "2.3"] },
    { "id": 2, "tasks": ["3.1", "3.2", "3.3"] },
    { "id": 3, "tasks": ["4.1", "4.2", "4.3"] },
    { "id": 4, "tasks": ["5.1", "5.2"] },
    { "id": 5, "tasks": ["6.1", "6.2"] },
    { "id": 6, "tasks": ["8.1", "8.2", "9", "10", "11", "13"] },
    { "id": 7, "tasks": ["14.1", "14.5", "14.6", "15.2"] },
    { "id": 8, "tasks": ["14.2", "14.3", "14.4", "14.7", "14.8", "15.1"] },
    { "id": 9, "tasks": ["14.9", "14.10", "14.11", "15.3", "16"] }
  ]
}
```
