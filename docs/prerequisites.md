# Deployment Prerequisites

Two workflows handle deployments:

- **`deploy-infra.yml`** — manually triggered (`workflow_dispatch`); deploys layers 1–4. Binds to a GitHub Environment, so it reads environment-scoped secrets and variables.
- **`deploy-dispatch.yml`** — event-triggered (`repository_dispatch`); deploys the ECS service stack (layer 5). Does **not** bind to a GitHub Environment, so it reads from repository-level variables only.

The setup below distinguishes which workflow needs each value.

---

## 1. GitHub Environment variables (`deploy-infra.yml`)

Set these per environment under **Settings → Environments → (env) → Variables**.

| Variable | Description | Example |
|---|---|---|
| `AWS_REGION` | AWS region where all stacks are deployed | `us-east-1` |

Steps:

1. Go to **Settings → Environments**, select (or create) `dev`.
2. Under **Environment variables**, add `AWS_REGION`.
3. Repeat for `prod` (can be a different region if needed).

---

## 2. GitHub Repository variables (`deploy-dispatch.yml`)

`deploy-dispatch.yml` triggers on `repository_dispatch` events and has no
`environment:` binding, so environment-scoped values are never injected. It
reads these from repository-level variables instead.

Set these under **Settings → Variables → Actions → Repository variables**.

| Variable | Description | Example |
|---|---|---|
| `AWS_REGION` | Same region as the environment variable above | `us-east-1` |
| `AWS_DEPLOY_ROLE_ARN` | ARN of the IAM role to assume for the dispatch workflow | `arn:aws:iam::<account-id>:role/<role-name>` |

> **Note:** `deploy-infra.yml` reads `AWS_DEPLOY_ROLE_ARN` from an environment
> *secret* (section 3 below). `deploy-dispatch.yml` reads it from a repository
> *variable*. Both must be configured — they are separate GitHub settings.

---

## 3. GitHub Environment secrets (`deploy-infra.yml`)

Set these per environment under **Settings → Environments → (env) → Secrets**.

| Secret | Description |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | ARN of the IAM role the workflow assumes via OIDC |

---

## 4. IAM deploy role

The deploy workflows authenticate to AWS via OIDC federation — no long-lived
access keys are stored in GitHub. You create an IAM role in your AWS account
and store its ARN in both locations described in sections 2 and 3.

### Add the GitHub OIDC provider (once per account)

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

### Trust policy

Replace `<account-id>` and `<org>/<repo>` with your values.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:<org>/<repo>:*"
        }
      }
    }
  ]
}
```

The `sub` condition uses `*` to cover both workflows — `deploy-infra.yml`
(which sends `environment:<env>`) and `deploy-dispatch.yml` (which sends no
environment). To lock down each to its own role, create two roles with more
specific `sub` conditions:

| Workflow | `sub` condition value |
|---|---|
| `deploy-infra.yml` | `repo:<org>/<repo>:environment:dev` / `environment:prod` |
| `deploy-dispatch.yml` | `repo:<org>/<repo>:ref:refs/heads/main` |

### Permissions policy

Attach this policy to the role. It covers all five infrastructure layers plus
the SSM fetch for the ALB certificate.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudFormationDeploy",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeChangeSet",
        "cloudformation:CreateChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet",
        "cloudformation:GetTemplateSummary",
        "cloudformation:ValidateTemplate"
      ],
      "Resource": "*"
    },
    {
      "Sid": "SSMGetAlbParameters",
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:<region>:<account-id>:parameter/*/alb/*"
    },
    {
      "Sid": "IAMPassRole",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:PassRole",
        "iam:TagRole"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ECSAndRelatedServices",
      "Effect": "Allow",
      "Action": [
        "ecs:*",
        "ec2:*",
        "elasticloadbalancing:*",
        "logs:*",
        "servicediscovery:*",
        "application-autoscaling:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "S3TemplatesBucket",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject"
      ],
      "Resource": "arn:aws:s3:::cf-templates-*/*"
    }
  ]
}
```

> **Note:** The `ECSAndRelatedServices` statement uses broad actions for
> simplicity. For production, scope each action to only the resources your
> stacks create (by ARN prefix or tag condition).

