'use strict';
// Compares two trees of contracts/, a base and a head, under the rules of
// "Версии и совместимость сообщений" in contracts/README.md. compat.sh runs
// it on contracts/ of a base revision and of the working copy; check.sh runs
// it on the pairs of tests/compat/.
//
// schemas/*.json are compared as written: $defs and properties by name, a
// $ref as a string. asyncapi/*.yaml are compared after `redocly bundle
// --dereferenced`, so the schemas of openapi/*.yaml that a message takes in
// are compared under the rules of messages. Channels and messages are matched
// by their keys in the document; a new Kafka channel of a topic that the base
// has in any document is a change, not a new topic. Of the root of a document
// only channels and defaultContentType count, and the servers of a channel do
// not count either: they are deployment. A changed defaultContentType is a
// finding at the contentType of every message that has none of its own.
// openapi/*.yaml are not compared by themselves.
//
// A finding is { verdict, kind, location, message }. The location is
// <file>#<JSON pointer>, the file relative to contracts/; in a bundled
// document the pointer runs through the inlined schemas. An added or removed
// member - a field, a definition, a file of schemas, a channel, a message - is
// one finding at the member, and the comparison does not go into it. Any
// other difference is a finding at the keyword where it is. An error is
// { side, file, message }: a file or a document that cannot be read, and it
// is not compared any further.
//
// Usage: node compat.js <contracts/ of the base> <contracts/ of the head>
// Exit codes: 0 - no breaking change; 1 - a breaking change or an error;
// 2 - wrong arguments.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Every kind of finding and its verdict.
const KINDS = {
  'added-optional': 'compatible',
  'added-definition': 'compatible',
  'added-file': 'compatible',
  'added-channel': 'compatible',
  'added-message': 'compatible',
  annotation: 'compatible',
  'retention-increased': 'compatible',
  removed: 'breaking',
  'added-required': 'breaking',
  'added-to-open': 'breaking',
  'added-to-compacted': 'breaking',
  'became-required': 'breaking',
  'became-optional': 'breaking',
  changed: 'breaking',
  'retention-decreased': 'breaking',
};

// Keywords that describe and do not constrain. Inside properties, $defs and
// bindings the same words are names or data.
const ANNOTATIONS = new Set(['description', 'title', 'summary', '$comment', 'examples', 'example', 'externalDocs',
  'deprecated', 'tags']);
// Keywords whose value is one schema, and the ones whose value is a list of
// schemas. not is left out: it turns a widening into a narrowing, so any
// change under it is a change.
const SUBSCHEMA = new Set(['items', 'additionalProperties']);
const SUBSCHEMA_LISTS = new Set(['allOf', 'anyOf', 'oneOf']);
const BUNDLE_CONFIG = 'bundle-redocly.yaml';

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// An object, or nothing, which counts as an empty object.
function isMap(value) {
  return value === undefined || isObject(value);
}

function has(object, key) {
  return isObject(object) && Object.hasOwn(object, key);
}

function own(object, key) {
  return has(object, key) ? object[key] : undefined;
}

// The keys of `head`, then the keys of `base` that `head` lacks.
function keysOf(head, base) {
  const keys = isObject(head) ? Object.keys(head) : [];
  return [...keys, ...(isObject(base) ? Object.keys(base) : []).filter((key) => !has(head, key))];
}

// The JSON text of `value`, with the members of every object sorted.
function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function same(a, b) {
  return canonical(a) === canonical(b);
}

// The values of `list` that `other` lacks, as JSON; order and repeats do not
// matter.
function missingFrom(list, other) {
  const values = new Set(other.map(canonical));
  return [...new Set(list.map(canonical))].filter((value) => !values.has(value));
}

