import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import yaml from "js-yaml";
import { parseCfnYaml } from "./cfn-schema.js";

/**
 * Shared artifact-parsing model for the property-based test harness.
 *
 * This module loads and parses every repository artifact the correctness
 * properties (Properties 1-11) quantify over:
 *
 *   - the five CloudFormation templates (`templates/00..04-*.yml`)
 *   - the per-environment parameter files (`parameters/{dev,prod}/*.json`)
 *   - the three GitHub Actions workflows (`.github/workflows/*.yml`)
 *
 * It exposes typed, in-memory models plus helper functions so tests can reason
 * about parameters + constraints, resources, exports, `Fn::ImportValue` edges,
 * parameter-file keys, workflow triggers, deploy steps, and the dispatch
 * payload-validation logic — without re-parsing YAML in each test.
 */

// ---------------------------------------------------------------------------
// Repository path resolution
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repo root is two levels up from test/harness/. */
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const TEMPLATES_DIR = path.join(REPO_ROOT, "templates");
export const PARAMETERS_DIR = path.join(REPO_ROOT, "parameters");
export const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");

/** The environments the infrastructure supports. */
export const ENVIRONMENTS = ["dev", "prod"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/**
 * The templates deployed by the manual Deploy_Workflow, in dependency order.
 * The service template (04) is deployed separately via the dispatch workflow.
 */
export const DEPLOY_ORDER = [
  "00-vpc",
  "01-security-groups",
  "02-alb",
  "03-ecs-cluster",
] as const;

/** All five template basenames (without extension), in layer order. */
export const ALL_TEMPLATE_NAMES = [
  ...DEPLOY_ORDER,
  "04-ecs-service",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Constraints declared on a single CloudFormation parameter. */
export interface ParameterConstraints {
  Type?: string;
  Default?: unknown;
  AllowedValues?: unknown[];
  AllowedPattern?: string;
  MinValue?: number;
  MaxValue?: number;
  MinLength?: number;
  MaxLength?: number;
  ConstraintDescription?: string;
}

/** A parsed template parameter: its name plus declared constraints. */
export interface TemplateParameter extends ParameterConstraints {
  name: string;
}

/** A parsed template resource. */
export interface TemplateResource {
  logicalId: string;
  type: string;
  properties: Record<string, unknown>;
  /** Raw resource node (includes Condition, DependsOn, etc.). */
  raw: Record<string, unknown>;
}

/** A parsed template output/export. */
export interface TemplateOutput {
  /** Output logical id. */
  logicalId: string;
  /** Raw value expression. */
  value: unknown;
  /**
   * The unresolved export-name expression from `Export.Name`, or undefined if
   * this output is not exported. Typically `{ "Fn::Sub": "${Environment}-X" }`.
   */
  exportNameExpr?: unknown;
}

/** The typed model for one CloudFormation template. */
export interface TemplateModel {
  /** Basename without extension, e.g. "00-vpc". */
  name: string;
  /** File name, e.g. "00-vpc.yml". */
  file: string;
  /** Absolute path on disk. */
  filePath: string;
  /** Parsed parameters keyed by name. */
  parameters: Record<string, TemplateParameter>;
  /** Parsed resources keyed by logical id. */
  resources: Record<string, TemplateResource>;
  /** Parsed outputs (only those with an Export are also "exports"). */
  outputs: TemplateOutput[];
  /** Every `Fn::ImportValue` name referenced anywhere in the template. */
  importNames: string[];
  /** The complete parsed template tree (Rules section, Conditions, etc.). */
  raw: Record<string, unknown>;
}

/** The parsed model for one parameter file. */
export interface ParameterFileModel {
  environment: Environment;
  /** Template basename the file targets, e.g. "00-vpc". */
  template: string;
  file: string;
  filePath: string;
  /** Flat Key -> Value map. */
  values: Record<string, string>;
  /** Just the keys, for Property 8. */
  keys: string[];
}

/** A single `aws cloudformation deploy` action discovered in a workflow. */
export interface DeployAction {
  /** Job id the action belongs to. */
  jobId: string;
  /** Step name (or index label). */
  stepName: string;
  /** Template basename the deploy targets, e.g. "00-vpc", or undefined. */
  template?: string;
  /** Raw `--template-file` argument text, if found. */
  templateFileArg?: string;
}

/** Parsed workflow model. */
export interface WorkflowModel {
  /** Basename without extension, e.g. "deploy-infra". */
  name: string;
  file: string;
  filePath: string;
  /** Workflow `name:` field. */
  displayName?: string;
  /** The `on:` triggers, as a normalized object. */
  triggers: Record<string, unknown>;
  /** Trigger event names, e.g. ["pull_request"], ["workflow_dispatch"]. */
  triggerNames: string[];
  /** Parsed jobs keyed by job id. */
  jobs: Record<string, WorkflowJob>;
  /** All `aws cloudformation deploy` actions, in document order. */
  deployActions: DeployAction[];
  /** The complete parsed workflow tree. */
  raw: Record<string, unknown>;
}

/** Parsed workflow job. */
export interface WorkflowJob {
  id: string;
  /** timeout-minutes, if set. */
  timeoutMinutes?: number;
  /** job-level `needs`, normalized to an array. */
  needs: string[];
  /** Parsed steps in order. */
  steps: WorkflowStep[];
  raw: Record<string, unknown>;
}

/** Parsed workflow step. */
export interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  continueOnError: boolean;
  raw: Record<string, unknown>;
}

/**
 * A single logical export: which template produces it and the environment-
 * independent logical name (the `${Environment}-` prefix stripped).
 */
export interface ExportEntry {
  /** Producing template basename. */
  template: string;
  /** Output logical id. */
  logicalId: string;
  /**
   * The logical export name with the `${Environment}-` prefix removed, e.g.
   * "VpcId", "AlbSecurityGroupId". This is what a resolved name equals once the
   * env prefix is applied.
   */
  logicalName: string;
  /** The raw `Export.Name` expression. */
  rawExpr: unknown;
}

/** A cross-stack import edge: a consumer importing a produced export. */
export interface ImportEdge {
  /** Consuming template basename. */
  consumer: string;
  /** The imported logical name (env prefix stripped), e.g. "VpcId". */
  logicalName: string;
  /** The raw imported-name expression. */
  rawExpr: unknown;
}

/** The complete parsed artifact model. */
export interface ArtifactModel {
  templates: Record<string, TemplateModel>;
  parameterFiles: ParameterFileModel[];
  workflows: Record<string, WorkflowModel>;
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve an `Fn::Sub` expression of the form "${Environment}-Suffix" (or the
 * long-form list variant) to its literal suffix, given the value of
 * `Environment`. If the expression is a plain string it is returned as-is with
 * `${Environment}` substituted. Returns undefined if it cannot be resolved.
 *
 * This is deliberately narrow: it only handles the export/import naming
 * pattern this codebase uses (a Sub over the Environment parameter), which is
 * all Properties 2-4 need.
 */
export function resolveEnvSub(expr: unknown, environment: string): string | undefined {
  let template: string | undefined;

  if (typeof expr === "string") {
    template = expr;
  } else if (isObject(expr) && "Fn::Sub" in expr) {
    const sub = expr["Fn::Sub"];
    if (typeof sub === "string") {
      template = sub;
    } else if (Array.isArray(sub) && typeof sub[0] === "string") {
      // [ "template", { vars } ] form — we only substitute Environment.
      template = sub[0];
    }
  }

  if (template === undefined) return undefined;

  // Substitute ${Environment} (and ${AWS::...} left intact if present).
  return template.replace(/\$\{Environment\}/g, environment);
}

/**
 * Given an `Export.Name` or `Fn::ImportValue` expression that uses the
 * `${Environment}-<Logical>` convention, extract the environment-independent
 * logical name (everything after the first `${Environment}-`). If the
 * expression does not use the convention, returns the resolved dev name as a
 * fallback logical key.
 */
export function extractLogicalName(expr: unknown): string | undefined {
  // Resolve with a sentinel so we can strip the prefix deterministically.
  const sentinel = "\u0000ENV\u0000";
  const resolved = resolveEnvSub(expr, sentinel);
  if (resolved === undefined) return undefined;

  const marker = `${sentinel}-`;
  const idx = resolved.indexOf(marker);
  if (idx === -1) {
    // No env prefix; treat the whole resolved string as the logical name.
    return resolved.replace(sentinel, "");
  }
  return resolved.slice(idx + marker.length);
}

/**
 * Recursively collect every `Fn::ImportValue` argument expression in a tree.
 */
function collectImportExprs(node: unknown, out: unknown[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectImportExprs(item, out);
    return;
  }
  if (isObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "Fn::ImportValue") {
        out.push(value);
      }
      collectImportExprs(value, out);
    }
  }
}

