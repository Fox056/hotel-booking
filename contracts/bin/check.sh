#!/usr/bin/env bash
# Checks the contracts. Run from any directory: bash contracts/bin/check.sh
#
# Steps:
#   1. Names of the top-level directories in contracts/ are not prefixes of
#      each other: the response validator relates paths by string prefix.
#   2. Lint of every openapi/*.yaml and asyncapi/*.yaml. Any problem, error or
#      warning, fails, and so does an empty openapi/ or asyncapi/.
#   3. Control fixtures produce no problems at all.
#   4. Every violating fixture fails with its own rule, and no rule fires on it
#      that the fixture does not declare.
#   5. Every own rule - rule/* in redocly.yaml and contracts/* in
#      lint/plugin.js - is enabled and has at least one fixture.
#   6. Every message of asyncapi/*.yaml has an example, and every example
#      matches its schema. Redocly 2.60.0 does not check examples of AsyncAPI,
#      so the step bundles each document with every $ref resolved, puts the
#      examples into an OpenAPI 3.1 document in /tmp and lints it with
#      no-invalid-media-type-examples, the rule that checks the examples of the
#      OpenAPI documents. The step tests itself on tests/examples/*.yaml: every
#      example there breaks its schema, and each must be reported.
# Problems suppressed by an ignore file (.redocly.lint-ignore.yaml) fail
# steps 2-4 and 6 as well: an ignore file must not make the run green.
#
# Fixtures are tests/rules/*.yaml:
#   <prefix>--<rule>--<case>.yaml  violates rule <prefix>/<rule>, where <prefix>
#                                  is "rule" for a configurable rule and
#                                  "contracts" for a rule of the plugin, and
#                                  <case> names the violation, in kebab-case;
#   valid--<case>.yaml             control fixture, no problems allowed.
# A violating fixture may declare other rules that fire on it too, in a line
#   # also-fires: <rule>, <rule>
# Fixture helpers that only fixtures reference live in tests/openapi and
# tests/schemas, at the same relative paths as the real files.
#
# A fixture fails when its lint has at least one error, the condition on which
# `redocly lint` exits with a non-zero code. All fixtures are linted in one run
# with --format=json, and node in the same image reads the report.
#
# Redocly CLI 2.60.0 runs from Docker, pinned by digest, isolated: no network,
# no capabilities, a read-only root file system with a tmpfs /tmp, and the
# unprivileged user nobody; contracts/ is mounted read-only. In Git Bash on
# Windows MSYS_NO_PATHCONV=1 keeps the paths in docker arguments as they are,
# and the volume path comes from `pwd -W`.
set -euo pipefail

readonly IMAGE='redocly/cli:2.60.0@sha256:309a2bf4f7474b76258e144ff3633ef3f2073d83d1048daa142d1aa3743e950c'

contracts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mount_dir="$(cd "$contracts_dir" && { pwd -W 2>/dev/null || pwd; })"
export MSYS_NO_PATHCONV=1

