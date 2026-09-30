# Requirements Document

## Introduction

This feature delivers a set of modular, layered AWS CloudFormation templates that provision production-grade infrastructure for containerized workloads on AWS ECS Fargate. The infrastructure is decomposed into independently deployable layers: VPC networking, security groups, an Application Load Balancer, an ECS cluster with a Cloud Map namespace for Service Connect, and a reusable ECS service template that deploys a containerized web application whose container image is sourced from Amazon ECR. Layers communicate through CloudFormation cross-stack references (exports and imports). Per-environment parameter files (dev and prod) drive environment-specific configuration. A GitHub Actions CI pipeline validates and security-scans templates on pull requests, and a GitHub Actions CD pipeline deploys infrastructure both manually and in response to dispatch events. An upstream image-build repository builds and pushes the web-app container image to Amazon ECR and then triggers this repository through a repository dispatch event, which updates only the web-app service stack.

## Glossary

- **Infrastructure_System**: The complete set of CloudFormation templates, parameter files, and GitHub Actions workflows delivered by this feature.
- **VPC_Template**: The CloudFormation template (`templates/00-vpc.yml`) that provisions the Virtual Private Cloud and its networking components.
- **Security_Group_Template**: The CloudFormation template (`templates/01-security-groups.yml`) that provisions security groups for the ALB and ECS services.
- **ALB_Template**: The CloudFormation template (`templates/02-alb.yml`) that provisions the Application Load Balancer, listeners, and ACM certificate association.
- **Cluster_Template**: The CloudFormation template (`templates/03-ecs-cluster.yml`) that provisions the ECS cluster and Cloud Map namespace.
- **Service_Template**: The reusable CloudFormation template (`templates/04-ecs-service.yml`) that provisions an ECS task definition, service, Service Connect configuration, and auto scaling.
- **Web_App_Service_Stack**: The CloudFormation stack created from the Service_Template that runs the containerized web application.
- **ECR**: Amazon Elastic Container Registry, the registry that stores the web-app container image.
- **VPC**: A logically isolated Amazon Virtual Private Cloud network.
- **IGW**: Internet Gateway that provides internet access to public subnets.
- **NAT_Gateway**: Managed Network Address Translation gateway that provides outbound internet access to private subnets.
- **ALB**: Application Load Balancer that distributes inbound HTTP/HTTPS traffic.
- **ACM_Certificate**: An AWS Certificate Manager TLS certificate used by the ALB HTTPS listener.
- **ECS_Cluster**: An Amazon Elastic Container Service cluster running the Fargate launch type.
- **Cloud_Map_Namespace**: An AWS Cloud Map namespace used by ECS Service Connect for service discovery.
- **Service_Connect**: The ECS feature that provides service-to-service discovery and communication.
- **Task_Definition**: An ECS task definition describing the container image, resources, and configuration.
- **Auto_Scaling_Policy**: An Application Auto Scaling target-tracking policy attached to an ECS service.
- **Cross_Stack_Reference**: A CloudFormation `Export`/`ImportValue` relationship linking outputs of one stack to inputs of another.
- **Parameter_File**: An environment-specific file under `parameters/dev/` or `parameters/prod/` supplying CloudFormation parameter values.
- **CI_Workflow**: The GitHub Actions workflow (`.github/workflows/cfn-validate.yml`) that lints and security-scans templates on pull requests.
- **Deploy_Workflow**: The GitHub Actions workflow (`.github/workflows/deploy-infra.yml`) that deploys infrastructure manually.
- **Dispatch_Workflow**: The GitHub Actions workflow (`.github/workflows/deploy-dispatch.yml`) triggered by an external repository via repository dispatch.
- **cfn-lint**: A linter that validates CloudFormation template structure and best practices.
- **cfn-nag**: A security scanner that detects insecure patterns in CloudFormation templates.
- **Environment**: A named deployment target, one of `dev` or `prod`.

## Requirements

### Requirement 1: Production-Grade VPC Networking

**User Story:** As a platform engineer, I want a multi-AZ VPC with public and private subnets, so that containerized workloads run with production-grade network isolation and availability.

#### Acceptance Criteria