function child(location, ...tokens) {
  return location + tokens.map((token) => `/${String(token).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

function show(value) {
  const text = JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

// How a value changed, for the message of a finding.
function change(before, after) {
  if (before === undefined) {
    return `added: ${show(after)}`;
  }
  if (after === undefined) {
    return `removed, was ${show(before)}`;
  }
  return `changed from ${show(before)} to ${show(after)}`;
}

class Comparison {
  constructor() {
    this.findings = [];
    this.errors = [];
  }

  find(kind, location, message) {
    this.findings.push({ verdict: KINDS[kind], kind, location, message });
  }

  fail(side, file, message) {
    this.errors.push({ side, file, message });
  }
}

// --- Schemas ---

// Whether the fields of `schema` can be compared by name.
function hasFields(schema) {
  const required = own(schema, 'required');
  return isMap(own(schema, 'properties'))
    && (required === undefined || (Array.isArray(required) && required.every((name) => typeof name === 'string')));
}

function compareSchema(c, base, head, location) {
  if (same(base, head)) {
    return;
  }
  if (!isObject(base) || !isObject(head)) {
    c.find('changed', location, `schema ${change(base, head)}`);
    return;
  }
  const fields = hasFields(base) && hasFields(head);
  if (fields) {
    compareFields(c, base, head, location);
  }
  for (const key of keysOf(head, base)) {
    const before = own(base, key);
    const after = own(head, key);
    if (same(before, after) || (fields && (key === 'properties' || key === 'required'))) {
      continue;
    }
    const at = child(location, key);
    if (ANNOTATIONS.has(key)) {
      c.find('annotation', at, `${key} ${change(before, after)}`);
    } else if (key === '$defs' && isMap(before) && isMap(after)) {
      compareDefinitions(c, before ?? {}, after ?? {}, at);
    } else if (key === 'enum' && Array.isArray(before) && Array.isArray(after)) {
      compareEnum(c, before, after, at);
    } else if (SUBSCHEMA.has(key) && isObject(before) && isObject(after)) {
      compareSchema(c, before, after, at);
    } else if (SUBSCHEMA_LISTS.has(key) && Array.isArray(before) && Array.isArray(after)
      && before.length === after.length) {
      before.forEach((item, index) => compareSchema(c, item, after[index], child(at, index)));
    } else {
      c.find('changed', at, `${key} ${change(before, after)}`);
    }
  }
}

// Compares properties and required of two object schemas.
function compareFields(c, base, head, location) {
  const before = own(base, 'properties') ?? {};
  const after = own(head, 'properties') ?? {};
  const requiredBefore = new Set(own(base, 'required') ?? []);
  const requiredAfter = new Set(own(head, 'required') ?? []);
  // A field described in an open schema narrows what the schema accepts:
  // until then any value of it passed.
  const closed = own(base, 'additionalProperties') === false && own(head, 'additionalProperties') === false;
  for (const name of keysOf(after, before)) {
    const at = child(location, 'properties', name);
    if (!has(before, name)) {
      if (requiredAfter.has(name)) {
        c.find('added-required', at, 'new required field: data valid under the base may lack it');
      } else if (closed) {
        c.find('added-optional', at, 'new optional field: first in the contract, then in the code');
      } else {
        c.find('added-to-open', at, 'new field in an open schema: it narrows what the schema accepts');
      }
    } else if (!has(after, name)) {
      c.find('removed', at, 'field removed');
    } else {
      if (!requiredBefore.has(name) && requiredAfter.has(name)) {
        c.find('became-required', at, 'field became required');
      } else if (requiredBefore.has(name) && !requiredAfter.has(name)) {
        c.find('became-optional', at, 'field became optional');
      }
      compareSchema(c, before[name], after[name], at);
    }
  }
  const loose = [...new Set([...requiredBefore, ...requiredAfter])]
    .filter((name) => !has(before, name) && !has(after, name) && requiredBefore.has(name) !== requiredAfter.has(name));
  if (loose.length > 0) {
    c.find('changed', child(location, 'required'), `required changed for names without a field: ${loose.join(', ')}`);
  }
}

function compareDefinitions(c, base, head, location) {
  for (const name of keysOf(head, base)) {
    const at = child(location, name);
    if (!has(base, name)) {
      c.find('added-definition', at, 'new definition');
    } else if (!has(head, name)) {
      c.find('removed', at, 'definition removed');
    } else {
      compareSchema(c, base[name], head[name], at);
    }
  }
}

// Enums of messages are closed, so a value added or removed breaks; the order
// does not matter.
function compareEnum(c, base, head, location) {
  const added = missingFrom(head, base);
  const removed = missingFrom(base, head);
  if (added.length > 0 || removed.length > 0) {
    const parts = [added.length > 0 ? `added ${added.join(', ')}` : '', removed.length > 0 ? `removed ${removed.join(', ')}` : ''];
    c.find('changed', location, `enum values ${parts.filter(Boolean).join('; ')}`);
  }
}

// --- Files ---

// The names of the files `*<extension>` in `dir`/`folder`, sorted.
function filesOf(dir, folder, extension) {
  const full = path.join(dir, folder);
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) {
    return [];
  }
  return fs.readdirSync(full)
    .filter((name) => name.endsWith(extension) && fs.statSync(path.join(full, name)).isFile())
    .sort();
}

function union(a, b) {
  return [...new Set([...a, ...b])].sort();
}

// The JSON object of `file` of one side: { value }, { missing: true } or
// { error: true }.
function readSchemas(c, side, dir, file) {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) {
    return { missing: true };
  }
  let value;
  try {
    value = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (error) {
    c.fail(side, file, `not JSON: ${error.message}`);
    return { error: true };
  }
  if (!isObject(value)) {
    c.fail(side, file, 'not a JSON object');
    return { error: true };
  }
  return { value };
}

function compareSchemaFiles(c, baseDir, headDir) {
  for (const name of union(filesOf(baseDir, 'schemas', '.json'), filesOf(headDir, 'schemas', '.json'))) {
    const file = `schemas/${name}`;
    const base = readSchemas(c, 'base', baseDir, file);
    const head = readSchemas(c, 'head', headDir, file);
    if (base.error || head.error) {
      continue;
    }
    if (base.missing) {
      c.find('added-file', `${file}#`, 'new file of schemas');
    } else if (head.missing) {
      c.find('removed', `${file}#`, 'file removed');
    } else {
      compareSchema(c, base.value, head.value, `${file}#`);
    }
  }
}

