# Local validation for the AWS ECS CloudFormation infrastructure.
#
# Targets:
#   make lint      - run cfn-lint over templates/
#   make scan      - run cfn-nag over templates/
#   make test      - run the TypeScript property-based test harness
#   make validate  - run all three (lint + scan + test)
#
# Prerequisites:
#   - Node.js 20+ and npm      (test harness)
#   - cfn-lint                 (pip install cfn-lint)
#   - cfn-nag                  (gem install cfn-nag)

TEMPLATES_DIR := templates

.PHONY: lint scan test validate help

help:
	@echo "Targets: lint, scan, test, validate"

lint:
	cfn-lint $(TEMPLATES_DIR)/

scan:
	cfn_nag_scan --input-path $(TEMPLATES_DIR)/

test:
	npm test

validate: lint scan test