1. THE VPC_Template SHALL provision one VPC with an IPv4 CIDR block supplied as a parameter constrained to a prefix length between /16 and /28 inclusive.
2. IF the VPC CIDR block parameter is not a syntactically valid IPv4 CIDR with a prefix length between /16 and /28 inclusive, THEN THE VPC_Template SHALL fail stack creation and create no VPC resources.
3. THE VPC_Template SHALL provision exactly one public subnet and exactly one private subnet in each Availability Zone, across at least two Availability Zones, with non-overlapping CIDR blocks.
4. THE VPC_Template SHALL provision one IGW and attach the IGW to the VPC.
5. THE VPC_Template SHALL provision exactly one NAT_Gateway per Availability Zone, each placed in the public subnet of the same Availability Zone.
6. THE VPC_Template SHALL provision route tables that route public subnet traffic destined for 0.0.0.0/0 through the IGW.
7. THE VPC_Template SHALL provision route tables that route private subnet traffic destined for 0.0.0.0/0 through the NAT_Gateway in the same Availability Zone.
8. THE VPC_Template SHALL export the VPC identifier, the public subnet identifiers, and the private subnet identifiers as Cross_Stack_References with export names unique per Environment.

### Requirement 2: Security Groups

**User Story:** As a platform engineer, I want dedicated security groups for the ALB and ECS services, so that network access between tiers follows least-privilege rules.

#### Acceptance Criteria

1. THE Security_Group_Template SHALL provision one security group for the ALB and one security group for ECS services.
2. THE Security_Group_Template SHALL allow inbound HTTPS traffic on port 443 to the ALB security group from a configurable source CIDR supplied as a parameter.
3. THE Security_Group_Template SHALL allow inbound traffic to the ECS service security group on the container listener port only from the ALB security group, and SHALL deny all other inbound traffic by default.
4. THE Security_Group_Template SHALL import the VPC identifier from the VPC_Template using a Cross_Stack_Reference.
5. THE Security_Group_Template SHALL export the ALB security group identifier and the ECS service security group identifier as Cross_Stack_References.
6. IF the configurable source CIDR parameter value is not a valid CIDR block, THEN THE Security_Group_Template SHALL fail the stack deployment with the CloudFormation validation error.
7. IF the VPC identifier import cannot be resolved at deployment time, THEN THE Security_Group_Template SHALL fail the stack deployment with the CloudFormation import error.

### Requirement 3: Application Load Balancer with TLS

**User Story:** As a platform engineer, I want an internet-facing ALB with TLS termination, so that clients reach services securely over HTTPS.

#### Acceptance Criteria

1. THE ALB_Template SHALL provision exactly one internet-facing ALB placed across all public subnets imported from the VPC_Template, spanning a minimum of two Availability Zones.
2. THE ALB_Template SHALL associate the ALB with the ALB security group imported from the Security_Group_Template.
3. THE ALB_Template SHALL provision an HTTPS listener on port 443 that uses the ACM_Certificate identified by an ARN supplied as a parameter.
4. IF the ACM_Certificate ARN parameter is empty or is not a syntactically valid ACM certificate ARN, THEN THE ALB_Template SHALL fail stack creation and produce an error indicating the certificate ARN is invalid.
5. WHEN a client connects to the ALB on port 80, THE ALB_Template SHALL redirect the request to port 443 using an HTTP 301 permanent redirect while preserving the original host, path, and query string.
6. THE ALB_Template SHALL export the ALB ARN, the ALB DNS name, and the HTTPS listener ARN as Cross_Stack_References.

### Requirement 4: ECS Fargate Cluster with Service Connect

**User Story:** As a platform engineer, I want an ECS Fargate cluster with a Cloud Map namespace, so that services can discover and communicate with each other through Service Connect.

#### Acceptance Criteria