echo '== 1. Top-level directory names in contracts/'
step1=ok
names=()
for dir in "$contracts_dir"/*/; do
  names+=("$(basename "$dir")")
done
for a in "${names[@]}"; do
  for b in "${names[@]}"; do
    if [[ "$a" != "$b" && "$b" == "$a"* ]]; then
      echo "FAIL: '$a' is a prefix of '$b'"
      step1=fail
    fi
  done
done
if [[ "$step1" == ok ]]; then
  echo "ok: ${names[*]}"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo 'FAIL: docker is not found; steps 2-5 need it' >&2
  exit 2
fi

# Steps 2-5 run in one container; the script below comes through stdin.
docker run --rm -i \
  --network none \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --read-only \
  --tmpfs /tmp \
  --user 65534:65534 \
  -e HOME=/tmp \
  -e REDOCLY_TELEMETRY=off \
  -e REDOCLY_SUPPRESS_UPDATE_NOTICE=true \
  -e STEP1="$step1" \
  -v "$mount_dir:/spec:ro" \
  -w /spec \
  --entrypoint node \
  "$IMAGE" - <<'NODE'
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = '/spec';
const ASYNCAPI = 'asyncapi';
const DOCUMENT_DIRS = ['openapi', ASYNCAPI];
const FIXTURES = 'tests/rules';
const EXAMPLE_TESTS = 'tests/examples';
const failed = [];
if (process.env.STEP1 !== 'ok') {
  failed.push('1. directory names');
}

function run(args) {
  const result = spawnSync('redocly', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (result.error) {
    throw result.error;
  }
  return result;
}

// `redocly lint --format=json` prints one JSON report per file, back to back.
function splitReports(text) {
  const reports = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
    } else if (c === '"') {
      inString = true;
    } else if (c === '{') {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        reports.push(JSON.parse(text.slice(start, i + 1)));
      }
    }
  }
  return reports;
}

// Lints `files` in one run. Returns one report per file, or undefined if
// Redocly stopped early, for example on a YAML syntax error or a broken config;
// then it prints the file it stopped at and why.
function lint(files) {
  const result = run(['lint', '--config', 'redocly.yaml', '--lint-config=error', '--format=json',
    '--max-problems=100000', ...files]);
  const reports = splitReports(result.stdout);
  if (reports.length === files.length) {
    return reports;
  }
  const lines = result.stderr.split('\n');
  const last = lines.map((line) => line.startsWith('validating ')).lastIndexOf(true);
  const reason = lines.slice(last + 1).filter((line) => line.trim() !== '' && !/: validated in /.test(line));
  console.log(`FAIL: Redocly stopped at ${files[reports.length] ?? 'the config'}, ${reports.length} of ${files.length} files linted:`);
  reason.forEach((line) => console.log(`  ${line}`));
  return undefined;
}

function formatProblem(problem) {
  const at = problem.location && problem.location[0];
  const where = at ? `${at.source.ref}:${at.start ? `${at.start.line}:${at.start.col}` : '?'}` : '?';
  return `  ${where}  ${problem.severity}  ${problem.ruleId}  ${problem.message.replace(/\s+/g, ' ')}`;
}

function section(title) {
  console.log(`\n== ${title}`);
}

console.log(`Redocly CLI ${run(['--version']).stdout.trim()}`);

// Problems hidden by an ignore file are reported only as a count.
function ignoredNote(report) {
  return report.totals.ignored > 0 ? `, ${report.totals.ignored} ignored by an ignore file` : '';
}

// --- Step 2 ---
section(`2. Lint of ${DOCUMENT_DIRS.map((dir) => `${dir}/*.yaml`).join(' and ')}`);
let step2 = true;
const documents = [];
for (const dir of DOCUMENT_DIRS) {
  const dirPath = path.join(ROOT, dir);
  const files = fs.existsSync(dirPath) ? fs.readdirSync(dirPath).sort() : [];
  const found = files.filter((file) => file.endsWith('.yaml')).map((file) => `${dir}/${file}`);
  if (found.length === 0) {
    console.log(`FAIL: ${dir}/ has no *.yaml documents`);
    step2 = false;
  }
  // A document in another form would escape every check.
  for (const file of files.filter((item) => !item.endsWith('.yaml'))) {
    console.log(`FAIL: ${dir}/${file}: only *.yaml documents may lie here, and only they are checked`);
    step2 = false;
  }
  documents.push(...found);
}
// A contract never references the helpers of the tests: pointed at a stub in
// tests/, it would be checked against the stub instead of itself.
for (const dir of [...DOCUMENT_DIRS, 'schemas']) {
  const dirPath = path.join(ROOT, dir);
  for (const file of fs.existsSync(dirPath) ? fs.readdirSync(dirPath).sort() : []) {
    if (/\$ref['"]?\s*:\s*['"]?[^'"\s]*tests\//.test(fs.readFileSync(path.join(dirPath, file), 'utf8'))) {
      console.log(`FAIL: ${dir}/${file}: a $ref leads into tests/, the helpers of the tests`);
      step2 = false;
    }
  }
}
if (documents.length > 0) {
  const reports = lint(documents);
  if (reports === undefined) {
    step2 = false;
  } else {
    reports.forEach((report, index) => {
      const { errors, warnings, ignored } = report.totals;
      const clean = errors === 0 && warnings === 0 && ignored === 0;
      console.log(`${clean ? 'ok' : 'FAIL'}: ${documents[index]}: ${errors} errors, ${warnings} warnings${ignoredNote(report)}`);
      report.problems.forEach((problem) => console.log(formatProblem(problem)));
      step2 = step2 && clean;
    });
  }
}
if (!step2) {
  failed.push('2. lint of the contract documents');
}

// --- Fixtures ---
const NAME = /^(rule|contracts)--([a-z0-9]+(?:-[a-z0-9]+)*)--([a-z0-9]+(?:-[a-z0-9]+)*)\.yaml$/;
const CONTROL = /^valid--[a-z0-9]+(?:-[a-z0-9]+)*\.yaml$/;
const files = fs.readdirSync(path.join(ROOT, FIXTURES)).filter((file) => /\.ya?ml$/.test(file)).sort();
const control = files.filter((file) => CONTROL.test(file));
const violating = [];
const misnamed = [];
for (const file of files) {
  const match = NAME.exec(file);
  if (match) {
    const text = fs.readFileSync(path.join(ROOT, FIXTURES, file), 'utf8');
    const also = [...text.matchAll(/^#\s*also-fires:\s*(.+)$/gm)]
      .flatMap((line) => line[1].split(',').map((rule) => rule.trim()).filter(Boolean));
    violating.push({ file, rule: `${match[1]}/${match[2]}`, also });
  } else if (!CONTROL.test(file)) {
    misnamed.push(file);
  }
}
// --- Step 3 ---
section('3. Control fixtures');
// One run for steps 3 and 4: control fixtures first, then the violating ones.
const linted = [...control, ...violating.map((fixture) => fixture.file)];
const reports = lint(linted.map((file) => `${FIXTURES}/${file}`));
const reportByFile = new Map(reports === undefined ? [] : linted.map((file, index) => [file, reports[index]]));
let step3 = reports !== undefined && control.length > 0;
if (control.length === 0) {
  console.log('FAIL: no control fixture valid--<case>.yaml');
}
for (const file of control) {
  const report = reportByFile.get(file);
  if (report === undefined) {
    continue;
  }
  const clean = report.problems.length === 0 && report.totals.ignored === 0;
  console.log(`${clean ? 'ok' : 'FAIL'}: ${file}${ignoredNote(report)}`);
  report.problems.forEach((problem) => console.log(formatProblem(problem)));
  step3 = step3 && clean;
}
if (!step3) {
  failed.push('3. control fixtures');
}

// --- Rules ---
const configText = fs.readFileSync(path.join(ROOT, 'redocly.yaml'), 'utf8');
const configured = new Set([...configText.matchAll(/^\s*((?:rule|contracts)\/[a-z0-9]+(?:-[a-z0-9]+)*):/gm)]
  .map((match) => match[1]));
const plugin = require(path.join(ROOT, 'lint/plugin.js'))();
// A rule of the plugin may be defined for OpenAPI and AsyncAPI under one name.
const pluginRules = [...new Set(Object.values(plugin.rules).flatMap((rules) => Object.keys(rules)))]
  .map((name) => `${plugin.id}/${name}`);
const configurableRules = [...configured].filter((rule) => rule.startsWith('rule/'));
const ownRules = [...configurableRules, ...pluginRules].sort();

// --- Step 4 ---
section('4. Violating fixtures');
let step4 = reports !== undefined && misnamed.length === 0;
if (reports === undefined) {
  console.log('FAIL: the fixtures were not linted, see step 3');
}
for (const file of misnamed) {
  console.log(`FAIL: ${file}: the name is neither <prefix>--<rule>--<case>.yaml nor valid--<case>.yaml`);
}
for (const fixture of violating) {
  const report = reportByFile.get(fixture.file);
  if (report === undefined) {
    continue;
  }
  const fired = [...new Set(report.problems.map((problem) => problem.ruleId))].sort();
  const own = report.problems.filter((problem) => problem.ruleId === fixture.rule);
  const reasons = [];
  if (!ownRules.includes(fixture.rule)) {
    reasons.push(`${fixture.rule} is not an own rule`);
  }
  if (own.length === 0) {
    reasons.push(`${fixture.rule} did not fire${fired.length > 0 ? `, only: ${fired.join(', ')}` : ', no rule fired'}`);
  } else if (!own.some((problem) => problem.severity === 'error')) {
    reasons.push(`${fixture.rule} fired as ${own[0].severity}, not as error`);
  }
  const unexpected = fired.filter((rule) => rule !== fixture.rule && !fixture.also.includes(rule));
  if (unexpected.length > 0) {
    reasons.push(`undeclared rules fired: ${unexpected.join(', ')}`);
  }
  if (report.totals.ignored > 0) {
    reasons.push(`${report.totals.ignored} ignored by an ignore file`);
  }
  const silent = fixture.also.filter((rule) => !fired.includes(rule));
  if (silent.length > 0) {
    reasons.push(`declared in also-fires but did not fire: ${silent.join(', ')}`);
  }
  if (reasons.length === 0) {
    console.log(`ok: ${fixture.file} -> ${fixture.rule}`);
  } else {
    console.log(`FAIL: ${fixture.file}: ${reasons.join('; ')}`);
    report.problems.forEach((problem) => console.log(formatProblem(problem)));
    step4 = false;
  }
}
if (!step4) {
  failed.push('4. violating fixtures');
}

// --- Step 5 ---
section('5. Rule coverage');
let step5 = true;
for (const rule of pluginRules.filter((item) => !configured.has(item))) {
  console.log(`FAIL: plugin rule ${rule} is not enabled in redocly.yaml`);
  step5 = false;
}
for (const rule of [...configured].filter((item) => item.startsWith('contracts/') && !pluginRules.includes(item))) {
  console.log(`FAIL: redocly.yaml enables ${rule}, which the plugin does not define`);
  step5 = false;
}
for (const rule of ownRules) {
  const count = violating.filter((fixture) => fixture.rule === rule).length;
  if (count === 0) {
    console.log(`FAIL: ${rule} has no fixture`);
    step5 = false;
  }
}
if (step5) {
  console.log(`ok: each of ${ownRules.length} own rules has a fixture`);
} else {
  failed.push('5. rule coverage');
}

// --- Step 6 ---
section(`6. Examples of the messages of ${ASYNCAPI}/*.yaml`);
const EXAMPLES_CONFIG = '/tmp/examples-redocly.yaml';
fs.writeFileSync(EXAMPLES_CONFIG, ['extends: []', 'telemetry: off', 'rules:', '  struct: error',
  '  no-invalid-media-type-examples:', '    severity: error', '    allowAdditionalProperties: false', ''].join('\n'));

// Checks the examples of the messages of the AsyncAPI documents `files`: each
// document is bundled with every $ref resolved, and its examples go into one
// OpenAPI 3.1 document, a path "/<n>" per example. Returns the problems of
// every example and the errors that prevented a check. The headers of an
// example are checked against the headers of its message; an example with
// headers for a message without them is a problem as well.
function checkExamples(files, tag) {
  const results = [];
  const errors = [];
  const paths = {};
  // The example that every path "/<n>" checks.
  const owners = [];
  const addCheck = (owner, schema, value) => {
    paths[`/${owners.length}`] = {
      get: {
        responses: {
          200: {
            description: 'Example of a message.',
            content: { 'application/json': { schema, example: value } },
          },
        },
      },
    };
    owners.push(owner);
  };
  for (const file of files) {
    const bundle = `/tmp/bundle-${tag}-${path.basename(file, '.yaml')}.json`;
    const bundled = run(['bundle', file, '--config', 'redocly.yaml', '--dereferenced', '--ext', 'json', '-o', bundle]);
    if (bundled.status !== 0 || !fs.existsSync(bundle)) {
      errors.push(`${file}: redocly bundle failed: ${`${bundled.stdout} ${bundled.stderr}`.replace(/\s+/g, ' ').trim()}`);
      continue;
    }
    const api = JSON.parse(fs.readFileSync(bundle, 'utf8'));
    for (const [channelName, channel] of Object.entries(api.channels || {})) {
      for (const [messageName, message] of Object.entries(channel.messages || {})) {
        const where = `${file}: channel ${channelName}, message ${messageName}`;
        const examples = Array.isArray(message.examples) ? message.examples : [];
        if (examples.length === 0) {
          errors.push(`${where}: no example`);
        }
        examples.forEach((example, index) => {
          const owner = { name: `${where}, example ${example.name ?? index}`, problems: [] };
          results.push(owner);
          addCheck(owner, message.payload, example.payload);
          if (example.headers !== undefined && message.headers === undefined) {
            owner.problems.push({ severity: 'error', ruleId: 'check.sh', message: 'Example has headers, but its message has none' });
          } else if (example.headers !== undefined) {
            addCheck(owner, message.headers, example.headers);
          }
        });
      }
    }
  }
  if (owners.length === 0) {
    return { results, errors };
  }
  const document = `/tmp/examples-${tag}.json`;
  fs.writeFileSync(document, JSON.stringify({ openapi: '3.1.0', info: { title: 'Examples of messages', version: '1' }, paths }));
  const result = run(['lint', '--config', EXAMPLES_CONFIG, '--lint-config=error', '--format=json', '--max-problems=100000',
    document]);
  const reports = splitReports(result.stdout);
  if (reports.length !== 1) {
    errors.push(`Redocly did not lint the examples: ${result.stderr.replace(/\s+/g, ' ').trim()}`);
    return { results, errors };
  }
  const [report] = reports;
  for (const problem of report.problems) {
    const pointer = problem.location && problem.location[0] ? problem.location[0].pointer : '';
    const match = /^#\/paths\/~1([0-9]+)(?:\/|$)/.exec(pointer);
    if (match && owners[Number(match[1])] !== undefined) {
      owners[Number(match[1])].problems.push(problem);
    } else {
      errors.push(`the document of examples: ${problem.ruleId} ${problem.message.replace(/\s+/g, ' ')}`);
    }
  }
  if (report.totals.ignored > 0) {
    errors.push(`${report.totals.ignored} problems ignored by an ignore file`);
  }
  return { results, errors };
}

function printProblems(problems) {
  problems.forEach((problem) => console.log(`  ${problem.severity}  ${problem.ruleId}  ${problem.message.replace(/\s+/g, ' ')}`));
}

let step6 = true;
const own = checkExamples(documents.filter((file) => file.startsWith(`${ASYNCAPI}/`)), 'documents');
for (const text of own.errors) {
  console.log(`FAIL: ${text}`);
  step6 = false;
}
for (const { name, problems } of own.results) {
  console.log(`${problems.length === 0 ? 'ok' : 'FAIL'}: ${name}`);
  printProblems(problems);
  step6 = step6 && problems.length === 0;
}
// The step tests itself: every example of every document in tests/examples
// breaks its schema, and each of them must be reported.
const exampleTests = fs.existsSync(path.join(ROOT, EXAMPLE_TESTS))
  ? fs.readdirSync(path.join(ROOT, EXAMPLE_TESTS)).filter((file) => file.endsWith('.yaml')).sort()
  : [];
if (exampleTests.length === 0) {
  console.log(`FAIL: ${EXAMPLE_TESTS}/ has no test of this step`);
  step6 = false;
}
exampleTests.forEach((file, index) => {
  const outcome = checkExamples([`${EXAMPLE_TESTS}/${file}`], `test-${index}`);
  const caught = outcome.errors.length === 0 && outcome.results.length > 0
    && outcome.results.every((item) => item.problems.length > 0);
  console.log(`${caught ? 'ok' : 'FAIL'}: ${EXAMPLE_TESTS}/${file}: ${caught ? 'every broken example is reported' : 'not every broken example is reported'}`);
  outcome.errors.forEach((text) => console.log(`  ${text}`));
  outcome.results.forEach(({ name, problems }) => {
    console.log(`  ${name}: ${problems.length} problems`);
    printProblems(problems);
  });
  step6 = step6 && caught;
});
if (!step6) {
  failed.push('6. examples of the messages');
}

// --- Summary ---
section('Summary');
console.log(`fixtures: ${control.length} control, ${violating.length} violating`);
console.log(`own rules: ${ownRules.length} (${configurableRules.length} configurable, ${pluginRules.length} plugin)`);
console.log(failed.length === 0 ? 'all steps passed' : `failed: ${failed.join('; ')}`);
process.exitCode = failed.length === 0 ? 0 : 1;
NODE