// --- AsyncAPI ---

// The output of a failed run of Redocly, without the progress lines.
function reason(result) {
  const text = `${result.stdout}\n${result.stderr}`.split('\n').map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('bundling ')).join(' ');
  return text.length > 400 ? `${text.slice(0, 397)}...` : text;
}

// The AsyncAPI document `file` of one side with every $ref resolved:
// { value }, { missing: true } or { error: true }.
function bundle(c, side, dir, file, workDir) {
  const source = path.join(dir, file);
  if (!fs.existsSync(source)) {
    return { missing: true };
  }
  const output = path.join(workDir, `${side}--${file.replace(/\//g, '--')}.json`);
  const result = spawnSync('redocly', ['bundle', source, '--config', path.join(workDir, BUNDLE_CONFIG),
    '--lint-config=error', '--dereferenced', '--ext', 'json', '-o', output],
  { cwd: workDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 || !fs.existsSync(output)) {
    c.fail(side, file, `redocly bundle failed: ${reason(result)}`);
    return { error: true };
  }
  const value = JSON.parse(fs.readFileSync(output, 'utf8'));
  const version = own(value, 'asyncapi');
  if (typeof version !== 'string' || !version.startsWith('3.')) {
    c.fail(side, file, `not an AsyncAPI 3 document: asyncapi is ${show(version)}`);
    return { error: true };
  }
  return { value };
}

function compareDocuments(c, baseDir, headDir, workDir) {
  const documents = union(filesOf(baseDir, 'asyncapi', '.yaml'), filesOf(headDir, 'asyncapi', '.yaml'))
    .map((name) => {
      const file = `asyncapi/${name}`;
      return { file, base: bundle(c, 'base', baseDir, file, workDir), head: bundle(c, 'head', headDir, file, workDir) };
    });
  // Every topic of the base, whatever document describes it: a channel is new
  // only if its topic is.
  const topics = new Map();
  for (const { file, base } of documents) {
    const channels = isObject(own(base.value, 'channels')) ? base.value.channels : {};
    for (const [key, channel] of Object.entries(channels)) {
      const topic = kafkaTopic(channel);
      if (topic !== undefined && !topics.has(topic)) {
        topics.set(topic, child(`${file}#`, 'channels', key));
      }
    }
  }
  for (const { file, base, head } of documents) {
    if (!base.error && !head.error) {
      compareChannels(c, base.value, head.value, `${file}#`, topics);
    }
  }
}

// The topic of a Kafka channel, its address; undefined for other channels.
function kafkaTopic(channel) {
  const address = own(channel, 'address');
  return isObject(own(own(channel, 'bindings'), 'kafka')) && typeof address === 'string' ? address : undefined;
}

// Compares the channels of two documents; a missing document has none.
// `topics` maps every topic of the base to its channel.
function compareChannels(c, baseDocument, headDocument, location, topics) {
  const base = isObject(own(baseDocument, 'channels')) ? baseDocument.channels : {};
  const head = isObject(own(headDocument, 'channels')) ? headDocument.channels : {};
  for (const key of keysOf(head, base)) {
    const at = child(location, 'channels', key);
    const topic = kafkaTopic(own(head, key));
    if (!has(base, key) && topic !== undefined && topics.has(topic)) {
      // The rules of an existing topic hold for it, a new type in a
      // compacted one included, so its new channel is no new topic.
      c.find('changed', child(at, 'address'), `topic ${topic} is the topic of ${topics.get(topic)} in the base: `
        + 'a channel of an existing topic is not a new topic');
    } else if (!has(base, key)) {
      c.find('added-channel', at, 'new channel');
    } else if (!has(head, key)) {
      c.find('removed', at, 'channel removed');
    } else {
      compareChannel(c, baseDocument, headDocument, base[key], head[key], at);
    }
  }
}

// Whether compaction may run on the topic of a channel. A cleanup policy that
// is not a list is not understood, so it counts as compaction.
function isCompacted(channel) {
  const policy = own(own(own(own(channel, 'bindings'), 'kafka'), 'topicConfiguration'), 'cleanup.policy');
  return policy !== undefined && (!Array.isArray(policy) || policy.includes('compact'));
}

function compareChannel(c, baseDocument, headDocument, base, head, location) {
  if (!isObject(base) || !isObject(head)) {
    if (!same(base, head)) {
      c.find('changed', location, `channel ${change(base, head)}`);
    }
    return;
  }
  const compacted = isCompacted(base) || isCompacted(head);
  for (const key of keysOf(head, base)) {
    const before = own(base, key);
    const after = own(head, key);
    const at = child(location, key);
    if (key === 'servers') {
      // Where a channel is served is deployment, like the servers of the
      // document; bundled, they would carry every change of those servers.
      continue;
    } else if (key === 'messages' && isMap(before) && isMap(after)) {
      // Equal messages are compared too: their content type may come from a
      // changed defaultContentType.
      compareMessages(c, baseDocument, headDocument, before ?? {}, after ?? {}, at, compacted);
    } else if (same(before, after)) {
      continue;
    } else if (ANNOTATIONS.has(key)) {
      c.find('annotation', at, `${key} ${change(before, after)}`);
    } else if (key === 'bindings' && isObject(before) && isObject(after)) {
      compareBindings(c, before, after, at, 'channel');
    } else {
      c.find('changed', at, `${key} ${change(before, after)}`);
    }
  }
}

function compareMessages(c, baseDocument, headDocument, base, head, location, compacted) {
  for (const key of keysOf(head, base)) {
    const at = child(location, key);
    if (!has(base, key)) {
      if (compacted) {
        c.find('added-to-compacted', at, 'new message type in a compacted topic: compaction keeps one record of a key, '
          + 'whatever its type, so the type would push out the state of the key');
      } else {
        c.find('added-message', at, 'new message type: its consumers first, then the publisher');
      }
    } else if (!has(head, key)) {
      c.find('removed', at, 'message type removed');
    } else {
      compareMessage(c, baseDocument, headDocument, base[key], head[key], at);
    }
  }
}

// The content type of a message: its own, or the default of its document.
function contentType(message, document) {
  if (typeof message.contentType === 'string') {
    return message.contentType;
  }
  const fallback = own(document, 'defaultContentType');
  return typeof fallback === 'string' ? fallback : undefined;
}

function compareMessage(c, baseDocument, headDocument, base, head, location) {
  if (!isObject(base) || !isObject(head)) {
    if (!same(base, head)) {
      c.find('changed', location, `message ${change(base, head)}`);
    }
    return;
  }
  const typeBefore = contentType(base, baseDocument);
  const typeAfter = contentType(head, headDocument);
  if (typeBefore !== typeAfter) {
    c.find('changed', child(location, 'contentType'), `content type ${change(typeBefore, typeAfter)}`);
  }
  for (const key of keysOf(head, base)) {
    const before = own(base, key);
    const after = own(head, key);
    if (key === 'contentType' || same(before, after)) {
      continue;
    }
    const at = child(location, key);
    if (ANNOTATIONS.has(key)) {
      c.find('annotation', at, `${key} ${change(before, after)}`);
    } else if ((key === 'payload' || key === 'headers') && isObject(before) && isObject(after)) {
      compareSchema(c, before, after, at);
    } else if (key === 'bindings' && isObject(before) && isObject(after)) {
      compareBindings(c, before, after, at, 'message');
    } else {
      c.find('changed', at, `${key} ${change(before, after)}`);
    }
  }
}

// Every value of a binding is data, except the schema of a Kafka key and the
// configuration of a topic.
function compareBindings(c, base, head, location, owner) {
  for (const protocol of keysOf(head, base)) {
    const before = own(base, protocol);
    const after = own(head, protocol);
    if (same(before, after)) {
      continue;
    }
    const at = child(location, protocol);
    if (!isObject(before) || !isObject(after)) {
      c.find('changed', at, `binding ${protocol} ${change(before, after)}`);
      continue;
    }
    for (const key of keysOf(after, before)) {
      const valueBefore = own(before, key);
      const valueAfter = own(after, key);
      if (same(valueBefore, valueAfter)) {
        continue;
      }
      const keyAt = child(at, key);
      const both = isObject(valueBefore) && isObject(valueAfter);
      if (protocol === 'kafka' && owner === 'message' && key === 'key' && both) {
        compareSchema(c, valueBefore, valueAfter, keyAt);
      } else if (protocol === 'kafka' && owner === 'channel' && key === 'topicConfiguration' && both) {
        compareTopicConfiguration(c, valueBefore, valueAfter, keyAt);
      } else {
        c.find('changed', keyAt, `${key} ${change(valueBefore, valueAfter)}`);
      }
    }
  }
}

function compareTopicConfiguration(c, base, head, location) {
  for (const key of keysOf(head, base)) {
    const before = own(base, key);
    const after = own(head, key);
    if (same(before, after)) {
      continue;
    }
    const at = child(location, key);
    // Kafka reads the cleanup policy as a set (LogConfig, Kafka 4.3).
    const reordered = key === 'cleanup.policy' && Array.isArray(before) && Array.isArray(after)
      && missingFrom(before, after).length === 0 && missingFrom(after, before).length === 0;
    if (reordered) {
      continue;
    }
    if (key === 'retention.ms' && isRetention(before) && isRetention(after)) {
      compareRetention(c, before, after, at);
    } else {
      c.find('changed', at, `${key} ${change(before, after)}`);
    }
  }
}

function isRetention(value) {
  return Number.isInteger(value) && value >= -1;
}

// -1 means no time limit (TopicConfig.RETENTION_MS_DOC, Kafka 4.3).
function compareRetention(c, before, after, location) {
  if (after === -1) {
    c.find('changed', location, `retention.ms changed from ${before} to -1, no time limit: `
      + 'with compaction it is a change of the cleanup policy');
  } else if (before === -1 || after < before) {
    c.find('retention-decreased', location, `retention.ms decreased from ${before} to ${after}: `
      + 'a copy is rebuilt from the topic within its retention');
  } else {
    c.find('retention-increased', location, `retention.ms increased from ${before} to ${after}`);
  }
}

// --- Entry points ---

// Compares the trees `baseDir` and `headDir`; `workDir` holds the bundles.
// Returns { findings: [{ verdict, kind, location, message }],
// errors: [{ side, file, message }] }.
function compare(baseDir, headDir, workDir) {
  const c = new Comparison();
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, BUNDLE_CONFIG), 'extends: []\ntelemetry: off\n');
  compareSchemaFiles(c, baseDir, headDir);
  compareDocuments(c, baseDir, headDir, workDir);
  return { findings: c.findings, errors: c.errors };
}