1. THE Cluster_Template SHALL provision exactly one ECS_Cluster with the FARGATE and FARGATE_SPOT capacity providers.
2. THE Cluster_Template SHALL provision exactly one Cloud_Map_Namespace of the HTTP type required by Service_Connect.
3. THE Cluster_Template SHALL enable Container Insights on the ECS_Cluster.
4. IF provisioning of any Cluster_Template resource fails, THEN THE Cluster_Template SHALL roll back the stack to its previous state and produce an error indication identifying the failure.
5. THE Cluster_Template SHALL export the ECS_Cluster name as a Cross_Stack_Reference.
6. THE Cluster_Template SHALL export the ECS_Cluster ARN as a Cross_Stack_Reference.
7. THE Cluster_Template SHALL export the Cloud_Map_Namespace ARN as a Cross_Stack_Reference.

### Requirement 5: Reusable ECS Service Template

**User Story:** As a service owner, I want a reusable ECS service template with task definition, Service Connect, and auto scaling, so that I can deploy multiple containerized services consistently.

#### Acceptance Criteria

1. THE Service_Template SHALL provision one Task_Definition using the Fargate launch type with CPU and memory supplied as parameters constrained to valid Fargate CPU and memory combinations.
2. THE Service_Template SHALL accept a container image URI, a container port constrained to the range 1 through 65535 inclusive, and a desired task count as parameters.
3. THE Service_Template SHALL provision one ECS service that registers with the Cloud_Map_Namespace imported from the Cluster_Template.
4. THE Service_Template SHALL configure Service_Connect using the HTTP/2 protocol for the service on a Service Connect port supplied as a parameter.
5. THE Service_Template SHALL register the ECS service with a target group attached to the HTTPS listener imported from the ALB_Template.
6. THE Service_Template SHALL associate the ECS service with the ECS service security group imported from the Security_Group_Template.
7. THE Service_Template SHALL provision an Auto_Scaling_Policy that uses target tracking on a target CPU utilization value supplied as a parameter constrained to the range 1 through 100 percent inclusive, adjusting the running task count between a configurable minimum task count and a configurable maximum task count.
8. IF the container port, CPU, memory, or target CPU utilization parameter is outside its permitted range or is not a valid Fargate CPU and memory combination, THEN THE Service_Template SHALL fail stack creation and produce an error identifying the invalid parameter.
9. IF the minimum task count parameter is greater than the maximum task count parameter, THEN THE Service_Template SHALL fail stack creation and produce an error indicating the scaling bounds are invalid.

### Requirement 6: Cross-Stack References

**User Story:** As a platform engineer, I want templates to share values through cross-stack references, so that layers deploy independently while staying integrated.

#### Acceptance Criteria

1. WHERE a template consumes a value produced by another template, THE Infrastructure_System SHALL pass that value through a Cross_Stack_Reference rather than a duplicated parameter.
2. THE Infrastructure_System SHALL prefix every export name with the deploying stack's Environment identifier followed by a hyphen separator, such that no two exports across different Environments share an identical export name.
3. IF a required Cross_Stack_Reference is unavailable at deployment time, THEN THE Infrastructure_System SHALL halt the stack deployment before creating or modifying any resource, retain the previously deployed stack state unchanged, and surface the CloudFormation import error identifying the missing export name.
4. IF an export produced by one template is actively imported by another template, THEN THE Infrastructure_System SHALL reject any deployment operation that would delete or modify that export and surface an error indicating the export is in use.
5. WHEN two or more templates are deployed within the same Environment, THE Infrastructure_System SHALL ensure each export name is unique within that Environment, and IF a duplicate export name is detected, THEN THE Infrastructure_System SHALL fail the deployment and surface an error indicating the conflicting export name.

### Requirement 7: Per-Environment Parameter Files

**User Story:** As a platform engineer, I want per-environment parameter files, so that dev and prod deploy with distinct configuration from the same templates.

#### Acceptance Criteria

1. THE Infrastructure_System SHALL provide exactly one Parameter_File under `parameters/dev/` for each template deployed by the Deploy_Workflow.
2. THE Infrastructure_System SHALL provide exactly one Parameter_File under `parameters/prod/` for each template deployed by the Deploy_Workflow.
3. THE Infrastructure_System SHALL store parameter values in a format consumable by the AWS CloudFormation deployment command used by the Deploy_Workflow.
4. WHEN an Environment is selected for deployment, THE Deploy_Workflow SHALL use the Parameter_File located under the directory matching that Environment for the template being deployed.
5. IF no Parameter_File matching the selected Environment exists for the template being deployed, THEN THE Deploy_Workflow SHALL halt the deployment without applying changes and return an error indicating the missing Parameter_File.

