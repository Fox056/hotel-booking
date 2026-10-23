#!/usr/bin/env bash
# Checks the contracts. Run from any directory: bash contracts/bin/check.sh
#
# Steps:
#   1. Names of the top-level directories in contracts/ are not prefixes of
#      each other: the response validator relates paths by string prefix.
#   2. Lint of every openapi/*.yaml and asyncapi/*.yaml. Any problem, error or
#      warning, fails, and so does an empty openapi/ or asyncapi/, and
#      anything in schemas/ that is not a *.json file.
#   3. Control fixtures produce no problems at all.
#   4. Every violating fixture fails with its own rule, and no rule fires on it
#      that the fixture does not declare.
#   5. Every own rule - rule/* in redocly.yaml and contracts/* in
#      lint/plugin.js - is enabled outside the apis of redocly.yaml and has at
#      least one fixture. contracts/pattern-portable also runs on the table
#      PORTABLE_CASES below, and the dictionary of personal data of the plugin
#      on the table PII_NAME_CASES: a fixture per construct or word would be a
#      document per line of a table.
#   6. Every message of asyncapi/*.yaml has an example, and every example
#      matches its schema. Redocly 2.60.0 does not check examples of AsyncAPI,
#      so the step bundles each document with every $ref resolved, puts the
#      examples into an OpenAPI 3.1 document in /tmp and lints it with
#      no-invalid-media-type-examples, the rule that checks the examples of the
#      OpenAPI documents. The step tests itself on tests/examples/*.yaml: every
#      example there breaks its schema, and each must be reported.
#   7. The compatibility check of compat.sh, bin/compat.js, finds exactly
#      what every pair of tests/compat/ expects, and every kind of finding
#      has a pair.
#   8. Redocly reads every document as OpenAPI 3.1.<n> or AsyncAPI 3.0.0: a
#      document of another version passes the lint, and none of our rules
#      runs on it. The documents are openapi/*.yaml, asyncapi/*.yaml and every
#      *.yaml in tests/ outside tests/compat/ and the inputs of steps 8, 10 and
#      11, which must cover all that steps 2-6 lint. A document in a directory
#      named openapi is OpenAPI, one in a directory named asyncapi is
#      AsyncAPI. Outside tests/compat/, tests/ holds only *.yaml, *.json in
#      directories named schemas and expected.txt: a file in another form
#      would escape every step. The step tests itself on
#      tests/versions/<dir>/<reason>--<case>.yaml: each fails for <reason>,
#      skipped (the rules did not run), version or kind.
#   9. Every $defs entry of schemas/*.json is walked as a schema in the lint of
#      a document of openapi/ or asyncapi/: the rules of schemas see no other
#      entry. The root of a schema file holds only $schema, title, description
#      and $defs with at least one entry; the open general form of Problem
#      Details in the root of problem-details.v1.json is the one exception. The
#      step tests itself on tests/definitions/, a layout of contracts/ whose
#      findings must be exactly the lines of its expected.txt.
#  10. The apis of redocly.yaml switch rules off for a document exactly as
#      RULE_OVERRIDES below lists, and their entries have no keys but root and
#      rules: the fixtures are linted with the root config and never see an
#      override. A strict reader of the text reads the apis block, and what it
#      does not know fails. The step tests itself on
#      tests/overrides/<kind>--<case>.yaml, redocly.yaml with one fault of
#      <kind>, form, key, root or override, and a line "# expect: <text>":
#      a finding of <kind> must hold <text>, so one finding cannot stand in
#      for another.
#  11. A wrong option of a rule of the plugin stops the lint: a factory that
#      throws fails the run, and only that keeps a wrong option from quietly
#      weakening a rule. Every tests/options/<rule>--<case>.yaml is a config
#      with one wrong option of contracts/<rule> and a line
#      "# expect: <text>"; the lint of a document of the kind of the rule with
#      it exits with 1 and prints the error of the rule with <text>. Every rule
#      of the plugin with options has a test.
# Steps 8 and 9 read one lint with the rules of bin/lint-probe.js.
# Problems suppressed by an ignore file (.redocly.lint-ignore.yaml) fail
# steps 2-4, 6 and 8 as well: an ignore file must not make the run green.
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
# Pairs of the compatibility check are directories
# tests/compat/<outcome>--<case>:
#   base/, head/   contracts/ before and after a change, in the layout of
#                  contracts/; a side without contracts holds only .gitkeep;
#   expected.txt   every finding and every error of the comparison, a line
#                  each, "#" starts a comment:
#                    <verdict> <kind> <file>#<JSON pointer>   a finding
#                    error <base|head> <file>                 an error
# <outcome> is compatible: no breaking finding and no error; breaking: a
# breaking finding and no error; or error: an error. A pair passes when its
# findings and errors, counted with repeats, are the lines of expected.txt. A
# line may not repeat, so a finding reported twice fails the pair.
# Kinds, their verdicts and places are described in bin/compat.js.
#
# Redocly CLI runs from Docker as bin/redocly.sh describes.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/redocly.sh"

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
  echo 'FAIL: docker is not found; steps 2-11 need it' >&2
  exit 2
fi

# Steps 2-11 run in one container; the script below comes through stdin.
run_in_image -e STEP1="$step1" -w /spec --entrypoint node -- - <<'NODE'
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const ROOT = '/spec';
const ASYNCAPI = 'asyncapi';
const DOCUMENT_DIRS = ['openapi', ASYNCAPI];
const FIXTURES = 'tests/rules';
const EXAMPLE_TESTS = 'tests/examples';
const COMPAT_TESTS = 'tests/compat';
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