// ---------------------------------------------------------------------------
// Template parsing
// ---------------------------------------------------------------------------

function parseTemplate(name: string): TemplateModel {
  const file = `${name}.yml`;
  const filePath = path.join(TEMPLATES_DIR, file);
  const raw = parseCfnYaml(readFileSync(filePath, "utf8")) as Record<string, unknown>;

  // --- parameters ---
  const parameters: Record<string, TemplateParameter> = {};
  const rawParams = isObject(raw.Parameters) ? raw.Parameters : {};
  for (const [paramName, paramDef] of Object.entries(rawParams)) {
    const def = isObject(paramDef) ? paramDef : {};
    parameters[paramName] = {
      name: paramName,
      Type: typeof def.Type === "string" ? def.Type : undefined,
      Default: def.Default,
      AllowedValues: Array.isArray(def.AllowedValues) ? def.AllowedValues : undefined,
      AllowedPattern: typeof def.AllowedPattern === "string" ? def.AllowedPattern : undefined,
      MinValue: typeof def.MinValue === "number" ? def.MinValue : undefined,
      MaxValue: typeof def.MaxValue === "number" ? def.MaxValue : undefined,
      MinLength: typeof def.MinLength === "number" ? def.MinLength : undefined,
      MaxLength: typeof def.MaxLength === "number" ? def.MaxLength : undefined,
      ConstraintDescription:
        typeof def.ConstraintDescription === "string"
          ? def.ConstraintDescription
          : undefined,
    };
  }

  // --- resources ---
  const resources: Record<string, TemplateResource> = {};
  const rawResources = isObject(raw.Resources) ? raw.Resources : {};
  for (const [logicalId, resDef] of Object.entries(rawResources)) {
    const def = isObject(resDef) ? resDef : {};
    resources[logicalId] = {
      logicalId,
      type: typeof def.Type === "string" ? def.Type : "",
      properties: isObject(def.Properties) ? def.Properties : {},
      raw: def,
    };
  }

  // --- outputs / exports ---
  const outputs: TemplateOutput[] = [];
  const rawOutputs = isObject(raw.Outputs) ? raw.Outputs : {};
  for (const [logicalId, outDef] of Object.entries(rawOutputs)) {
    const def = isObject(outDef) ? outDef : {};
    let exportNameExpr: unknown;
    if (isObject(def.Export) && "Name" in def.Export) {
      exportNameExpr = def.Export.Name;
    }
    outputs.push({ logicalId, value: def.Value, exportNameExpr });
  }

  // --- import names (env prefix stripped, deduped) ---
  const importExprs: unknown[] = [];
  collectImportExprs(raw, importExprs);
  const importNames = Array.from(
    new Set(
      importExprs
        .map((expr) => extractLogicalName(expr))
        .filter((n): n is string => typeof n === "string"),
    ),
  );

  return { name, file, filePath, parameters, resources, outputs, importNames, raw };
}