### Requirement 8: Continuous Integration Validation

**User Story:** As a platform engineer, I want templates validated and security-scanned on pull requests, so that defects and insecure patterns are caught before merge.

#### Acceptance Criteria

1. WHEN a pull request targeting the default branch is opened or updated, THE CI_Workflow SHALL run cfn-lint against every template file under `templates/` and its subdirectories, including zero templates as a successful no-op.
2. WHEN a pull request targeting the default branch is opened or updated, THE CI_Workflow SHALL run cfn-nag against every template file under `templates/` and its subdirectories, including zero templates as a successful no-op.
3. IF cfn-lint reports one or more findings of severity error, THEN THE CI_Workflow SHALL complete with a failing status and report each finding with its template file path and location.
4. IF cfn-nag reports one or more failing findings, THEN THE CI_Workflow SHALL complete with a failing status and report each finding with its template file path and rule identifier.
5. IF cfn-lint and cfn-nag both complete with no error-severity findings and no failing findings across all scanned templates, THEN THE CI_Workflow SHALL complete with a passing status.
6. IF the CI_Workflow does not complete within 15 minutes of being triggered, THEN THE CI_Workflow SHALL terminate execution and complete with a failing status.

### Requirement 9: Manual Infrastructure Deployment

**User Story:** As a platform engineer, I want a manually triggered deployment workflow, so that I can deploy the infrastructure layers to a chosen environment on demand.

#### Acceptance Criteria

1. WHEN the Deploy_Workflow is manually triggered with a selected Environment, THE Deploy_Workflow SHALL deploy the VPC_Template, Security_Group_Template, ALB_Template, and Cluster_Template in the order VPC_Template first, then Security_Group_Template, then ALB_Template, then Cluster_Template, deploying each subsequent template only after the preceding template reaches a successfully deployed state.
2. THE Deploy_Workflow SHALL accept the target Environment as a manual input constrained to exactly one of the values `dev` or `prod`.
3. IF the Deploy_Workflow is triggered with an Environment input that is not exactly `dev` or `prod`, THEN THE Deploy_Workflow SHALL reject the trigger, complete with a failing status, and deploy no template.
4. WHEN the Deploy_Workflow begins execution, THE Deploy_Workflow SHALL authenticate to AWS and complete authentication successfully before initiating deployment of any template.
5. IF AWS authentication fails, THEN THE Deploy_Workflow SHALL complete with a failing status, deploy no template, and provide an indication that authentication failed.
6. IF the deployment of any template fails, THEN THE Deploy_Workflow SHALL complete with a failing status, stop deploying all subsequent templates in the dependency order, and provide an indication identifying the template that failed.

### Requirement 10: Dispatch-Triggered Deployment

**User Story:** As a platform engineer, I want a deployment workflow triggered by an upstream image-build repository, so that a newly pushed web-app container image is automatically deployed to the web-app service stack.

#### Acceptance Criteria

1. WHEN the Dispatch_Workflow receives a repository dispatch event of the configured event type, THE Dispatch_Workflow SHALL update the Web_App_Service_Stack from the Service_Template using the values in the dispatch event payload.
2. THE Dispatch_Workflow SHALL update only the Web_App_Service_Stack and SHALL leave the VPC, security group, ALB, and cluster stacks unchanged.
3. THE Dispatch_Workflow SHALL read the target Environment and the container image URI from the dispatch event payload, where the container image URI references an image stored in ECR.
4. THE Dispatch_Workflow SHALL authenticate to AWS before updating the Web_App_Service_Stack.
5. IF the target Environment value in the dispatch event payload is not one of `dev` or `prod`, THEN THE Dispatch_Workflow SHALL complete with a failing status.
6. IF the dispatch event payload omits a required value, THEN THE Dispatch_Workflow SHALL complete with a failing status.
7. IF authentication to AWS fails, THEN THE Dispatch_Workflow SHALL complete with a failing status.