function main(baseDir, headDir) {
  console.log(`Redocly CLI ${spawnSync('redocly', ['--version'], { encoding: 'utf8' }).stdout.trim()}`);
  const schemaFiles = union(filesOf(baseDir, 'schemas', '.json'), filesOf(headDir, 'schemas', '.json')).length;
  const documents = union(filesOf(baseDir, 'asyncapi', '.yaml'), filesOf(headDir, 'asyncapi', '.yaml')).length;
  console.log(`Compared: schemas/*.json - ${schemaFiles} ${schemaFiles === 1 ? 'file' : 'files'}, `
    + `asyncapi/*.yaml - ${documents} ${documents === 1 ? 'document' : 'documents'}`);
  const { findings, errors } = compare(baseDir, headDir, fs.mkdtempSync(path.join(os.tmpdir(), 'compat-')));
  if (findings.length > 0 || errors.length > 0) {
    console.log('');
  }
  errors.forEach((error) => console.log(`FAIL: ${error.side} ${error.file}: ${error.message}`));
  findings.forEach((finding) => console.log(
    `${finding.verdict === 'breaking' ? 'BREAKING' : 'compatible'}: ${finding.location}: ${finding.message} (${finding.kind})`));
  const breaking = findings.filter((finding) => finding.verdict === 'breaking').length;
  console.log('\n== Summary');
  console.log(`${breaking} breaking, ${findings.length - breaking} compatible, ${errors.length} errors`);
  if (errors.length > 0) {
    console.log('the comparison failed');
  } else if (breaking > 0) {
    console.log('breaking changes found');
  } else {
    console.log(findings.length > 0 ? 'no breaking changes' : 'no changes');
  }
  process.exitCode = errors.length > 0 || breaking > 0 ? 1 : 0;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 2) {
    main(args[0], args[1]);
  } else {
    console.error('Usage: node compat.js <contracts/ of the base> <contracts/ of the head>');
    process.exitCode = 2;
  }
}

module.exports = { KINDS, compare };