// Lints `files` in one run with `config`. Returns one report per file, or
// undefined if Redocly stopped early, for example on a YAML syntax error or a
// broken config; then it prints the file it stopped at and why.
function lint(files, config = 'redocly.yaml') {
  const result = run(['lint', '--config', config, '--lint-config=error', '--format=json',
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
  const isDocument = (file) => file.endsWith('.yaml') && fs.statSync(path.join(dirPath, file)).isFile();
  const found = files.filter(isDocument).map((file) => `${dir}/${file}`);
  if (found.length === 0) {
    console.log(`FAIL: ${dir}/ has no *.yaml documents`);
    step2 = false;
  }
  // A document in another form would escape every check.
  for (const file of files.filter((item) => !isDocument(item))) {
    console.log(`FAIL: ${dir}/${file}: only *.yaml documents may lie here, and only they are checked`);
    step2 = false;
  }
  documents.push(...found);
}
// The compatibility check compares schemas/*.json only: a schema in another
// form or in a folder would escape it.
const schemasPath = path.join(ROOT, 'schemas');
for (const file of fs.existsSync(schemasPath) ? fs.readdirSync(schemasPath).sort() : []) {
  if (!file.endsWith('.json') || !fs.statSync(path.join(schemasPath, file)).isFile()) {
    console.log(`FAIL: schemas/${file}: only *.json files may lie here, and only they are compared`);
    step2 = false;
  }
}
// A contract never references the helpers of the tests: pointed at a stub in
// tests/, it would be checked against the stub instead of itself.
for (const dir of [...DOCUMENT_DIRS, 'schemas']) {
  const dirPath = path.join(ROOT, dir);
  for (const file of fs.existsSync(dirPath) ? fs.readdirSync(dirPath).sort() : []) {
    const filePath = path.join(dirPath, file);
    // A folder got its FAIL above.
    if (!fs.statSync(filePath).isFile()) {
      continue;
    }
    if (/\$ref['"]?\s*:\s*['"]?[^'"\s]*tests\//.test(fs.readFileSync(filePath, 'utf8'))) {
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

// --- The apis of redocly.yaml ---
// The rules that an api of redocly.yaml switches off for its document, with
// the root of the api. The fixtures are linted with the root config and never
// see an override, so each one is listed here, and the apis must match the
// list exactly.
const RULE_OVERRIDES = {
  'common@v1': {
    root: 'openapi/common.v1.yaml',
    off: ['no-empty-servers', 'no-unused-components', 'security-defined'],
  },
  'channel-stub@v1': {
    root: 'openapi/channel-stub.v1.yaml',
    off: ['rule/public-response-set', 'contracts/error-media-types', 'contracts/unauthorized-shape'],
  },
};
const OVERRIDE_KINDS = ['form', 'key', 'root', 'override'];
const DOCUMENT_ROOT = /^(?:openapi|asyncapi)\/[^/]+\.yaml$/;
const BLANK_LINE = /^ *(?:#.*)?$/;
const RULE_NAME = '[a-z0-9]+(?:-[a-z0-9]+)*(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)?';

// Reads the apis block of the config `text` strictly. YAML has many ways to
// write one mapping, and what this reader does not know is a finding of kind
// form, so the apis cannot hold what the reader does not see. A line at column
// 0 is a plain key, apis is one of them exactly once, and its block holds only
//   "  <api>:", "    root: <path>", "    rules:", "      <rule>: off",
// comments and empty lines. A root is a document openapi/<name>.yaml or
// asyncapi/<name>.yaml that exists, the root of one api: Redocly takes the
// first api whose root resolves to the path of the document. Returns the
// findings, each { kind, line, text }, and the indexes of the lines of the
// block.
function readApis(text) {
  const findings = [];
  const add = (kind, index, message) => findings.push({ kind, line: index === undefined ? undefined : index + 1, text: message });
  const lines = text.split('\n');
  let start = -1;
  let count = 0;
  lines.forEach((line, index) => {
    if (line.includes('\r')) {
      add('form', index, 'a carriage return: the lines of redocly.yaml end with LF alone');
    } else if (!BLANK_LINE.test(line) && !line.startsWith(' ')) {
      const key = /^([a-z][A-Za-z0-9_]*):(.*)$/.exec(line);
      if (key === null) {
        add('form', index, `"${line}" is not a plain key at column 0`);
      } else if (key[1] === 'apis') {
        count += 1;
        start = index;
        if (!BLANK_LINE.test(key[2])) {
          add('form', index, 'apis is not a block: its entries go on the lines below it');
        }
      }
    }
  });
  if (count !== 1) {
    add('form', undefined, `the key apis is at column 0 ${count} times, not once`);
  }
  const block = new Set();
  const apis = new Map();
  let api;
  let inRules = false;
  // Lines deeper than this belong to a key that is already reported.
  let skipBelow;
  for (let index = start + 1; start !== -1 && index < lines.length; index += 1) {
    const line = lines[index];
    if (!BLANK_LINE.test(line) && !line.startsWith(' ')) {
      break;
    }
    block.add(index);
    const indent = line.length - line.trimStart().length;
    if (BLANK_LINE.test(line) || line.includes('\r') || (skipBelow !== undefined && indent > skipBelow)) {
      continue;
    }
    skipBelow = undefined;
    let match;
    if ((match = /^  ([A-Za-z0-9_.@-]+): *$/.exec(line)) !== null) {
      if (apis.has(match[1])) {
        add('form', index, `api ${match[1]} is written twice`);
      }
      api = { name: match[1], root: undefined, rules: [], index };
      apis.set(match[1], api);
      inRules = false;
    } else if (api !== undefined && (match = /^    root: (\S+) *$/.exec(line)) !== null) {
      api.root = match[1];
      inRules = false;
    } else if (api !== undefined && /^    rules: *$/.test(line)) {
      inRules = true;
    } else if (api !== undefined && (match = /^    ([A-Za-z0-9_$-]+):/.exec(line)) !== null
      && !['root', 'rules'].includes(match[1])) {
      add('key', index, `api ${api.name} has the key ${match[1]}: an entry of apis has only root and rules`);
      inRules = false;
      skipBelow = indent;
    } else if (api !== undefined && inRules && indent >= 6) {
      match = new RegExp(`^      (${RULE_NAME}): (\\S+) *$`).exec(line);
      if (match === null) {
        add('override', index, `"${line.trim()}" in the rules of api ${api.name}: an override is a line "<rule>: off", without options`);
        skipBelow = indent;
      } else if (match[2] !== 'off') {
        add('override', index, `${match[1]}: ${match[2]} in the rules of api ${api.name}: an override only switches a rule off`);
      } else {
        api.rules.push(match[1]);
      }
    } else {
      add('form', index, `"${line.trim()}" is not a line of apis that this check reads`);
    }
  }
  const roots = new Map();
  for (const entry of apis.values()) {
    if (entry.root === undefined) {
      add('root', entry.index, `api ${entry.name} has no root`);
    } else if (!DOCUMENT_ROOT.test(entry.root) || !fs.existsSync(path.join(ROOT, entry.root))) {
      add('root', entry.index, `api ${entry.name}: root ${entry.root} is not a document openapi/<name>.yaml or asyncapi/<name>.yaml that exists`);
    } else if (roots.has(entry.root)) {
      add('root', entry.index, `api ${entry.name}: ${entry.root} is the root of api ${roots.get(entry.root)} too`);
    } else {
      roots.set(entry.root, entry.name);
    }
    const pinned = Object.hasOwn(RULE_OVERRIDES, entry.name) ? RULE_OVERRIDES[entry.name] : undefined;
    for (const rule of entry.rules.filter((item) => pinned === undefined || !pinned.off.includes(item))) {
      add('override', entry.index, `api ${entry.name} switches off ${rule}, which RULE_OVERRIDES of check.sh does not list`);
    }
  }
  for (const [name, pinned] of Object.entries(RULE_OVERRIDES)) {
    const entry = apis.get(name);
    if (entry === undefined) {
      add('override', undefined, `api ${name}, whose overrides RULE_OVERRIDES of check.sh lists, is missing`);
      continue;
    }
    if (entry.root !== pinned.root) {
      add('root', entry.index, `api ${name} has the root ${entry.root}, while RULE_OVERRIDES of check.sh lists its overrides for ${pinned.root}`);
    }
    for (const rule of pinned.off.filter((item) => !entry.rules.includes(item))) {
      add('override', entry.index, `api ${name} does not switch off ${rule}, which RULE_OVERRIDES of check.sh lists`);
    }
  }
  return { findings, block };
}

// --- Rules ---
const configText = fs.readFileSync(path.join(ROOT, 'redocly.yaml'), 'utf8');
const apisReading = readApis(configText);
// The lines outside the apis: an override there switches a rule off for one
// document and never enables a rule.
const rootConfig = configText.split('\n').filter((line, index) => !apisReading.block.has(index)).join('\n');
const configured = new Set([...rootConfig.matchAll(/^\s*((?:rule|contracts)\/[a-z0-9]+(?:-[a-z0-9]+)*):/gm)]
  .map((match) => match[1]));
// Rules of the plugin written as a block: with settings besides the severity.
const blockRules = [...rootConfig.matchAll(/^ {2}(contracts\/[a-z0-9]+(?:-[a-z0-9]+)*): *$/gm)].map((match) => match[1]);
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
if (apisReading.findings.some((finding) => finding.kind === 'form')) {
  console.log('FAIL: the apis block of redocly.yaml does not read, see step 10, so the rules enabled outside it are unknown');
  step5 = false;
}
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
// Patterns that contracts/pattern-portable refuses, true, or passes, false:
// every construct it refuses, each spelling of it, and the forms that read
// the same in both engines next to them.
const BACKSLASH = '\\';
const PORTABLE_CASES = [
  ['^a.b(?![\\s\\S])', true], ['^[.]{1,3}(?![\\s\\S])', false],
  ['^a\\sb(?![\\s\\S])', true], ['^a\\Sb(?![\\s\\S])', true], ['^[\\S\\s](?![\\s\\S])', true],
  ['^a[\\s\\S]b(?![\\s\\S])', false],
  ['^a\\vb(?![\\s\\S])', true], ['^a\\b(?![\\s\\S])', true], ['^a\\B(?![\\s\\S])', true],
  [`^${BACKSLASH}u0041(?![\\s\\S])`, true], [`^${BACKSLASH}u{41}(?![\\s\\S])`, true],
  ['^(?i:[a-z])(?![\\s\\S])', true], ['^(?m:[a-z])(?![\\s\\S])', true], ['^(?s:[a-z])(?![\\s\\S])', true],
  ['^(?-i:[a-z])(?![\\s\\S])', true],
  ['^(?:(a)|b)\\1(?![\\s\\S])', true], ['^(?:(?<x>a)|b)\\k<x>(?![\\s\\S])', true], ['^(?<x>a)(?![\\s\\S])', false],
  ['^[a-z](?<=a)(?![\\s\\S])', true], ['^[a-z](?<!b)(?![\\s\\S])', true], ['^(?=[a-z])[a-z0-9](?![\\s\\S])', false],
  ['^\\p{L}\\p{M}(?![\\s\\S])', false], ['^\\p{Lu}(?![\\s\\S])', true], ['^\\P{L}(?![\\s\\S])', true],
  ['^[a-z]+$', true], ['^[$][a-z](?![\\s\\S])', true], ['^\\$[a-z](?![\\s\\S])', false],
  ['^\\d(?![\\s\\S])', true], ['^\\D(?![\\s\\S])', true], ['^[\\w](?![\\s\\S])', true], ['^\\W(?![\\s\\S])', true],
  ['^[0-9a-f]{32}(?![\\s\\S])', false],
];
const portable = plugin.rules.oas3['pattern-portable']();
for (const [pattern, refused] of PORTABLE_CASES) {
  const reports = [];
  portable.Schema({ type: 'string', maxLength: 10, pattern }, {
    location: { child: () => undefined },
    report: (problem) => reports.push(problem),
  });
  if ((reports.length > 0) !== refused) {
    console.log(`FAIL: contracts/pattern-portable ${refused ? 'passes' : 'refuses'} the pattern ${pattern}`);
    step5 = false;
  }
}
// Names and what the dictionary of personal data takes them for: every word of
// the dictionary, written as a part, a word or the start of a name, and names
// that hold a short word inside a longer one and are no personal data.
const PII = 'personal data';
const PII_NAME_CASES = [
  ['email', PII], ['phone', PII], ['first_name', PII], ['last_name', PII], ['middle_name', PII], ['surname', PII],
  ['full_name', PII], ['patronymic', PII], ['passport_number', PII], ['birth_date', PII], ['birthday', PII],
  ['date_of_birth', PII], ['card_token', PII], ['card_number', PII], ['cardholder_name', PII],
  ['billing_address', PII], ['snils', PII], ['contact_person', PII], ['comments', PII], ['remarks', PII],
  ['given_name', PII], ['family_name', PII], ['mobile_number', PII], ['msisdn', PII], ['special_request', PII],
  ['special_requests', PII], ['tax_id', PII],
  ['card_pan', PII], ['PAN', PII], ['payer_inn', PII], ['X-Payer-INN', PII], ['booking_note', PII], ['notes', PII],
  ['dob', PII], ['guest_count', PII], ['lead_guest_name', PII], ['primary_guest', PII],
  ['booking_token', 'booking token'],
  ['inner', undefined], ['dinner_included', undefined], ['company', undefined], ['time_span', undefined],
  ['refund_not_executed', undefined], ['footnote', undefined], ['adobe_id', undefined], ['syntax_ok', undefined],
  ['guests', undefined], ['number_of_guests', undefined], ['placeholder', undefined], ['room_type_id', undefined],
];
const { sensitiveKind } = require(path.join(ROOT, 'lint/plugin.js'));
if (typeof sensitiveKind !== 'function') {
  console.log('FAIL: lint/plugin.js exports no sensitiveKind, the dictionary of personal data');
  step5 = false;
}
for (const [name, kind] of typeof sensitiveKind === 'function' ? PII_NAME_CASES : []) {
  const found = sensitiveKind(name);
  if (found !== kind) {
    console.log(`FAIL: the dictionary of personal data takes ${name} for ${found ?? 'no personal data'}, not ${kind ?? 'no personal data'}`);
    step5 = false;
  }
}
if (step5) {
  console.log(`ok: each of ${ownRules.length} own rules has a fixture`);
  console.log(`ok: contracts/pattern-portable decides each of ${PORTABLE_CASES.length} patterns of its table as expected`);
  console.log(`ok: the dictionary of personal data decides each of ${PII_NAME_CASES.length} names of its table as expected`);
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

// --- Step 7 ---
section(`7. Tests of the compatibility check, ${COMPAT_TESTS}/`);
const PAIR = /^(compatible|breaking|error)--[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SIDES = ['base', 'head'];
let step7 = true;
let compat;
try {
  compat = require(path.join(ROOT, 'bin/compat.js'));
} catch (error) {
  console.log(`FAIL: bin/compat.js does not load: ${error.message}`);
  step7 = false;
}
if (compat !== undefined && !(typeof compat.KINDS === 'object' && compat.KINDS !== null
  && typeof compat.compare === 'function')) {
  console.log('FAIL: bin/compat.js exports no KINDS object or no compare function');
  compat = undefined;
  step7 = false;
}

function isDirectory(file) {
  return fs.existsSync(file) && fs.statSync(file).isDirectory();
}

// Lines of expected.txt in `dir`; whatever is wrong with them goes to `reasons`.
function readExpected(dir, reasons) {
  const file = path.join(dir, 'expected.txt');
  if (!fs.existsSync(file)) {
    reasons.push('no expected.txt');
    return [];
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  const seen = new Set();
  for (const line of lines) {
    const [verdict, kind, place, ...rest] = line.split(/\s+/);
    const known = verdict === 'error'
      ? SIDES.includes(kind)
      : Object.hasOwn(compat.KINDS, kind) && compat.KINDS[kind] === verdict;
    if (place === undefined || rest.length > 0 || !known) {
      reasons.push(`expected.txt: "${line}" is neither "<verdict> <kind> <place>" with the verdict of the kind nor "error <base|head> <file>"`);
    }
    if (seen.has(line)) {
      reasons.push(`expected.txt: "${line}" is repeated`);
    }
    seen.add(line);
  }
  if (lines.length === 0) {
    reasons.push('expected.txt has no lines: a pair without findings would pass even if nothing was compared');
  }
  return lines;
}

// `items` without one occurrence of each of `removed`.
function without(items, removed) {
  const rest = [...items];
  for (const item of removed) {
    const index = rest.indexOf(item);
    if (index >= 0) {
      rest.splice(index, 1);
    }
  }
  return rest;
}

const compatDir = path.join(ROOT, COMPAT_TESTS);
const pairs = fs.existsSync(compatDir) ? fs.readdirSync(compatDir).sort() : [];
if (pairs.length === 0) {
  console.log(`FAIL: ${COMPAT_TESTS}/ has no pair`);
  step7 = false;
}
const testedKinds = new Set();
pairs.forEach((name, index) => {
  if (compat === undefined) {
    return;
  }
  const dir = path.join(compatDir, name);
  const reasons = [];
  const match = PAIR.exec(name);
  if (match === null || !isDirectory(dir)) {
    reasons.push('not a directory <outcome>--<case>, where <outcome> is compatible, breaking or error');
  }
  for (const side of SIDES) {
    if (!isDirectory(path.join(dir, side))) {
      reasons.push(`no ${side}/`);
    }
  }
  const expected = isDirectory(dir) ? readExpected(dir, reasons) : [];
  const verdicts = expected.map((line) => line.split(/\s+/)[0]);
  const breaking = verdicts.includes('breaking');
  const errors = verdicts.includes('error');
  if (match !== null && ((match[1] === 'compatible' && (breaking || errors))
    || (match[1] === 'breaking' && (!breaking || errors)) || (match[1] === 'error' && !errors))) {
    reasons.push(`expected.txt does not fit the outcome ${match[1]}`);
  }
  expected.filter((line) => !line.startsWith('error ')).forEach((line) => testedKinds.add(line.split(/\s+/)[1]));
  const notes = [];
  if (reasons.length === 0) {
    try {
      const result = compat.compare(path.join(dir, 'base'), path.join(dir, 'head'), `/tmp/compat-test-${index}`);
      const actual = [
        ...result.findings.map((finding) => `${finding.verdict} ${finding.kind} ${finding.location}`),
        ...result.errors.map((error) => `error ${error.side} ${error.file}`),
      ];
      without(expected, actual).forEach((line) => reasons.push(`missing: ${line}`));
      without(actual, expected).forEach((line) => reasons.push(`unexpected: ${line}`));
      result.errors.forEach((error) => notes.push(`error of ${error.side} ${error.file}: ${error.message}`));
    } catch (error) {
      reasons.push(`bin/compat.js threw: ${error.stack}`);
    }
  }
  if (reasons.length === 0) {
    console.log(`ok: ${name}: ${expected.length} expected lines`);
  } else {
    console.log(`FAIL: ${name}`);
    [...reasons, ...notes].forEach((text) => console.log(`  ${text.replace(/\s+/g, ' ')}`));
    step7 = false;
  }
});
if (compat !== undefined) {
  const untested = Object.keys(compat.KINDS).filter((kind) => !testedKinds.has(kind));
  if (untested.length > 0) {
    console.log(`FAIL: kinds of findings without a pair: ${untested.join(', ')}`);
    step7 = false;
  } else {
    console.log(`ok: each of ${Object.keys(compat.KINDS).length} kinds of findings has a pair`);
  }
}
if (!step7) {
  failed.push('7. tests of the compatibility check');
}

// --- Steps 8 and 9: one lint with the probe ---
const VERSION_TESTS = 'tests/versions';
const DEFINITION_TESTS = 'tests/definitions';
const OVERRIDE_TESTS = 'tests/overrides';
const OPTION_TESTS = 'tests/options';
const PROBE_CONFIG = '/tmp/probe-redocly.yaml';
// The plugin of the contracts brings its extension of the types, so the walk
// is that of the real lint; none of its rules is switched on here.
fs.writeFileSync(PROBE_CONFIG, ['extends: []',
  `plugins: [${path.join(ROOT, 'lint/plugin.js')}, ${path.join(ROOT, 'bin/lint-probe.js')}]`, 'telemetry: off',
  'oas3_1Rules:', '  probe/version: error', '  probe/schemas: error',
  'async3Rules:', '  probe/version: error', '  probe/schemas: error', ''].join('\n'));

// The files under `dir` of ROOT, at any depth, as paths from ROOT.
function listFiles(dir) {
  if (!isDirectory(path.join(ROOT, dir))) {
    return [];
  }
  return fs.readdirSync(path.join(ROOT, dir)).sort().flatMap((name) => (
    isDirectory(path.join(ROOT, dir, name)) ? listFiles(`${dir}/${name}`) : [`${dir}/${name}`]));
}

const testFiles = listFiles('tests').filter((file) => !file.startsWith(`${COMPAT_TESTS}/`));
const inputs = [VERSION_TESTS, OVERRIDE_TESTS, OPTION_TESTS];
const probed = [...documents,
  ...testFiles.filter((file) => file.endsWith('.yaml') && !inputs.some((dir) => file.startsWith(`${dir}/`)))];
const versionTests = testFiles.filter((file) => file.startsWith(`${VERSION_TESTS}/`) && file.endsWith('.yaml'));
const probeFiles = [...probed, ...versionTests];

// --- Step 8 ---
section('8. Versions of the documents');
const probeReports = lint(probeFiles, PROBE_CONFIG);
const probeByFile = new Map(probeReports === undefined ? [] : probeFiles.map((file, index) => [file, probeReports[index]]));
let step8 = probeReports !== undefined;
const OPENAPI_VERSION = /^3\.1\.(?:0|[1-9][0-9]*)$/;
const ASYNCAPI_VERSION = '3.0.0';
const VERSION_REASONS = ['skipped', 'version', 'kind'];

// What keeps the rules from checking the probed document `file`, as
// { reason, text }, or undefined. The reason is skipped: the rules of
// oas3_1Rules and async3Rules did not run on it; version: they ran, but the
// version is not 3.1.<n> or 3.0.0; kind: a directory named openapi holds
// OpenAPI, one named asyncapi AsyncAPI, and the document is the other kind.
function versionProblem(file, report) {
  const found = report.problems.filter((problem) => problem.ruleId === 'probe/version');
  if (found.length !== 1) {
    return { reason: 'skipped', text: 'Redocly did not run the rules of oas3_1Rules and async3Rules on it: it reads neither as OpenAPI 3.1 nor as AsyncAPI 3' };
  }
  const { openapi, asyncapi } = JSON.parse(found[0].message);
  const kind = typeof openapi === 'string' ? 'openapi' : 'asyncapi';
  const parent = path.basename(path.dirname(file));
  if (DOCUMENT_DIRS.includes(parent) && parent !== kind) {
    return { reason: 'kind', text: `it is ${kind}, while a directory named ${parent} holds ${parent} documents` };
  }
  const version = kind === 'openapi' ? openapi : asyncapi;
  if (kind === 'openapi' ? !OPENAPI_VERSION.test(version) : version !== ASYNCAPI_VERSION) {
    return { reason: 'version', text: `${kind}: ${version}, while the documents are openapi: 3.1.<n> and asyncapi: ${ASYNCAPI_VERSION}` };
  }
  return undefined;
}

// What steps 2-6 lint must be among the probed documents: a wrong selection
// would leave them unchecked, and this step green.
const lintedElsewhere = [...documents, ...control.map((file) => `${FIXTURES}/${file}`),
  ...violating.map((fixture) => `${FIXTURES}/${fixture.file}`),
  ...exampleTests.map((file) => `${EXAMPLE_TESTS}/${file}`),
  ...listFiles('tests/openapi').filter((file) => file.endsWith('.yaml'))];
for (const file of lintedElsewhere.filter((item) => !probed.includes(item))) {
  console.log(`FAIL: ${file}: another step lints it, but this step does not check its version`);
  step8 = false;
}
// Whether a file of tests/ outside tests/compat/ has a form that a step reads.
function isTestFileForm(file) {
  return file.endsWith('.yaml') || (file.endsWith('.json') && path.basename(path.dirname(file)) === 'schemas')
    || path.basename(file) === 'expected.txt';
}
for (const file of testFiles.filter((item) => !isTestFileForm(item))) {
  console.log(`FAIL: ${file}: outside ${COMPAT_TESTS}/, tests/ holds only *.yaml, *.json in directories named schemas and expected.txt; no step reads a file in another form`);
  step8 = false;
}
// A file of another form would fail the real run, so the check is tested on
// names alone.
const formSamples = { 'tests/rules/rule--x--y.json': false, 'tests/rules/valid--x.yml': false,
  'tests/definitions/schemas/x.txt': false, 'tests/schemas/x.json': true, 'tests/definitions/expected.txt': true };
for (const [file, expected] of Object.entries(formSamples)) {
  if (isTestFileForm(file) !== expected) {
    console.log(`FAIL: the check of the forms of tests/ ${expected ? 'refuses' : 'takes'} ${file}`);
    step8 = false;
  }
}
let versionChecked = 0;
for (const file of probed) {
  const report = probeByFile.get(file);
  if (report === undefined) {
    continue;
  }
  versionChecked += 1;
  const problem = versionProblem(file, report);
  if (problem !== undefined) {
    console.log(`FAIL: ${file}: ${problem.text}`);
    step8 = false;
  }
  if (report.totals.ignored > 0) {
    console.log(`FAIL: ${file}: ${report.totals.ignored} problems of the probe ignored by an ignore file`);
    step8 = false;
  }
}
if (step8) {
  console.log(`ok: ${versionChecked} documents are openapi: 3.1.<n> or asyncapi: ${ASYNCAPI_VERSION}, each in its directory`);
}
// The step tests itself: every document of tests/versions fails for the
// reason in its name.
const REASON_NAME = new RegExp(`^(${VERSION_REASONS.join('|')})--[a-z0-9]+(?:-[a-z0-9]+)*\\.yaml$`);
if (versionTests.length === 0) {
  console.log(`FAIL: ${VERSION_TESTS}/ has no test of this step`);
  step8 = false;
}
const testedReasons = new Set();
for (const file of versionTests) {
  const name = REASON_NAME.exec(path.basename(file));
  const report = probeByFile.get(file);
  const problem = report === undefined ? undefined : versionProblem(file, report);
  if (name === null) {
    console.log(`FAIL: ${file}: the name is not <reason>--<case>.yaml, where <reason> is ${VERSION_REASONS.join(', ')}`);
    step8 = false;
  } else if (problem !== undefined && problem.reason === name[1]) {
    console.log(`ok: ${file}: ${problem.text}`);
    testedReasons.add(name[1]);
  } else if (report !== undefined) {
    console.log(`FAIL: ${file}: expected ${name[1]}, found ${problem === undefined ? 'nothing' : `${problem.reason}: ${problem.text}`}`);
    step8 = false;
  }
}
for (const reason of VERSION_REASONS.filter((item) => !testedReasons.has(item))) {
  console.log(`FAIL: no test of ${VERSION_TESTS}/ fails for ${reason}`);
  step8 = false;
}
if (!step8) {
  failed.push('8. versions of the documents');
}

// --- Step 9 ---
section('9. Entries of $defs in schemas/*.json');
let step9 = probeReports !== undefined;
// The root of a schema file holds the entries, and the walker never visits
// it: no document refers to a root. The one root with a schema is the open
// general form of Problem Details, whose fields change only by a breaking
// change, which compat.sh reports.
const ROOT_KEYS = ['$schema', 'title', 'description', '$defs'];
const ROOT_SCHEMAS = ['schemas/problem-details.v1.json'];

// The findings of this step in the layout `dir` of contracts/, '' for
// contracts/ itself, each a line "unwalked <file>#/$defs/<name>",
// "root <file>" or "empty <file>", with paths from `dir`. An entry is walked
// only if the probe saw it in the lint of a document of `dir`: openapi/*.yaml
// or asyncapi/*.yaml. `rootSchemas` lists the files whose root may hold a
// schema.
function definitionFindings(dir, rootSchemas) {
  const prefix = dir === '' ? '' : `${dir}/`;
  const walked = new Set();
  for (const file of DOCUMENT_DIRS.flatMap((sub) => listFiles(`${prefix}${sub}`))) {
    const report = probeByFile.get(file);
    for (const problem of report === undefined ? [] : report.problems) {
      if (problem.ruleId === 'probe/schemas') {
        walked.add(problem.message.replace(`${ROOT}/`, ''));
      }
    }
  }
  const findings = [];
  let entries = 0;
  for (const file of listFiles(`${prefix}schemas`).filter((item) => item.endsWith('.json'))) {
    const local = file.slice(prefix.length);
    let schema;
    try {
      schema = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    } catch (error) {
      findings.push(`unreadable ${local}`);
      continue;
    }
    const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!isMap(schema) || (Object.keys(schema).some((key) => !ROOT_KEYS.includes(key)) && !rootSchemas.includes(local))) {
      findings.push(`root ${local}`);
    }
    const names = isMap(schema) && isMap(schema.$defs) ? Object.keys(schema.$defs) : [];
    if (names.length === 0) {
      findings.push(`empty ${local}`);
    }
    for (const name of names) {
      const pointer = `#/$defs/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      entries += 1;
      if (!walked.has(`${file}${pointer}`)) {
        findings.push(`unwalked ${local}${pointer}`);
      }
    }
  }
  return { findings, entries };
}

const FINDING_TEXT = {
  unwalked: 'no rule of schemas sees this entry: the lint of no document of openapi/ or asyncapi/ walks it',
  root: `the root of a schema file holds only ${ROOT_KEYS.join(', ')}: the walker never visits a root, and no rule sees a schema there`,
  empty: 'the file has no entry of $defs: a document refers to entries, so nothing of it is checked',
  unreadable: 'the file is not JSON',
};
if (step9) {
  const own = definitionFindings('', ROOT_SCHEMAS);
  for (const finding of own.findings) {
    console.log(`FAIL: ${finding.split(' ')[1]}: ${FINDING_TEXT[finding.split(' ')[0]]}`);
    step9 = false;
  }
  if (own.findings.length === 0) {
    console.log(`ok: each of ${own.entries} entries is walked; roots with a schema: ${ROOT_SCHEMAS.join(', ')}`);
  }
  // The step tests itself on tests/definitions: its findings are the lines of
  // expected.txt.
  const expectedFile = path.join(ROOT, DEFINITION_TESTS, 'expected.txt');
  const expected = fs.existsSync(expectedFile)
    ? fs.readFileSync(expectedFile, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'))
    : [];
  const test = definitionFindings(DEFINITION_TESTS, []);
  const reasons = [
    ...(expected.length === 0 ? [`${DEFINITION_TESTS}/expected.txt is missing or has no lines`] : []),
    ...without(expected, test.findings).map((line) => `missing: ${line}`),
    ...without(test.findings, expected).map((line) => `unexpected: ${line}`),
  ];
  // A file listed as a root with a schema loses its finding root, and only it.
  const rootLine = expected.find((line) => line.startsWith('root '));
  if (rootLine === undefined) {
    reasons.push('expected.txt has no line "root <file>"');
  } else {
    const excepted = definitionFindings(DEFINITION_TESTS, [rootLine.slice('root '.length)]).findings;
    if (!isDeepStrictEqual([...excepted].sort(), without(expected, [rootLine]).sort())) {
      reasons.push(`with ${rootLine.slice('root '.length)} listed as a root with a schema, the findings are not the others: ${excepted.join(', ')}`);
    }
  }
  if (reasons.length === 0) {
    console.log(`ok: ${DEFINITION_TESTS}: ${expected.length} expected findings`);
  } else {
    console.log(`FAIL: ${DEFINITION_TESTS}`);
    reasons.forEach((text) => console.log(`  ${text}`));
    step9 = false;
  }
} else {
  console.log('FAIL: the probe did not lint the documents, see step 8');
}
if (!step9) {
  failed.push('9. entries of $defs');
}

// --- Step 10 ---
section('10. Overrides of rules in the apis of redocly.yaml');
let step10 = true;
for (const finding of apisReading.findings) {
  console.log(`FAIL: redocly.yaml${finding.line === undefined ? '' : `:${finding.line}`}: ${finding.kind}: ${finding.text}`);
  step10 = false;
}
if (step10) {
  console.log(`ok: the apis switch off only what RULE_OVERRIDES lists: ${Object.entries(RULE_OVERRIDES).map(([api, entry]) => `${entry.off.length} rules for ${api}`).join(', ')}`);
}
// The step tests itself: every config of tests/overrides has a finding of
// the kind in its name with the text of its line "# expect: <text>", and so
// does redocly.yaml with CRLF line endings.
const KIND_NAME = new RegExp(`^(${OVERRIDE_KINDS.join('|')})--[a-z0-9]+(?:-[a-z0-9]+)*\\.yaml$`);
const EXPECT_LINE = /^#\s*expect:\s*(.+?)\s*$/m;
const overrideCases = [
  ...listFiles(OVERRIDE_TESTS).map((file) => {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const expect = EXPECT_LINE.exec(text);
    return { name: file, match: KIND_NAME.exec(path.basename(file)), expect: expect === null ? undefined : expect[1], text };
  }),
  { name: 'redocly.yaml with CRLF line endings', match: [undefined, 'form'], expect: 'a carriage return',
    text: configText.replace(/\n/g, '\r\n') },
];
if (overrideCases.length === 1) {
  console.log(`FAIL: ${OVERRIDE_TESTS}/ has no test of this step`);
  step10 = false;
}
const testedOverrideKinds = new Set();
for (const item of overrideCases) {
  if (item.match === null) {
    console.log(`FAIL: ${item.name}: the name is not <kind>--<case>.yaml, where <kind> is ${OVERRIDE_KINDS.join(', ')}`);
    step10 = false;
    continue;
  }
  if (item.expect === undefined) {
    console.log(`FAIL: ${item.name}: there is no line "# expect: <text>"`);
    step10 = false;
    continue;
  }
  const kind = item.match[1];
  const findings = readApis(item.text).findings;
  const own = findings.find((finding) => finding.kind === kind && finding.text.includes(item.expect));
  if (own === undefined) {
    console.log(`FAIL: ${item.name}: expected a finding of kind ${kind} with "${item.expect}", found ${findings.map((finding) => `${finding.kind}: ${finding.text}`).join('; ') || 'none'}`);
    step10 = false;
  } else {
    console.log(`ok: ${item.name}: ${kind}: ${own.text}`);
    testedOverrideKinds.add(kind);
  }
}
for (const kind of OVERRIDE_KINDS.filter((item) => !testedOverrideKinds.has(item))) {
  console.log(`FAIL: no test of ${OVERRIDE_TESTS}/ has a finding of kind ${kind}`);
  step10 = false;
}
if (!step10) {
  failed.push('10. overrides of rules');
}

// --- Step 11 ---
section('11. Wrong options of the rules of the plugin');
let step11 = true;
// The document that every kind of rules of the plugin is linted on.
const OPTION_DOCUMENTS = { oas3: `${FIXTURES}/valid--public.yaml`, async3: `${FIXTURES}/valid--events.yaml` };
const OPTION_TEST_NAME = /^([a-z0-9]+(?:-[a-z0-9]+)*)--[a-z0-9]+(?:-[a-z0-9]+)*\.yaml$/;
// A rule of the plugin has options if its factory takes a parameter or
// redocly.yaml gives it settings besides the severity, as a block.
const optionRules = [...new Set([
  ...Object.values(plugin.rules).flatMap((rules) => Object.entries(rules)
    .filter(([, factory]) => factory.length > 0).map(([name]) => `${plugin.id}/${name}`)),
  ...blockRules])].sort();
const optionTests = listFiles(OPTION_TESTS);
if (optionTests.length === 0) {
  console.log(`FAIL: ${OPTION_TESTS}/ has no test of this step`);
  step11 = false;
}
const testedOptionRules = new Set();
for (const file of optionTests) {
  const name = OPTION_TEST_NAME.exec(path.basename(file));
  const rule = name === null ? undefined : `${plugin.id}/${name[1]}`;
  const expect = /^#\s*expect:\s*(.+?)\s*$/m.exec(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const kinds = rule === undefined ? [] : Object.keys(plugin.rules).filter((kind) => Object.hasOwn(plugin.rules[kind], name[1]));
  const reasons = [];
  if (rule === undefined || kinds.length === 0) {
    reasons.push('the name is not <rule>--<case>.yaml with a rule of the plugin');
  }
  if (expect === null) {
    reasons.push('there is no line "# expect: <text>"');
  }
  for (const kind of reasons.length > 0 ? [] : kinds) {
    const result = run(['lint', '--config', file, '--format=json', OPTION_DOCUMENTS[kind]]);
    const output = `${result.stdout}\n${result.stderr}`.replace(/\s+/g, ' ');
    if (result.status !== 1 || splitReports(result.stdout).length > 0 || !output.includes(`${rule}: `)
      || !output.includes(expect[1])) {
      reasons.push(`the lint of ${OPTION_DOCUMENTS[kind]} exited with ${result.status} and did not stop on the error of ${rule} with "${expect[1]}": ${output.trim().slice(0, 300)}`);
    }
  }
  if (reasons.length === 0) {
    console.log(`ok: ${file}: ${expect[1]}`);
    testedOptionRules.add(rule);
  } else {
    console.log(`FAIL: ${file}: ${reasons.join('; ')}`);
    step11 = false;
  }
}
for (const rule of optionRules.filter((item) => !testedOptionRules.has(item))) {
  console.log(`FAIL: ${rule} has options and no test in ${OPTION_TESTS}/`);
  step11 = false;
}
if (!step11) {
  failed.push('11. wrong options of the rules');
}

// --- Summary ---
section('Summary');
console.log(`fixtures: ${control.length} control, ${violating.length} violating`);
console.log(`own rules: ${ownRules.length} (${configurableRules.length} configurable, ${pluginRules.length} plugin)`);
console.log(`pairs of the compatibility check: ${pairs.length}`);
console.log(`documents with a checked version: ${versionChecked}`);
console.log(`self-tests: ${versionTests.length} of versions, ${overrideCases.length} of overrides, ${optionTests.length} of options`);
console.log(failed.length === 0 ? 'all steps passed' : `failed: ${failed.join('; ')}`);
process.exitCode = failed.length === 0 ? 0 : 1;
NODE