---

## 5. SSM parameters

The `Deploy 02-alb` step fetches the certificate ARN from SSM at deploy time
so it is never stored in the repository. Create the parameter before running
the workflow.

| Environment | SSM Parameter Path |
|---|---|
| dev | `/dev/alb/certificate-arn` |
| prod | `/prod/alb/certificate-arn` |

```bash
aws ssm put-parameter \
  --name "/dev/alb/certificate-arn" \
  --value "arn:aws:acm:<region>:<account-id>:certificate/<uuid>" \
  --type String \
  --region <region>
```

See [`alb-prerequisites.md`](./alb-prerequisites.md) for how to obtain the
certificate ARN.

---

## 6. ECR repository

The ECS service stack (`04-ecs-service`) pulls a container image from ECR. The
repository must exist before the service stack is deployed.

```bash
aws ecr create-repository \
  --repository-name web-app \
  --region <region>
```

The image must be pushed and tagged before the service starts:

| Environment | Expected image tag |
|---|---|
| dev | `dev-latest` |
| prod | `prod-latest` |

The `deploy-dispatch.yml` workflow receives the image URI from the upstream
build repository's dispatch payload, so the parameter file value is overridden
at deploy time. However, **both `parameters/dev/04-ecs-service.json` and
`parameters/prod/04-ecs-service.json` contain a placeholder account ID
(`111122223333`) in `ContainerImageUri`** — update these to your real account
ID before any manual deployment that reads from the file directly:

```json
"ContainerImageUri": "<account-id>.dkr.ecr.<region>.amazonaws.com/web-app:dev-latest"
```

---

## 7. Application Auto Scaling service-linked role

The ECS service stack creates an auto scaling target that references the
`AWSServiceRoleForApplicationAutoScaling_ECSService` service-linked role. AWS
creates this role automatically the first time you use ECS Application Auto
Scaling in an account (e.g. via the console). If the account has never done
this, create it manually before deploying `04-ecs-service`:

```bash
aws iam create-service-linked-role \
  --aws-service-name ecs.application-autoscaling.amazonaws.com
```

You can check whether it already exists with:

```bash
aws iam get-role \
  --role-name AWSServiceRoleForApplicationAutoScaling_ECSService
```

---

## 8. ALB access logs bucket (optional)

Both `parameters/dev/02-alb.json` and `parameters/prod/02-alb.json` leave
`AccessLogsBucketName` empty, which disables ALB access logging. This is
intentional for dev. For prod, it is strongly recommended to enable it.

To create the bucket and enable logging, see [`alb-prerequisites.md`](./alb-prerequisites.md),
then set the bucket name in `parameters/prod/02-alb.json`:

```json
"AccessLogsBucketName": "my-alb-access-logs-prod"
```

---

## 9. CloudWatch log group encryption (optional)

The ECS service stack accepts an optional KMS CMK ARN via `LogGroupKmsKeyId`
in `parameters/<env>/04-ecs-service.json`. Leaving it empty (the default) uses
AWS-managed encryption for the CloudWatch log group, which is acceptable for
most use cases.

To enable CMK encryption:

1. Create a KMS key and grant CloudWatch Logs permission to use it:
   ```json
   {
     "Effect": "Allow",
     "Principal": { "Service": "logs.<region>.amazonaws.com" },
     "Action": ["kms:GenerateDataKey*", "kms:Decrypt"],
     "Resource": "*"
   }
   ```
2. Set the key ARN in the parameter file:
   ```json
   "LogGroupKmsKeyId": "arn:aws:kms:<region>:<account-id>:key/<uuid>"
   ```

---

## References

- [Configuring OpenID Connect in Amazon Web Services](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services)
- [AWS — Creating OIDC identity providers](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html)
- [SSM Parameter Store pricing](https://aws.amazon.com/systems-manager/pricing/)
- [AWS — Service-linked roles for Application Auto Scaling](https://docs.aws.amazon.com/autoscaling/application/userguide/application-auto-scaling-service-linked-roles.html)
- [AWS — ALB access logging](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/enable-access-logging.html)
