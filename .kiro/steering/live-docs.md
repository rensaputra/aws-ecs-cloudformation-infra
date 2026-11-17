---
inclusion: always
---

# Live Documentation & Grounding Rules

Before writing code, suggesting CLI commands, or configuring infrastructure involving third-party frameworks, libraries, or AWS services, you MUST verify current APIs and syntax using the connected MCP documentation servers rather than relying solely on training memory.

## 1. Third-Party Frameworks & Libraries (`context7`)
- **When to trigger:** Any time the task involves external libraries, SDKs, or frameworks (e.g., React, TypeScript, Spring Boot, Next.js, Node.js packages).
- **Required workflow:**
  1. Call `resolve-library-id` with the exact package or framework name to get its Context7 library ID.
  2. Call `get-library-docs` using that ID and a focused topic query matching the specific feature, hook, annotation, or configuration being implemented.
  3. Match the exact version specified in the project's `package.json`, `pom.xml`, `build.gradle`, or `tech.md`.

## 2. AWS Services, IAM & Infrastructure (`aws-docs`)
- **When to trigger:** Any time the task involves AWS services, CloudFormation/SAM/CDK templates, AWS SDK v2/v3 calls, IAM policies, or AWS CLI commands.
- **Required workflow:**
  1. Call `search_documentation` to locate the official AWS documentation page for the relevant service or API.
  2. Call `read_documentation` on the top matching URL(s) to confirm current parameter names, defaults, quotas, and best practices before generating code or templates.

## 3. Conflict Resolution & Fallbacks
- **Version priority:** Always prioritize the library/SDK version pinned in the local workspace over the latest upstream release unless asked to upgrade.
- **Tool unavailability:** If an MCP server is disconnected or returns no results, explicitly state that you are falling back to baseline knowledge and flag any APIs that should be double-checked.