// ---------------------------------------------------------------------------
// Parameter-file parsing
// ---------------------------------------------------------------------------

function parseParameterFiles(): ParameterFileModel[] {
  const models: ParameterFileModel[] = [];

  for (const environment of ENVIRONMENTS) {
    const dir = path.join(PARAMETERS_DIR, environment);
    if (!existsSync(dir)) continue;

    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const filePath = path.join(dir, file);
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      const values: Record<string, string> = {};
      if (isObject(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          values[key] = String(value);
        }
      }
      models.push({
        environment,
        template: file.replace(/\.json$/, ""),
        file,
        filePath,
        values,
        keys: Object.keys(values),
      });
    }
  }

  return models;
}

// ---------------------------------------------------------------------------
// Workflow parsing
// ---------------------------------------------------------------------------

/**
 * Extract the template basename a deploy command targets from its shell script.
 *
 * Handles three authoring styles seen in the workflows:
 *   1. a literal path:      `--template-file templates/04-ecs-service.yml`
 *   2. a `${TEMPLATE}.yml` expansion driven by `TEMPLATE="00-vpc"`
 *   3. a `${TEMPLATE}` path expansion driven by `TEMPLATE="templates/04-...yml"`
 */
function templateFromDeployScript(script: string): { template?: string; arg?: string } {
  /** Resolve a raw `--template-file` argument to a `NN-name` basename. */
  const toBasename = (raw: string): string | undefined => {
    const base = path.basename(raw).replace(/\.ya?ml$/i, "");
    return /^\d\d-[a-z0-9-]+$/i.test(base) ? base : undefined;
  };

  /** Find a `TEMPLATE=...` assignment and resolve its basename. */
  const fromTemplateVar = (): string | undefined => {
    const tvar = script.match(/TEMPLATE=["']?([^\s"']+)["']?/);
    if (!tvar) return undefined;
    return toBasename(tvar[1]);
  };

  const match = script.match(/--template-file\s+["']?([^\s"'\\]+)/);
  if (!match) {
    return { template: fromTemplateVar() };
  }

  const arg = match[1];
  // If the argument references a shell variable, resolve via the assignment.
  if (arg.includes("$")) {
    return { template: fromTemplateVar(), arg };
  }
  return { template: toBasename(arg), arg };
}

function parseWorkflow(file: string): WorkflowModel {
  const name = file.replace(/\.ya?ml$/i, "");
  const filePath = path.join(WORKFLOWS_DIR, file);
  // Workflows are plain YAML but harmless to parse with the CFN schema too.
  const raw = yaml.load(readFileSync(filePath, "utf8")) as Record<string, unknown>;

  const displayName = typeof raw.name === "string" ? raw.name : undefined;

  // NOTE: YAML parses the bare key `on` as the boolean `true`. Handle both.
  const onNode = (raw as Record<string, unknown>).on ?? (raw as Record<string, unknown>)[
    true as unknown as string
  ];
  let triggers: Record<string, unknown> = {};
  let triggerNames: string[] = [];
  if (isObject(onNode)) {
    triggers = onNode;
    triggerNames = Object.keys(onNode);
  } else if (typeof onNode === "string") {
    triggerNames = [onNode];
  } else if (Array.isArray(onNode)) {
    triggerNames = onNode.filter((t): t is string => typeof t === "string");
  }

  const jobs: Record<string, WorkflowJob> = {};
  const deployActions: DeployAction[] = [];
  const rawJobs = isObject(raw.jobs) ? raw.jobs : {};

  for (const [jobId, jobDef] of Object.entries(rawJobs)) {
    const def = isObject(jobDef) ? jobDef : {};
    const needs = Array.isArray(def.needs)
      ? def.needs.filter((n): n is string => typeof n === "string")
      : typeof def.needs === "string"
        ? [def.needs]
        : [];

    const steps: WorkflowStep[] = [];
    const rawSteps = Array.isArray(def.steps) ? def.steps : [];
    for (const stepDef of rawSteps) {
      const s = isObject(stepDef) ? stepDef : {};
      const step: WorkflowStep = {
        name: typeof s.name === "string" ? s.name : undefined,
        uses: typeof s.uses === "string" ? s.uses : undefined,
        run: typeof s.run === "string" ? s.run : undefined,
        continueOnError: s["continue-on-error"] === true,
        raw: s,
      };
      steps.push(step);

      // Detect `aws cloudformation deploy` actions in the step's run script.
      if (step.run && /aws\s+cloudformation\s+deploy/.test(step.run)) {
        const { template, arg } = templateFromDeployScript(step.run);
        deployActions.push({
          jobId,
          stepName: step.name ?? `${jobId}#${steps.length - 1}`,
          template,
          templateFileArg: arg,
        });
      }
    }

    jobs[jobId] = {
      id: jobId,
      timeoutMinutes:
        typeof def["timeout-minutes"] === "number" ? def["timeout-minutes"] : undefined,
      needs,
      steps,
      raw: def,
    };
  }

  return {
    name,
    file,
    filePath,
    displayName,
    triggers,
    triggerNames,
    jobs,
    deployActions,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Model construction
// ---------------------------------------------------------------------------

let cachedModel: ArtifactModel | undefined;

/** Build (and cache) the full artifact model by parsing all artifacts. */
export function loadArtifactModel(): ArtifactModel {
  if (cachedModel) return cachedModel;

  const templates: Record<string, TemplateModel> = {};
  for (const name of ALL_TEMPLATE_NAMES) {
    templates[name] = parseTemplate(name);
  }

  const parameterFiles = parseParameterFiles();

  const workflows: Record<string, WorkflowModel> = {};
  const workflowFiles = existsSync(WORKFLOWS_DIR)
    ? readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/i.test(f))
    : [];
  for (const file of workflowFiles) {
    const wf = parseWorkflow(file);
    workflows[wf.name] = wf;
  }

  cachedModel = { templates, parameterFiles, workflows };
  return cachedModel;
}

// ---------------------------------------------------------------------------
// Helper queries (the substrate Properties 1-11 quantify over)
// ---------------------------------------------------------------------------

/** All exports declared across every template, one entry per Output.Export. */
export function listExports(model: ArtifactModel = loadArtifactModel()): ExportEntry[] {
  const entries: ExportEntry[] = [];
  for (const template of Object.values(model.templates)) {
    for (const output of template.outputs) {
      if (output.exportNameExpr === undefined) continue;
      const logicalName = extractLogicalName(output.exportNameExpr);
      if (logicalName === undefined) continue;
      entries.push({
        template: template.name,
        logicalId: output.logicalId,
        logicalName,
        rawExpr: output.exportNameExpr,
      });
    }
  }
  return entries;
}

/** Every cross-stack import edge across all templates. */
export function listImportEdges(model: ArtifactModel = loadArtifactModel()): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const template of Object.values(model.templates)) {
    for (const logicalName of template.importNames) {
      edges.push({ consumer: template.name, logicalName, rawExpr: undefined });
    }
  }
  return edges;
}

/**
 * Resolve an export's name for a given environment, e.g. logical "VpcId" in
 * "dev" => "dev-VpcId". Uses the raw expression so it honors the actual
 * `${Environment}-` convention in the template.
 */
export function resolveExportName(entry: ExportEntry, environment: Environment): string | undefined {
  return resolveEnvSub(entry.rawExpr, environment);
}

/** The producer template for a given logical export name, if any. */
export function producerOf(
  logicalName: string,
  model: ArtifactModel = loadArtifactModel(),
): string | undefined {
  return listExports(model).find((e) => e.logicalName === logicalName)?.template;
}

/** The manual deploy order as declared by deploy-infra.yml, in step order. */
export function getDeployOrder(model: ArtifactModel = loadArtifactModel()): string[] {
  const wf = model.workflows["deploy-infra"];
  if (!wf) return [];
  return wf.deployActions
    .map((a) => a.template)
    .filter((t): t is string => typeof t === "string");
}

/** Every template a workflow's deploy actions target (deduped). */
export function deployTargets(
  workflowName: string,
  model: ArtifactModel = loadArtifactModel(),
): string[] {
  const wf = model.workflows[workflowName];
  if (!wf) return [];
  return Array.from(
    new Set(
      wf.deployActions
        .map((a) => a.template)
        .filter((t): t is string => typeof t === "string"),
    ),
  );
}

/**
 * The dispatch workflow's payload-validation logic, distilled to a predicate
 * over a synthetic `client_payload`. This mirrors the shell validation in
 * deploy-dispatch.yml: accept iff `environment` is a non-empty value in
 * {dev, prod} and `image_uri` is non-empty. Used by Property 11.
 */
export function dispatchPayloadAccepts(payload: {
  environment?: unknown;
  image_uri?: unknown;
}): boolean {
  const env = payload.environment;
  const image = payload.image_uri;
  const envOk = typeof env === "string" && (env === "dev" || env === "prod");
  const imageOk = typeof image === "string" && image.length > 0;
  return envOk && imageOk;
}

/** Reset the cached model (useful for tests that mutate the filesystem). */
export function resetModelCache(): void {
  cachedModel = undefined;
}
