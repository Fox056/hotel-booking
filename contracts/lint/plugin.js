'use strict';

/*
 * Redocly CLI plugin with the contract rules that configurable rules in
 * ../redocly.yaml cannot express. Rule ids get the plugin id as a prefix:
 * contracts/<name>.
 *
 * Why these rules are not configurable rules (checked on Redocly CLI 2.60.0):
 * - an assertion resolves `$ref` only one level deep, in the checked property;
 *   a check that goes from a referenced response into a referenced header and
 *   then into its schema cannot be one configurable rule;
 * - a configurable rule has one subject type, so it cannot combine a condition
 *   on a node with requirements on its children or on several of its keys,
 *   nor check two node types at once;
 * - filters of a configurable rule are combined with AND, so it cannot select
 *   operations by a pair of method and path;
 * - a nested `where` visitor reaches only the first schema under a request
 *   body or a response, not the nested ones;
 * - assertions see a node after `$ref` resolution, so the raw `$ref` string and
 *   the keys next to `$ref` are visible only to a `ref` visitor;
 * - an assertion can match a value against a regular expression but cannot
 *   read it: it can neither compile a pattern nor find its groups and classes.
 *
 * The rules that walk operations start from the `Paths` node and resolve every
 * reference themselves: the walker visits a shared node once per document,
 * while these rules need the operation and the path of every use. They walk
 * `paths` only; contracts/no-webhooks-callbacks keeps webhooks and callbacks
 * out of the documents.
 *
 * Operations are named by "METHOD path", for example
 * "POST /v1/hotels/{hotel_id}/bookings": an operationId is unique only within
 * one document.
 *
 * AsyncAPI documents get the rules of schemas and of $ref and the rules of
 * events. The rules of events start from the `Root` node for the same reason:
 * they need every message of every Kafka channel together with its channel.
 * The plugin also extends one type of Redocly 2.60.0 for AsyncAPI, see
 * typeExtension below.
 */

const { isDeepStrictEqual } = require('node:util');

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const INTERNAL_PATH = /^\/internal\//;
// Webhooks of the channels: the paths under /v1/channels/. The configurable
// rules select them by the same prefix. The path of a webhook is
// WEBHOOK_PREFIX and one kebab-case segment, the kind of the webhook: a
// template after it could bring an external booking id into the path.
const WEBHOOK_PATH = /^\/v1\/channels\//;
const WEBHOOK_PREFIX = '/v1/channels/{channel_id}/hotels/{hotel_id}/';
const WEBHOOK_PATH_FORM = /^\/v1\/channels\/\{channel_id\}\/hotels\/\{hotel_id\}\/[a-z]+(?:-[a-z]+)*$/;
const CHANNEL_KEY_SCHEME = 'channelApiKey';
// The headers of the signature and the exact patterns of their schemas: a
// pattern without the end anchor would let through a header that the front
// glued from two lines with ", ".
const SIGNATURE_HEADER_PATTERNS = {
  'X-Timestamp': '^[0-9]{10}(?![\\s\\S])',
  'X-Signature': '^v1=[0-9a-f]{64}(?![\\s\\S])',
};
const JSON_MEDIA_TYPE = 'application/json';
// A field of a webhook body in the option of contracts/webhook-fields:
// snake_case names joined with dots, [] after the name of an array.
const WEBHOOK_FIELD = /^[a-z][a-z0-9_]*(?:\[\])?(?:\.[a-z][a-z0-9_]*(?:\[\])?)*$/;
const PROBLEM_JSON = 'application/problem+json';
const TEXT_PLAIN = 'text/plain';

const CREATE_BOOKING = 'POST /v1/hotels/{hotel_id}/bookings';
const GUEST_OPERATIONS = ['GET /v1/hotels/{hotel_id}/search', CREATE_BOOKING];
const BOOKING_TOKEN_SCHEME = 'bookingToken';

// The pattern of CacheControlNoStore in openapi/common.v1.yaml.
const NO_STORE_PATTERN = '(?:^|,)[ \\t]*no-store[ \\t]*(?:,|(?![\\s\\S]))';
// The end of the string in a pattern. `$` would also match before a final
// line break: league builds a pattern as #...#u, without the modifier D.
const PATTERN_END = '(?![\\s\\S])';

// Property, parameter and header names are compared after normalizeName():
// lowercase, without separators. Personal data is a name that contains one of
// PII_PARTS, equals one of PII_NAMES, or starts with PII_PREFIX and is not one
// of PII_PREFIX_EXCEPTIONS. `pan` is compared whole, or `company` would match;
// `cardholder` is not shortened to `holder`, or `placeholder` would match;
// `guests` is the number of guests. A name that contains BOOKING_TOKEN_PART is
// the booking token.
const PII_PARTS = ['email', 'phone', 'firstname', 'lastname', 'middlename', 'surname', 'fullname', 'patronymic',
  'passport', 'birthdate', 'birthday', 'dateofbirth', 'cardtoken', 'cardnumber', 'cardholder', 'address'];
const PII_NAMES = ['pan'];
const PII_PREFIX = 'guest';
const PII_PREFIX_EXCEPTIONS = ['guests'];
const BOOKING_TOKEN_PART = 'bookingtoken';
const PERSONAL_DATA = 'personal data';
const BOOKING_TOKEN = 'booking token';

// Events. A channel gets the rules of events unless it surely stays outside
// Kafka: it is available on at least one server, every one of them resolves
// and uses a protocol of NON_EVENT_PROTOCOLS, and nothing of the channel has a
// Kafka binding - not the channel, its messages, its operations, the traits of
// those or its servers. The servers of a channel are those it lists, or all
// servers of the document when the list is absent or empty, as in AsyncAPI 3.
// So kafka-secure, an unknown protocol or a channel without servers keep the
// rules on. The body of a message is its envelope: the fields of
// ENVELOPE_FIELDS, the ones of ENVELOPE_REFS defined in envelope.v1.json.
const NON_EVENT_PROTOCOLS = ['amqp', 'amqps'];
// The address of an event channel is its topic: dotted snake_case names and
// the major version, without parameters.
const TOPIC_ADDRESS = /^([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\.(v[1-9][0-9]*)$/;
const ENVELOPE_FILE = /(?:^|\/)envelope\.v1\.json$/;
const ENVELOPE_FIELDS = ['message_id', 'type', 'created_at', 'headers', 'version', 'change_id', 'payload'];
const ENVELOPE_REQUIRED = ['message_id', 'type', 'created_at', 'payload'];
const ENVELOPE_REFS = {
  message_id: 'MessageId',
  created_at: 'CreatedAt',
  headers: 'EventHeaders',
  version: 'KeyVersion',
  change_id: 'ChangeId',
};
// A record key holds only ids and dates: the hotel id first, then at least
// one more segment, a UUID or a date, separated by colons.
const KEY_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY_DATE = '[0-9]{4}-[0-9]{2}-[0-9]{2}';
// A string of an event payload is closed: an enum or one of these formats.
// Free text could carry personal data under any allowed name. A date-time also
// has a short maxLength, or its fraction of a second could hold any digits.
const CLOSED_STRING_FORMATS = ['uuid', 'date', 'date-time'];
const DATE_TIME_MAX_LENGTH = 24;
// Names in the lists of contracts/event-fields: snake_case ASCII, so that a
// look-alike letter cannot slip a name of personal data past the checks below.
const FIELD_NAME = /^[a-z][a-z0-9_]*$/;
// Events also carry no indirect identifiers of a person and no traces of a
// payment card, whatever the name: the external booking id and the booking
// numbers of a channel, ids of a guest, customer, user or device, documents,
// phone numbers, card tokens and masked card numbers, free-text notes. Parts
// are compared after normalizeName(). Short words would match inside longer
// ones, so EVENT_SENSITIVE_WORDS are compared with the words of a name, split
// at `_`, `-` and at capital letters.
const EVENT_SENSITIVE_PARTS = ['external', 'reservation', 'confirmation', 'pnr', 'token', 'card', 'last4',
  'lastfour', 'lastdigits', 'masked', 'comment', 'note', 'guest', 'customer', 'client', 'user', 'person', 'profile',
  'account', 'member', 'loyalty', 'device', 'document', 'msisdn', 'mobile', 'snils', 'nationality', 'citizenship',
  'gender', 'born', 'useragent'];
const EVENT_SENSITIVE_WORDS = ['ip', 'name', 'pan', 'bin', 'age', 'sex', 'tel', 'dob', 'inn'];
const INDIRECT_IDENTIFIER = 'an indirect identifier of a person or a trace of a card or free text';

// Problem Details types allowed in application/problem+json by status code.
// For 400, 404, 409 and 422 they depend on the kind of operation: a public
// 404 may also come from the gateway, without trace_id, and the idempotency
// key and the guest-facing conflicts exist only in the public API, the hold
// and sale conflicts only in the internal one.
const PROBLEM_TYPES = {
  400: { public: ['about_blank', 'idempotency_key_missing'], internal: ['about_blank'] },
  401: ['about_blank_traced'],
  403: ['about_blank'],
  404: { public: ['about_blank'], internal: ['hotel_not_found'] },
  409: {
    public: ['no_availability', 'amount_changed', 'hold_expired', 'request_in_progress', 'cancellation_not_allowed',
      'offered_below_committed'],
    internal: ['no_availability', 'amount_changed', 'hold_finished', 'booking_released', 'hotel_mismatch'],
  },
  413: ['about_blank'],
  414: ['about_blank'],
  415: ['about_blank_traced'],
  422: { public: ['validation_error', 'idempotency_key_mismatch'], internal: ['validation_error'] },
  500: ['about_blank'],
  502: ['about_blank'],
  503: ['about_blank_traced'],
  504: ['about_blank'],
};
const PROBLEM_TYPE_REF = /problem-details\.v1\.json#\/\$defs\/([^/]+)$/;

function allowedProblemTypes(code, internal) {
  const entry = PROBLEM_TYPES[code];
  if (entry === undefined || Array.isArray(entry)) {
    return entry;
  }
  return internal ? entry.internal : entry.public;
}

// String formats that bound the length of a value.
// date-time is not one of them: RFC 3339 allows a fraction of a second of any
// length.
const LIMITING_STRING_FORMATS = ['date', 'uuid'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRef(value) {
  return isObject(value) && typeof value.$ref === 'string';
}

function typesOf(schema) {
  if (typeof schema.type === 'string') {
    return [schema.type];
  }
  return Array.isArray(schema.type) ? schema.type : [];
}

function normalizeName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function sensitiveKind(name) {
  const normalized = normalizeName(name);
  if (normalized.includes(BOOKING_TOKEN_PART)) {
    return BOOKING_TOKEN;
  }
  if (PII_NAMES.includes(normalized) || PII_PARTS.some((part) => normalized.includes(part))
    || (normalized.startsWith(PII_PREFIX) && !PII_PREFIX_EXCEPTIONS.includes(normalized))) {
    return PERSONAL_DATA;
  }
  return undefined;
}

// sensitiveKind() plus what events must not carry beyond it.
function eventSensitiveKind(name) {
  const kind = sensitiveKind(name);
  if (kind !== undefined) {
    return kind;
  }
  const normalized = normalizeName(name);
  const words = String(name).split(/[_\-\s]+|(?=[A-Z])/).map((word) => normalizeName(word));
  return EVENT_SENSITIVE_PARTS.some((part) => normalized.includes(part))
    || words.some((word) => EVENT_SENSITIVE_WORDS.includes(word))
    ? INDIRECT_IDENTIFIER
    : undefined;
}

// Whether `pattern` is the pattern of a record key: see KEY_UUID.
function isEventKeyPattern(pattern) {
  if (typeof pattern !== 'string' || !pattern.startsWith(`^${KEY_UUID}`)) {
    return false;
  }
  let rest = pattern.slice(KEY_UUID.length + 1);
  let segments = 1;
  while (rest.startsWith(':')) {
    const segment = [KEY_UUID, KEY_DATE].find((item) => rest.startsWith(item, 1));
    if (segment === undefined) {
      return false;
    }
    rest = rest.slice(segment.length + 1);
    segments += 1;
  }
  return segments >= 2 && rest === PATTERN_END;
}

// Follows a chain of `$ref` from `node`, which lies at `location`. Returns the
// target and its location; `node` is undefined if a reference does not resolve
// (no-unresolved-refs reports that).
function deref(ctx, node, location) {
  let current = node;
  let currentLocation = location;
  for (let depth = 0; isRef(current); depth += 1) {
    if (depth > 32) {
      return { node: undefined, location: currentLocation };
    }
    const resolved = ctx.resolve(current, currentLocation.source.absoluteRef);
    if (!resolved || !resolved.location) {
      return { node: undefined, location: currentLocation };
    }
    current = resolved.node;
    currentLocation = resolved.location;
  }
  return { node: current, location: currentLocation };
}

// Reports a problem once per location and message: a shared component is
// reached from many operations.
function createReporter(ctx) {
  const seen = new Set();
  return (message, location) => {
    const id = `${location.absolutePointer}|${message}`;
    if (!seen.has(id)) {
      seen.add(id);
      ctx.report({ message, location });
    }
  };
}

function forEachOperation(ctx, paths, callback) {
  for (const [path, rawPathItem] of Object.entries(paths)) {
    const { node: pathItem, location } = deref(ctx, rawPathItem, ctx.location.child([path]));
    if (!isObject(pathItem)) {
      continue;
    }
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (isObject(operation)) {
        callback({
          path,
          key: `${method.toUpperCase()} ${path}`,
          internal: INTERNAL_PATH.test(path),
          webhook: WEBHOOK_PATH.test(path),
          operation,
          location: location.child([method]),
          pathItem,
          pathItemLocation: location,
        });
      }
    }
  }
}

function forEachResponse(ctx, op, callback) {
  const responses = op.operation.responses;
  if (!isObject(responses)) {
    return;
  }
  for (const [code, rawResponse] of Object.entries(responses)) {
    const { node: response, location } = deref(ctx, rawResponse, op.location.child(['responses', code]));
    if (isObject(response)) {
      callback({ code, response, location });
    }
  }
}

function forEachParameter(ctx, op, callback) {
  const lists = [
    [op.pathItem.parameters, op.pathItemLocation],
    [op.operation.parameters, op.location],
  ];
  for (const [parameters, location] of lists) {
    if (!Array.isArray(parameters)) {
      continue;
    }
    parameters.forEach((rawParameter, index) => {
      const resolved = deref(ctx, rawParameter, location.child(['parameters', String(index)]));
      if (isObject(resolved.node)) {
        callback({ parameter: resolved.node, location: resolved.location });
      }
    });
  }
}

// Calls `callback` for every media type schema of a request body or response.
function forEachContentSchema(owner, location, callback) {
  if (!isObject(owner.content)) {
    return;
  }
  for (const [mediaType, media] of Object.entries(owner.content)) {
    if (isObject(media) && media.schema !== undefined) {
      callback(media.schema, location.child(['content', mediaType, 'schema']), mediaType);
    }
  }
}

// Calls `callback` for the schema of every header of a response.
function forEachHeaderSchema(ctx, response, location, callback) {
  if (!isObject(response.headers)) {
    return;
  }
  for (const [name, rawHeader] of Object.entries(response.headers)) {
    const header = deref(ctx, rawHeader, location.child(['headers', name]));
    if (isObject(header.node) && header.node.schema !== undefined) {
      callback(header.node.schema, header.location.child(['schema']), name);
    }
  }
}

// Finds a header of a response by name, case-insensitively, and resolves it.
function findHeader(ctx, response, location, name) {
  if (!isObject(response.headers)) {
    return undefined;
  }
  const key = Object.keys(response.headers).find((header) => header.toLowerCase() === name.toLowerCase());
  if (key === undefined) {
    return undefined;
  }
  const resolved = deref(ctx, response.headers[key], location.child(['headers', key]));
  return { key, header: resolved.node, location: resolved.location };
}

// Calls `callback` for `schema` and every schema nested in it, following `$ref`,
// the forms of draft-07 included: AsyncAPI schemas are draft-07. It does not
// enter `not`: that schema describes data that must not be there. Schemas
// already in `seen` are skipped.
function walkSchema(ctx, schema, location, callback, seen = new Set()) {
  const { node, location: nodeLocation } = deref(ctx, schema, location);
  if (!isObject(node) || seen.has(nodeLocation.absolutePointer)) {
    return;
  }
  seen.add(nodeLocation.absolutePointer);
  callback(node, nodeLocation);
  const single = ['items', 'additionalProperties', 'contains', 'propertyNames', 'if', 'then', 'else',
    'unevaluatedItems', 'unevaluatedProperties', 'contentSchema', 'additionalItems'];
  for (const keyword of single) {
    if (isObject(node[keyword])) {
      walkSchema(ctx, node[keyword], nodeLocation.child([keyword]), callback, seen);
    }
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items']) {
    if (Array.isArray(node[keyword])) {
      node[keyword].forEach((item, index) => {
        walkSchema(ctx, item, nodeLocation.child([keyword, String(index)]), callback, seen);
      });
    }
  }
  for (const keyword of ['properties', 'patternProperties', 'dependentSchemas', 'dependencies']) {
    if (isObject(node[keyword])) {
      for (const [name, item] of Object.entries(node[keyword])) {
        walkSchema(ctx, item, nodeLocation.child([keyword, name]), callback, seen);
      }
    }
  }
}

// Calls `callback(name, kind, location)` for every property of `schema`, at
// any depth, whose name is personal data or the booking token.
function forEachSensitiveProperty(ctx, schema, location, callback) {
  walkSchema(ctx, schema, location, (node, nodeLocation) => {
    if (!isObject(node.properties)) {
      return;
    }
    for (const name of Object.keys(node.properties)) {
      const kind = sensitiveKind(name);
      if (kind !== undefined) {
        callback(name, kind, nodeLocation.child(['properties', name]).key());
      }
    }
  });
}

function usesScheme(operation, scheme) {
  return Array.isArray(operation.security)
    && operation.security.some((requirement) => isObject(requirement)
      && Object.prototype.hasOwnProperty.call(requirement, scheme));
}

// Every root operation of the AsyncAPI document `root`, which lies at
// `location`: `{ node, location }` after $ref resolution, plus `channel`, the
// absolute pointer of its channel, undefined if the channel is not a $ref.
function rootOperations(ctx, root, location) {
  const operations = deref(ctx, root.operations, location.child(['operations']));
  if (!isObject(operations.node)) {
    return [];
  }
  return Object.entries(operations.node)
    .map(([name, operation]) => deref(ctx, operation, operations.location.child([name])))
    .filter((operation) => isObject(operation.node))
    .map((operation) => ({
      ...operation,
      channel: isRef(operation.node.channel)
        ? deref(ctx, operation.node.channel, operation.location.child(['channel'])).location.absolutePointer
        : undefined,
    }));
}

// Every channel of the root channels, `{ node, location }` after $ref
// resolution.
function rootChannels(ctx, root, location) {
  const channels = deref(ctx, root.channels, location.child(['channels']));
  if (!isObject(channels.node)) {
    return [];
  }
  return Object.entries(channels.node)
    .map(([name, channel]) => deref(ctx, channel, channels.location.child([name])))
    .filter((channel) => isObject(channel.node));
}

// Every message of a channel, `{ node, location }` after $ref resolution.
function channelMessages(ctx, channel) {
  const messages = deref(ctx, channel.node.messages, channel.location.child(['messages']));
  if (!isObject(messages.node)) {
    return [];
  }
  return Object.entries(messages.node)
    .map(([name, message]) => deref(ctx, message, messages.location.child([name])))
    .filter((message) => isObject(message.node));
}

// Calls `callback({ channel, messages, operations })` for every channel of the
// AsyncAPI document `root`, which lies at `location`, that gets the rules of
// events (see NON_EVENT_PROTOCOLS). The channel, its messages and its root
// operations are `{ node, location }` after $ref resolution.
function forEachEventChannel(ctx, root, location, callback) {
  const servers = deref(ctx, root.servers, location.child(['servers']));
  const rootServers = isObject(servers.node)
    ? Object.entries(servers.node).map(([name, server]) => deref(ctx, server, servers.location.child([name])))
    : [];
  const operations = rootOperations(ctx, root, location);
  for (const channel of rootChannels(ctx, root, location)) {
    const listed = Array.isArray(channel.node.servers) ? channel.node.servers : [];
    const channelServers = listed.length > 0
      ? listed.map((server, index) => deref(ctx, server, channel.location.child(['servers', String(index)])))
      : rootServers;
    const messages = channelMessages(ctx, channel);
    const channelOperations = operations.filter((operation) => operation.channel === channel.location.absolutePointer);
    const outsideKafka = channelServers.length > 0
      && channelServers.every((server) => isObject(server.node) && NON_EVENT_PROTOCOLS.includes(server.node.protocol)
        && kafkaBinding(ctx, server) === undefined)
      && kafkaBinding(ctx, channel) === undefined
      && messages.every((message) => !hasKafkaBinding(ctx, message))
      && channelOperations.every((operation) => !hasKafkaBinding(ctx, operation));
    if (!outsideKafka) {
      callback({ channel, messages, operations: channelOperations });
    }
  }
}

// Whether a message or an operation has a Kafka binding, its own or from one
// of its traits.
function hasKafkaBinding(ctx, owner) {
  if (kafkaBinding(ctx, owner) !== undefined) {
    return true;
  }
  const traits = deref(ctx, owner.node.traits, owner.location.child(['traits']));
  return Array.isArray(traits.node) && traits.node.some((trait, index) => {
    const resolved = deref(ctx, trait, traits.location.child([String(index)]));
    return isObject(resolved.node) && kafkaBinding(ctx, resolved) !== undefined;
  });
}

// The Kafka binding of a channel or a message, `{ node, location }`, or
// undefined if it has none.
function kafkaBinding(ctx, owner) {
  const bindings = deref(ctx, owner.node.bindings, owner.location.child(['bindings']));
  if (!isObject(bindings.node)) {
    return undefined;
  }
  const kafka = deref(ctx, bindings.node.kafka, bindings.location.child(['kafka']));
  return isObject(kafka.node) ? kafka : undefined;
}

// Whether a $ref, resolved from `location`, points to $defs/<name> of a .json
// file whose path matches `file`; any $defs entry if `name` is undefined.
function refersToDefinition(ctx, node, location, file, name) {
  if (!isRef(node)) {
    return false;
  }
  const resolved = ctx.resolve(node, location.source.absoluteRef);
  if (!resolved || !resolved.location) {
    return false;
  }
  const { source, pointer } = resolved.location;
  const definition = pointer.match(/^#\/\$defs\/([^/]+)$/);
  return file.test(source.absoluteRef) && definition !== null && (name === undefined || definition[1] === name);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isErrorCode(code) {
  return /^[45](?:[0-9]{2}|XX)$/i.test(code);
}

function sameMembers(actual, expected) {
  return actual.length === expected.length && expected.every((item) => actual.includes(item));
}

// The header must be present, be required and, if `checkSchema` is given,
// have a schema that passes it.
function checkRequiredHeader(ctx, report, response, location, name, checkSchema) {
  const found = findHeader(ctx, response, location, name);
  if (found === undefined || !isObject(found.header)) {
    report(`${name} header is missing`, location);
    return;
  }
  if (found.header.required !== true) {
    report(`${name} header must have required: true`, found.location);
  }
  if (checkSchema !== undefined) {
    const schema = deref(ctx, found.header.schema, found.location.child(['schema']));
    const problem = checkSchema(schema.node);
    if (problem !== undefined) {
      report(`${name} header schema ${problem}`, isObject(schema.node) ? schema.location : found.location);
    }
  }
}

// Only GET /v1/hotels/{hotel_id}/search and POST /v1/hotels/{hotel_id}/bookings
// may go without credentials: elsewhere `security` lists requirements, none of
// them empty. The exception is a pair of method and path, which filters of a
// configurable rule cannot select.
function SecurityEmptyOnlyGuest() {
  return {
    Paths(paths, ctx) {
      const report = createReporter(ctx);
      forEachOperation(ctx, paths, (op) => {
        const { security } = op.operation;
        if (GUEST_OPERATIONS.includes(op.key) || security === undefined) {
          return;
        }
        const secured = Array.isArray(security) && security.length > 0
          && security.every((requirement) => isObject(requirement) && Object.keys(requirement).length > 0);
        if (!secured) {
          report(`${op.key} must require credentials: only ${GUEST_OPERATIONS.join(' and ')} may have an empty security list or an empty requirement`, op.location.child(['security']));
        }
      });
    },
  };
}

// Every 401: a required WWW-Authenticate header with `enum: [Bearer]`, and
// application/problem+json as the only media type. The response, the header
// and its schema are usually separate $ref, three levels deep.
function UnauthorizedShape() {
  return {
    Paths(paths, ctx) {
      const report = createReporter(ctx);
      forEachOperation(ctx, paths, (op) => {
        forEachResponse(ctx, op, ({ code, response, location }) => {
          if (code !== '401') {
            return;
          }
          const reportFor401 = (message, at) => report(`401 response: ${message}`, at);
          checkRequiredHeader(ctx, reportFor401, response, location, 'WWW-Authenticate', (schema) => (
            isObject(schema) && isDeepStrictEqual(schema.enum, ['Bearer']) ? undefined : 'must have enum: [Bearer]'
          ));
          const mediaTypes = isObject(response.content) ? Object.keys(response.content) : [];
          if (!sameMembers(mediaTypes, [PROBLEM_JSON])) {
            reportFor401(`content must be only ${PROBLEM_JSON}, found: ${mediaTypes.join(', ') || 'none'}`, location);
          }
        });
      });
    },
  };
}

// A required Cache-Control header with exactly the pattern of
// CacheControlNoStore: on the 201 of booking creation, on every 2xx of an
// operation secured by bookingToken, and on every response whose body can
// carry personal data or the booking token. The conditions are on the
// operation and on the body; the check is two $ref deeper.
function NoStoreCacheControl() {
  return {
    Paths(paths, ctx) {
      const report = createReporter(ctx);
      forEachOperation(ctx, paths, (op) => {
        const byToken = usesScheme(op.operation, BOOKING_TOKEN_SCHEME);
        const isCreate = op.key === CREATE_BOOKING;
        if (isCreate && !(isObject(op.operation.responses) && op.operation.responses['201'] !== undefined)) {
          report(`${CREATE_BOOKING} must have a 201 response with the Cache-Control header`, op.location);
        }
        forEachResponse(ctx, op, ({ code, response, location }) => {
          let applies = (isCreate && code === '201') || (byToken && /^2(?:[0-9]{2}|XX)$/i.test(code));
          if (!applies) {
            forEachContentSchema(response, location, (schema, schemaLocation) => {
              forEachSensitiveProperty(ctx, schema, schemaLocation, () => {
                applies = true;
              });
            });
          }
          if (!applies) {
            return;
          }
          checkRequiredHeader(ctx, (message, at) => report(`${code} response: ${message}`, at), response, location,
            'Cache-Control', (schema) => (
              isObject(schema) && schema.pattern === NO_STORE_PATTERN
                ? undefined
                : `must have exactly the pattern of CacheControlNoStore in common.v1.yaml: ${NO_STORE_PATTERN}`
            ));
        });
      });
    },
  };
}

// Media types of 4xx and 5xx: application/problem+json only; public 429 is
// text/plain only; public 502, 503 and 504 are both; internal operations
// have no text/plain at all. The branch depends on the path and the code.
function ErrorMediaTypes() {
  return {
    Paths(paths, ctx) {
      const report = createReporter(ctx);
      forEachOperation(ctx, paths, (op) => {
        forEachResponse(ctx, op, ({ code, response, location }) => {
          const mediaTypes = isObject(response.content) ? Object.keys(response.content) : [];
          const found = mediaTypes.join(', ') || 'none';
          if (op.internal && mediaTypes.includes(TEXT_PLAIN)) {
            report(`${code} response of an internal operation must not have ${TEXT_PLAIN}`, location);
            return;
          }
          if (!isErrorCode(code)) {
            return;
          }
          let expected = [PROBLEM_JSON];
          if (!op.internal && code === '429') {
            expected = [TEXT_PLAIN];
          } else if (!op.internal && ['502', '503', '504'].includes(code)) {
            expected = [PROBLEM_JSON, TEXT_PLAIN];
          }
          if (!sameMembers(mediaTypes, expected)) {
            const kind = op.internal ? 'internal' : 'public';
            report(`${code} response of a ${kind} operation must have content ${expected.join(' and ')}, found: ${found}`, location);
          }
        });
      });
    },
  };
}

// Every reference in the application/problem+json schema - the $ref itself or
// a member of its oneOf - names a Problem Details type allowed for the status
// code; other codes have no application/problem+json at all. The allowed set
// depends on the code and, for 400, 404, 409 and 422, on the kind of
// operation. The form of the schema is checked by rule/problem-details-ref.
function ProblemTypeByCode() {
  return {
    Paths(paths, ctx) {
      const report = createReporter(ctx);
      forEachOperation(ctx, paths, (op) => {
        forEachResponse(ctx, op, ({ code, response, location }) => {
          if (!isObject(response.content) || !isObject(response.content[PROBLEM_JSON])) {
            return;
          }
          const schemaLocation = location.child(['content', PROBLEM_JSON, 'schema']);
          const allowed = allowedProblemTypes(code, op.internal);
          if (allowed === undefined) {
            report(`${code} response must not have ${PROBLEM_JSON}: no Problem Details type is defined for this code`, schemaLocation);
            return;
          }
          const { schema } = response.content[PROBLEM_JSON];
          const refs = [];
          if (isRef(schema)) {
            refs.push([schema.$ref, schemaLocation]);
          } else if (isObject(schema) && Array.isArray(schema.oneOf)) {
            schema.oneOf.forEach((member, index) => {
              if (isRef(member)) {
                refs.push([member.$ref, schemaLocation.child(['oneOf', String(index)])]);
              }
            });
          }
          const kind = op.internal ? 'an internal' : 'a public';
          for (const [ref, at] of refs) {
            const match = PROBLEM_TYPE_REF.exec(ref);
            if (match !== null && !allowed.includes(match[1])) {
              report(`${code} response of ${kind} operation must not use Problem Details type ${match[1]}; allowed: ${allowed.join(', ')}`, at);
            }
          }
        });
      });
    },
  };
}

// Every 429 has a required Retry-After header, usually a $ref in a $ref.
function RetryAfter429() {
  return {
    Paths(paths, ctx) {
      const report = createReporter(ctx);
      forEachOperation(ctx, paths, (op) => {
        forEachResponse(ctx, op, ({ code, response, location }) => {
          if (code === '429') {
            checkRequiredHeader(ctx, (message, at) => report(`429 response: ${message}`, at), response, location, 'Retry-After');
          }
        });
      });
    },
  };
}

// The 503 of an internal operation has a required Retry-After header.
function RetryAfter503Internal() {
  return {
    Paths(paths, ctx) {
      const report = createReporter(ctx);
      forEachOperation(ctx, paths, (op) => {
        if (!op.internal) {
          return;
        }
        forEachResponse(ctx, op, ({ code, response, location }) => {
          if (code === '503') {
            checkRequiredHeader(ctx, (message, at) => report(`503 response of an internal operation: ${message}`, at), response, location, 'Retry-After');
          }
        });
      });
    },
  };
}

// Personal data appears only in the request bodies of the operations in
// `allowedRequests` and in responses of the operations in `allowedResponses`;
// the booking token only in the 201 response of booking creation. Neither
// appears in parameters. Names are matched as described at PII_PARTS; schemas
// are followed through every $ref.
function PiiPlacement(options) {
  const { allowedRequests, allowedResponses } = options;
  for (const [name, list] of Object.entries({ allowedRequests, allowedResponses })) {
    if (!Array.isArray(list) || !list.every((item) => /^[A-Z]+ \/\S*$/.test(item))) {
      throw new Error(`contracts/pii-placement: option ${name} must be a list of "METHOD path", empty if none`);
    }
  }
  const personalDataPlaces = (allowedRequests.length > 0 ? `the request bodies of ${allowedRequests.join(', ')}` : 'no request body')
    + (allowedResponses.length > 0 ? ` and responses of ${allowedResponses.join(', ')}` : '');
  const allowedPlaces = {
    [PERSONAL_DATA]: personalDataPlaces,
    [BOOKING_TOKEN]: `the 201 response of ${CREATE_BOOKING}`,
  };
  return {
    Paths(paths, ctx) {
      const report = createReporter(ctx);
      const reportField = (name, kind, place, location) => {
        report(`${kind === PERSONAL_DATA ? 'Personal data' : 'Booking token'} field "${name}" is not allowed in ${place}; it may appear only in ${allowedPlaces[kind]}`, location);
      };
      const checkSchema = (schema, location, place, isAllowed) => {
        forEachSensitiveProperty(ctx, schema, location, (name, kind, propertyLocation) => {
          if (!isAllowed(kind)) {
            reportField(name, kind, place, propertyLocation);
          }
        });
      };
      const nothingAllowed = () => false;
      forEachOperation(ctx, paths, (op) => {
        forEachParameter(ctx, op, ({ parameter, location }) => {
          const place = `parameter ${parameter.name} of ${op.key}`;
          const kind = sensitiveKind(parameter.name);
          if (kind !== undefined) {
            reportField(parameter.name, kind, `the parameters of ${op.key}`, location.child(['name']));
          }
          if (parameter.schema !== undefined) {
            checkSchema(parameter.schema, location.child(['schema']), place, nothingAllowed);
          }
        });
        if (op.operation.requestBody !== undefined) {
          const body = deref(ctx, op.operation.requestBody, op.location.child(['requestBody']));
          if (isObject(body.node)) {
            forEachContentSchema(body.node, body.location, (schema, location) => {
              checkSchema(schema, location, `the request body of ${op.key}`,
                (kind) => kind === PERSONAL_DATA && allowedRequests.includes(op.key));
            });
          }
        }
        forEachResponse(ctx, op, ({ code, response, location }) => {
          const place = `response ${code} of ${op.key}`;
          const isAllowed = (kind) => (kind === PERSONAL_DATA
            ? allowedResponses.includes(op.key)
            : op.key === CREATE_BOOKING && code === '201');
          forEachContentSchema(response, location, (schema, schemaLocation) => {
            checkSchema(schema, schemaLocation, place, isAllowed);
          });
          if (isObject(response.headers)) {
            for (const name of Object.keys(response.headers)) {
              const kind = sensitiveKind(name);
              if (kind !== undefined && !isAllowed(kind)) {
                reportField(name, kind, `the headers of ${place}`, location.child(['headers', name]).key());
              }
            }
          }
          forEachHeaderSchema(ctx, response, location, (schema, schemaLocation, name) => {
            checkSchema(schema, schemaLocation, `header ${name} of ${place}`, isAllowed);
          });
        });
      });
    },
  };
}

// Every object schema in the request body of a public operation, nested ones
// included, has `additionalProperties: false`. A nested `where` in a
// configurable rule reaches only the top schema of the body. Webhooks of the
// channels are the exception: their bodies are open, see WebhookShape.
function PublicRequestClosed() {
  return {
    Paths(paths, ctx) {
      const report = createReporter(ctx);
      forEachOperation(ctx, paths, (op) => {
        if (op.internal || op.webhook || op.operation.requestBody === undefined) {
          return;
        }
        const body = deref(ctx, op.operation.requestBody, op.location.child(['requestBody']));
        if (!isObject(body.node)) {
          return;
        }
        forEachContentSchema(body.node, body.location, (schema, location) => {
          walkSchema(ctx, schema, location, (node, nodeLocation) => {
            if (typesOf(node).includes('object') && node.additionalProperties !== false) {
              report('Object schema in the request body of a public operation must have additionalProperties: false', nodeLocation);
            }
          });
        });
      });
    },
  };
}

// Webhooks of the channels. The operations under WEBHOOK_PATH and the
// operations secured by channelApiKey are the same set, and each of them:
// a) has a path of WEBHOOK_PATH_FORM, so the channel and the hotel are signed
//    with the path, the channel is checked against its key, and no template
//    after them brings an external booking id into the path;
// b) has `security` of exactly one requirement, channelApiKey;
// c) is a POST with a required body of application/json only;
// d) has the header parameters X-Timestamp and X-Signature, required and with
//    the exact patterns of SIGNATURE_HEADER_PATTERNS;
// e) has no query parameters: a query string would carry unsigned data, and a
//    webhook with one gets 401;
// f) has an open body at any depth: no `additionalProperties` other than
//    true and no `maxProperties`. A closed body would refuse a new field of
//    the channel with 422, and a channel does not retry a 4xx.
// Parameters come from two lists and through $ref, and the body is checked at
// any depth, which a configurable rule cannot do.
function WebhookShape() {
  return {
    Paths(paths, ctx) {
      const report = createReporter(ctx);
      forEachOperation(ctx, paths, (op) => {
        const byKey = usesScheme(op.operation, CHANNEL_KEY_SCHEME);
        if (!op.webhook && !byKey) {
          return;
        }
        if (!WEBHOOK_PATH_FORM.test(op.path) || !byKey) {
          report(`${op.key}: a webhook has a path ${WEBHOOK_PREFIX} and one kebab-case segment, and channelApiKey; channelApiKey is used only by webhooks`, op.location);
        }
        if (!isDeepStrictEqual(op.operation.security, [{ [CHANNEL_KEY_SCHEME]: [] }])) {
          report(`${op.key}: security of a webhook must be exactly [{${CHANNEL_KEY_SCHEME}: []}]`, op.location.child(['security']));
        }
        if (!op.key.startsWith('POST ')) {
          report(`${op.key}: a webhook is a POST`, op.location);
        }
        const body = deref(ctx, op.operation.requestBody, op.location.child(['requestBody']));
        if (!isObject(body.node) || body.node.required !== true) {
          report(`${op.key}: a webhook has a required request body`, op.location);
        }
        const mediaTypes = isObject(body.node) && isObject(body.node.content) ? Object.keys(body.node.content) : [];
        if (!sameMembers(mediaTypes, [JSON_MEDIA_TYPE])) {
          report(`${op.key}: the request body of a webhook must have only ${JSON_MEDIA_TYPE}, found: ${mediaTypes.join(', ') || 'none'}`, op.location);
        }
        const headers = new Map();
        forEachParameter(ctx, op, ({ parameter, location }) => {
          if (parameter.in === 'header' && typeof parameter.name === 'string') {
            headers.set(parameter.name.toLowerCase(), { parameter, location });
          } else if (parameter.in === 'query') {
            report(`${op.key}: a webhook has no query parameters: a query string would not be signed`, location);
          }
        });
        for (const [name, pattern] of Object.entries(SIGNATURE_HEADER_PATTERNS)) {
          const found = headers.get(name.toLowerCase());
          if (found === undefined) {
            report(`${op.key}: the header parameter ${name} of a webhook is missing`, op.location);
            continue;
          }
          if (found.parameter.required !== true) {
            report(`${op.key}: the header parameter ${name} of a webhook must have required: true`, found.location);
          }
          const schema = deref(ctx, found.parameter.schema, found.location.child(['schema']));
          if (!isObject(schema.node) || schema.node.pattern !== pattern) {
            report(`${op.key}: the schema of the header parameter ${name} must have exactly the pattern ${pattern}`, isObject(schema.node) ? schema.location : found.location);
          }
        }
        if (isObject(body.node)) {
          forEachContentSchema(body.node, body.location, (schema, location) => {
            walkSchema(ctx, schema, location, (node, nodeLocation) => {
              if ((node.additionalProperties !== undefined && node.additionalProperties !== true)
                || node.maxProperties !== undefined) {
                report('Object schema in the request body of a webhook must stay open, without additionalProperties other than true and without maxProperties: a channel does not retry a 4xx', nodeLocation);
              }
            });
          });
        }
      });
    },
  };
}

const COMPOSITION_KEYWORDS = ['allOf', 'anyOf', 'oneOf'];

// Collects the fields of `schema`, which lies at `location`, into
// `result.found` as "name", "name.nested" or "name[].item": names of
// properties joined with dots, [] after the name of an array, each with the
// location of its first property. Follows $ref, allOf, anyOf and oneOf. Also
// collects what makes a list of fields meaningless: `result.open` - an object
// without properties, which would take any nested field under one name - and
// `result.recursive` - a schema that contains itself, whose fields have no
// end. `ancestry` holds the schemas on the way down to the current one.
function collectFields(ctx, schema, location, prefix, result, ancestry = new Set()) {
  const { node, location: nodeLocation } = deref(ctx, schema, location);
  if (!isObject(node)) {
    return;
  }
  const pointer = nodeLocation.absolutePointer;
  if (ancestry.has(pointer)) {
    result.recursive.push(nodeLocation.key());
    return;
  }
  ancestry.add(pointer);
  const composed = COMPOSITION_KEYWORDS.filter((keyword) => Array.isArray(node[keyword]));
  for (const keyword of composed) {
    node[keyword].forEach((item, index) => {
      collectFields(ctx, item, nodeLocation.child([keyword, String(index)]), prefix, result, ancestry);
    });
  }
  if (isObject(node.items)) {
    collectFields(ctx, node.items, nodeLocation.child(['items']), `${prefix}[]`, result, ancestry);
  }
  const hasProperties = isObject(node.properties) && Object.keys(node.properties).length > 0;
  if (typesOf(node).includes('object') && !hasProperties && composed.length === 0) {
    result.open.push({ field: prefix, location: nodeLocation.key() });
  }
  if (hasProperties) {
    for (const [name, property] of Object.entries(node.properties)) {
      const field = prefix === '' ? name : `${prefix}.${name}`;
      if (!result.found.has(field)) {
        result.found.set(field, nodeLocation.child(['properties', name]).key());
      }
      collectFields(ctx, property, nodeLocation.child(['properties', name]), field, result, ancestry);
    }
  }
  ancestry.delete(pointer);
}

// The body of every webhook has exactly the fields listed for its path in the
// option `fields`: the allowed list. The bodies are open, and what the list
// names is all that channel-sync stores and passes on; a new field, personal
// data included, is a deliberate change of the list. The fields are collected
// from the whole tree of the body, through $ref, allOf, anyOf and oneOf, so
// none slips in through a nested schema, a branch or another component; a
// configurable rule would see one component at a time. An object without
// properties and a schema that contains itself are refused: either would put
// any number of fields behind one line of the list. Only application/json
// is checked: contracts/webhook-shape reports other media types, a missing
// body and a path that is not of WEBHOOK_PATH_FORM.
function WebhookFields(options) {
  const { fields } = options;
  if (!isObject(fields) || !Object.entries(fields).every(([path, list]) => WEBHOOK_PATH_FORM.test(path)
    && Array.isArray(list) && list.every((field) => typeof field === 'string' && WEBHOOK_FIELD.test(field)))) {
    throw new Error('contracts/webhook-fields: option fields must map webhook paths to lists of fields, such as guest.first_name or room_types[].rooms');
  }
  return {
    Paths(paths, ctx) {
      const report = createReporter(ctx);
      forEachOperation(ctx, paths, (op) => {
        if (!WEBHOOK_PATH_FORM.test(op.path)) {
          return;
        }
        const expected = fields[op.path];
        if (!Array.isArray(expected)) {
          report(`${op.key}: a webhook must have the list of its fields in the option fields of contracts/webhook-fields`, op.location);
          return;
        }
        const body = deref(ctx, op.operation.requestBody, op.location.child(['requestBody']));
        const media = isObject(body.node) && isObject(body.node.content) ? body.node.content[JSON_MEDIA_TYPE] : undefined;
        if (!isObject(media) || media.schema === undefined) {
          return;
        }
        const location = body.location.child(['content', JSON_MEDIA_TYPE, 'schema']);
        const result = { found: new Map(), open: [], recursive: [] };
        collectFields(ctx, media.schema, location, '', result);
        for (const [field, at] of result.found) {
          if (!expected.includes(field)) {
            report(`${op.key}: field ${field} is not in the list of the webhook in contracts/webhook-fields; a new field is a deliberate change of the list`, at);
          }
        }
        for (const field of expected.filter((item) => !result.found.has(item))) {
          report(`${op.key}: field ${field} of the list in contracts/webhook-fields is missing from the body`, location);
        }
        for (const { field, location: at } of result.open) {
          report(`${op.key}: ${field === '' ? 'the body' : `field ${field}`} is an object without properties: under one name of the list it would take any nested field`, at);
        }
        for (const at of result.recursive) {
          report(`${op.key}: the body of a webhook contains a schema that contains itself: its list of fields would have no end`, at);
        }
      });
    },
  };
}

// Every object schema in a response body or header, nested ones, array items
// and oneOf/anyOf branches included, has non-empty `properties` and
// `additionalProperties: false`. A `type: object` wrapper with oneOf or anyOf
// and without `properties` is checked through its branches. A nested `where`
// in a configurable rule reaches only the top schema of a response.
function ResponseClosed() {
  return {
    Paths(paths, ctx) {
      const report = createReporter(ctx);
      const check = (schema, location) => {
        walkSchema(ctx, schema, location, (node, nodeLocation) => {
          if (!typesOf(node).includes('object')) {
            return;
          }
          const hasProperties = isObject(node.properties) && Object.keys(node.properties).length > 0;
          if (!hasProperties) {
            if (!Array.isArray(node.oneOf) && !Array.isArray(node.anyOf)) {
              report('Object schema in a response must list its properties, or be a oneOf or anyOf wrapper without properties', nodeLocation);
            }
            return;
          }
          if (node.additionalProperties !== false) {
            report('Object schema in a response must have additionalProperties: false', nodeLocation);
          }
        });
      };
      forEachOperation(ctx, paths, (op) => {
        forEachResponse(ctx, op, ({ response, location }) => {
          forEachContentSchema(response, location, check);
          forEachHeaderSchema(ctx, response, location, check);
        });
      });
    },
  };
}

// There are no webhooks and no callbacks in v1: the rules of this plugin walk
// `paths` only. One rule over two node types, the root and the operation.
function NoWebhooksCallbacks() {
  return {
    Root(root, ctx) {
      if (root.webhooks !== undefined) {
        ctx.report({ message: 'webhooks are not used in v1: the contract rules check only paths', location: ctx.location.child(['webhooks']).key() });
      }
    },
    Operation(operation, ctx) {
      if (operation.callbacks !== undefined) {
        ctx.report({ message: 'callbacks are not used in v1: the contract rules check only paths', location: ctx.location.child(['callbacks']).key() });
      }
    },
  };
}

// A string schema has maxLength, enum, or format date or uuid.
// The condition on `type` and the check of the `format` value are on one
// node, which a configurable rule with one subject cannot combine.
function StringLimit() {
  return {
    Schema(schema, ctx) {
      if (!typesOf(schema).includes('string')) {
        return;
      }
      if (typeof schema.maxLength === 'number' || Array.isArray(schema.enum)
        || LIMITING_STRING_FORMATS.includes(schema.format)) {
        return;
      }
      ctx.report({
        message: `String schema must have maxLength, enum, or format ${LIMITING_STRING_FORMATS.join(', ')}`,
        location: ctx.location,
      });
    },
  };
}

// A schema with `additionalProperties: false` has non-empty `properties` and
// no `allOf`: a key check and a value check on the same node.
function SubsetClosedObject() {
  return {
    Schema(schema, ctx) {
      if (schema.additionalProperties !== false) {
        return;
      }
      if (!isObject(schema.properties) || Object.keys(schema.properties).length === 0) {
        ctx.report({
          message: 'Schema with additionalProperties: false must have non-empty properties on the same level',
          location: ctx.location.child(['additionalProperties']).key(),
        });
      }
      if (schema.allOf !== undefined) {
        ctx.report({
          message: 'Schema with additionalProperties: false must not use allOf: it does not see properties of allOf members',
          location: ctx.location.child(['allOf']).key(),
        });
      }
    },
  };
}

// What keeps `pattern` from holding the whole string, or undefined if it holds
// it. JSON Schema finds a pattern anywhere in the value: without ^ any head
// passes, without the end any tail - an external id a/../x by its tail x, a
// timestamp of 13 digits by its first ten. Redocly reads a pattern as ECMA-262
// with flag u and league as PCRE, and both must see the same anchors. So the
// pattern:
// 1) compiles as ECMA-262 with flag u. A construct of PCRE alone could end a
//    match of league early: after (*ACCEPT) any tail passes;
// 2) starts with ^;
// 3) ends with a group at the top level that is exactly PATTERN_END. The text
//    at the end is not enough: in ^(a\(?![\s\S]) its ( is escaped, in
//    ^(a[(?![\s\S]) it lies in a class, and the last ) closes group 1;
// 4) has no | outside groups and classes: an alternative at the top level
//    holds one end of the string only;
// 5) has neither [] nor [^], nor [: [. [= inside a class. A class of ECMA-262
//    ends at the first ], while PCRE takes a ] right after [ or [^ as a literal
//    and [:alpha:] inside a class as a POSIX class, and reads on, up to the ]
//    of the end of the string.
// The pattern is read by the rules of ECMA-262 with flag u: a backslash
// escapes the next character, a class ends at the first unescaped ], and [
// inside a class is a literal. Given 1) and 5), PCRE either finds the same
// groups and classes or does not compile the pattern, as with [:a-z:], a POSIX
// class outside a class for PCRE, and then league rejects every value.
function patternProblem(pattern) {
  try {
    new RegExp(pattern, 'u');
  } catch (error) {
    return `it does not compile as ECMA-262 with flag u, the way Redocly compiles it: ${error.message}`;
  }
  let depth = 0;
  let inClass = false;
  let groupStart = -1;
  let lastGroup;
  let alternative = false;
  let emptyClass = false;
  let posixClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '\\') {
      i += 1;
    } else if (inClass) {
      if (c === ']') {
        inClass = false;
      } else if (c === '[' && [':', '.', '='].includes(pattern[i + 1])) {
        posixClass = true;
      }
    } else if (c === '[') {
      inClass = true;
      if (pattern[i + 1] === ']' || (pattern[i + 1] === '^' && pattern[i + 2] === ']')) {
        emptyClass = true;
      }
    } else if (c === '(') {
      if (depth === 0) {
        groupStart = i;
      }
      depth += 1;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) {
        lastGroup = { start: groupStart, end: i };
      }
    } else if (c === '|' && depth === 0) {
      alternative = true;
    }
  }
  const problems = [];
  if (!pattern.startsWith('^')) {
    problems.push('it does not start with ^');
  }
  if (lastGroup === undefined || lastGroup.end !== pattern.length - 1
    || pattern.slice(lastGroup.start) !== PATTERN_END) {
    problems.push(`it does not end with the group ${PATTERN_END} at the top level`);
  }
  if (alternative) {
    problems.push('it has | outside groups and classes');
  }
  if (emptyClass) {
    problems.push('it has [] or [^], which PCRE reads on past the ]');
  }
  if (posixClass) {
    problems.push('it has [: [. or [= inside a class, a POSIX class for PCRE');
  }
  return problems.length > 0 ? problems.join('; ') : undefined;
}

// Reports the pattern of `schema` if it does not hold the whole string, see
// patternProblem(). NO_STORE_PATTERN is left to the caller if `noStoreByUse`.
function checkPattern(schema, ctx, noStoreByUse) {
  const { pattern } = schema;
  if (typeof pattern !== 'string' || (noStoreByUse && pattern === NO_STORE_PATTERN)) {
    return;
  }
  const problem = pattern === NO_STORE_PATTERN
    ? 'it is the pattern of CacheControlNoStore, which may stand only in a schema written in the object of a Cache-Control response header'
    : patternProblem(pattern);
  if (problem !== undefined) {
    ctx.report({
      message: `Pattern must hold the whole string, the same in ECMA-262 and in PCRE: ${problem}`,
      location: ctx.location.child(['pattern']),
    });
  }
}

// The place of a schema written in a header object itself: a header of a
// response or of components/headers.
const HEADER_SCHEMA_POINTER = /(?:^#\/components|\/responses\/[^/]+)\/headers\/[^/]+\/schema$/;

// Every pattern holds the whole string, see patternProblem(). The one
// exception is NO_STORE_PATTERN in the schema of a Cache-Control response
// header: it looks for the no-store directive anywhere in a list of
// directives, and contracts/no-store-cache-control requires exactly it there.
// Whether the exception holds depends on how a schema is used, while through
// $ref one schema may serve a header and a body, and the walker visits it
// once. So the rule decides in two steps:
// - the Schema visitor reports NO_STORE_PATTERN anywhere but in a schema
//   written in a header object itself, at HEADER_SCHEMA_POINTER;
// - the Paths visitor follows every use of a schema in the operations -
//   parameters, request bodies, response bodies and headers, with their
//   content - through $ref, and reports a schema of a header with the pattern
//   used anywhere but as the schema itself of a Cache-Control response header.
// The headers of `encoding` in multipart bodies are not followed: a schema
// written in one of them is reported by the Schema visitor, but one taken from
// a header through $ref would pass.
function PatternAnchored() {
  return {
    Schema(schema, ctx) {
      checkPattern(schema, ctx, HEADER_SCHEMA_POINTER.test(ctx.location.pointer));
    },
    Paths(paths, ctx) {
      const report = createReporter(ctx);
      // Reports the schemas of headers with NO_STORE_PATTERN in `schema` and
      // every schema in it, except `allowed`.
      const refuse = (schema, location, place, allowed) => {
        walkSchema(ctx, schema, location, (node, nodeLocation) => {
          if (node.pattern === NO_STORE_PATTERN && node !== allowed && HEADER_SCHEMA_POINTER.test(nodeLocation.pointer)) {
            report(`The pattern of CacheControlNoStore may appear only in the schema of a Cache-Control response header, not in ${place}: elsewhere it holds neither end of the value`, nodeLocation.child(['pattern']));
          }
        });
      };
      // The schema of a parameter or a header and the schemas of its content.
      const refuseIn = (owner, location, place, allowed) => {
        if (owner.schema !== undefined) {
          refuse(owner.schema, location.child(['schema']), place, allowed);
        }
        forEachContentSchema(owner, location, (schema, schemaLocation) => refuse(schema, schemaLocation, place));
      };
      forEachOperation(ctx, paths, (op) => {
        forEachParameter(ctx, op, ({ parameter, location }) => {
          refuseIn(parameter, location, `parameter ${parameter.name} of ${op.key}`);
        });
        if (op.operation.requestBody !== undefined) {
          const body = deref(ctx, op.operation.requestBody, op.location.child(['requestBody']));
          if (isObject(body.node)) {
            forEachContentSchema(body.node, body.location, (schema, location) => {
              refuse(schema, location, `the request body of ${op.key}`);
            });
          }
        }
        forEachResponse(ctx, op, ({ code, response, location }) => {
          const place = `response ${code} of ${op.key}`;
          forEachContentSchema(response, location, (schema, schemaLocation) => {
            refuse(schema, schemaLocation, `the body of ${place}`);
          });
          const headers = isObject(response.headers) ? response.headers : {};
          for (const [name, rawHeader] of Object.entries(headers)) {
            const header = deref(ctx, rawHeader, location.child(['headers', name]));
            if (!isObject(header.node)) {
              continue;
            }
            const allowed = name.toLowerCase() === 'cache-control' && header.node.schema !== undefined
              ? deref(ctx, header.node.schema, header.location.child(['schema'])).node
              : undefined;
            refuseIn(header.node, header.location, `header ${name} of ${place}`, allowed);
          }
        });
      });
    },
  };
}

// AsyncAPI documents have no HTTP headers, so the exception does not apply.
function PatternAnchoredAsync() {
  return {
    Schema(schema, ctx) {
      checkPattern(schema, ctx, false);
    },
  };
}

// The form of $ref for the response validator: an external one starts with
// ../ and has no ./ or .. after that; a local one in a YAML document points
// into #/components/ if `localInComponents`; $defs are referenced only in
// .json files. Only a `ref` visitor sees the raw $ref string.
function checkRefForm(node, ctx, localInComponents) {
  const ref = node.$ref;
  const hash = ref.indexOf('#');
  const file = hash === -1 ? ref : ref.slice(0, hash);
  const fragment = hash === -1 ? '' : ref.slice(hash);
  const currentFile = ctx.location.source.absoluteRef;
  const location = ctx.location.child(['$ref']);
  if (file !== '') {
    const rest = file.replace(/^(?:\.\.\/)+/, '');
    if (rest === file || rest === '' || rest.includes('./') || rest.includes('..') || rest.includes('\\')) {
      ctx.report({
        message: `External $ref must start with one or more ../ and contain no ./ or .. after them: ${ref}`,
        location,
      });
    }
  } else if (localInComponents && /\.ya?ml$/i.test(currentFile) && !fragment.startsWith('#/components/')) {
    ctx.report({ message: `Local $ref in a YAML document must point into #/components/: ${ref}`, location });
  }
  const targetFile = file === '' ? currentFile : file;
  if (fragment.includes('/$defs/') && !/\.json$/i.test(targetFile)) {
    ctx.report({ message: `$ref into $defs is allowed only into a .json file: ${ref}`, location });
  }
}

function RefForm() {
  return {
    ref: {
      enter(node, ctx) {
        checkRefForm(node, ctx, true);
      },
    },
  };
}

// In an AsyncAPI document a local $ref goes where AsyncAPI 3 says: to a
// channel, a message of a channel, a server or a component. External
// references keep the form above: they lead to the schemas that the services
// read with the response validator.
function RefFormAsync() {
  return {
    ref: {
      enter(node, ctx) {
        checkRefForm(node, ctx, false);
      },
    },
  };
}

// Names of all fields of the schemas of an event, at any depth. Names inside
// `payload` are from `payloadFields`, the other names of the body and of the
// message headers from `envelopeFields`: a name of the envelope, such as
// `number`, cannot come back inside the payload. A string of the payload is an
// enum or has format uuid, date or date-time, so no free text. A name of
// personal data, of the booking token or of what EVENT_SENSITIVE_PARTS lists
// is refused even if it is in a list.
function EventFields(options) {
  const lists = { envelope: options.envelopeFields, payload: options.payloadFields };
  for (const [part, names] of Object.entries(lists)) {
    if (!Array.isArray(names) || !names.every((name) => typeof name === 'string' && FIELD_NAME.test(name))) {
      throw new Error(`contracts/event-fields: option ${part}Fields must be a list of snake_case ASCII field names`);
    }
    const refused = names.filter((name) => eventSensitiveKind(name) !== undefined);
    if (refused.length > 0) {
      throw new Error(`contracts/event-fields: ${part}Fields must not list personal data, the booking token or indirect identifiers: ${refused.join(', ')}`);
    }
  }
  return {
    Root(root, ctx) {
      const report = createReporter(ctx);
      const checkNames = (part) => (node, nodeLocation) => {
        if (!isObject(node.properties)) {
          return;
        }
        for (const name of Object.keys(node.properties)) {
          const location = nodeLocation.child(['properties', name]).key();
          const kind = eventSensitiveKind(name);
          if (kind !== undefined) {
            report(`Field "${name}" is ${kind}: events carry none of them, even if the name is in a list of contracts/event-fields`, location);
          } else if (!lists[part].includes(name)) {
            report(`Field "${name}" is not in ${part}Fields of contracts/event-fields: a new field of an event is added to that list deliberately`, location);
          }
        }
      };
      const checkPayload = (node, nodeLocation) => {
        checkNames('payload')(node, nodeLocation);
        if (typesOf(node).includes('string') && !Array.isArray(node.enum) && !CLOSED_STRING_FORMATS.includes(node.format)) {
          report(`String of an event payload must be an enum or have format ${CLOSED_STRING_FORMATS.join(', ')}: free text may carry personal data`, nodeLocation.key());
        }
        if (typesOf(node).includes('string') && node.format === 'date-time'
          && !(typeof node.maxLength === 'number' && node.maxLength <= DATE_TIME_MAX_LENGTH)) {
          report(`A date-time of an event payload must have maxLength of at most ${DATE_TIME_MAX_LENGTH}: a longer fraction of a second could hold any digits`, nodeLocation.key());
        }
      };
      forEachEventChannel(ctx, root, ctx.location, ({ messages }) => {
        for (const message of messages) {
          // The payload goes first, so the walk of the envelope skips it.
          const seen = new Set();
          const body = deref(ctx, message.node.payload, message.location.child(['payload']));
          if (isObject(body.node) && isObject(body.node.properties) && body.node.properties.payload !== undefined) {
            walkSchema(ctx, body.node.properties.payload, body.location.child(['properties', 'payload']), checkPayload, seen);
          }
          for (const keyword of ['payload', 'headers']) {
            if (message.node[keyword] !== undefined) {
              walkSchema(ctx, message.node[keyword], message.location.child([keyword]), checkNames('envelope'), seen);
            }
          }
        }
      });
    },
  };
}

// The body of every message of an event channel is the envelope:
// - the fields are only those of ENVELOPE_FIELDS, and those of
//   ENVELOPE_REQUIRED are required;
// - each field of ENVELOPE_REFS is a $ref to its definition in
//   envelope.v1.json;
// - `type` is a string with one value, the name of the message, and that
//   name is <topic>.<name>.v<major> of the topic of the channel;
// - `payload` is a $ref to a $defs entry of a .json file, with hotel_id
//   required;
// - `version` is required in a compacted topic and absent in the others.
// The channel has an address <topic>.v<major>, a Kafka binding and at least
// one message. A message has a Kafka binding with a key whose pattern holds
// only ids and dates, the hotel first, and has neither headers nor traits:
// a record carries everything in its envelope, and a trait could add headers
// or bindings past these checks.
function EventEnvelope() {
  return {
    Root(root, ctx) {
      const report = createReporter(ctx);
      forEachEventChannel(ctx, root, ctx.location, ({ channel, messages }) => {
        const channelBinding = kafkaBinding(ctx, channel);
        if (channelBinding === undefined) {
          report('Event channel must have bindings.kafka with the partitions and the configuration of its topic', channel.location.key());
        }
        if (messages.length === 0) {
          report('Event channel must have at least one message', channel.location.key());
        }
        const topic = typeof channel.node.address === 'string' ? TOPIC_ADDRESS.exec(channel.node.address) : null;
        if (topic === null) {
          report('Address of an event channel must be its topic: dotted snake_case names and .v<major>, without parameters', channel.location.key());
        }
        if (channel.node.parameters !== undefined) {
          report('Event channel has no parameters: a parameter of the address could put personal data into the name of the topic', channel.location.child(['parameters']).key());
        }
        const typeName = topic === null ? null : new RegExp(`^${escapeRegExp(topic[1])}\\.[a-z][a-z0-9_]*\\.${topic[2]}$`);
        const configuration = channelBinding === undefined ? {}
          : deref(ctx, channelBinding.node.topicConfiguration, channelBinding.location.child(['topicConfiguration']));
        const compacted = isObject(configuration.node) && Array.isArray(configuration.node['cleanup.policy'])
          && configuration.node['cleanup.policy'].includes('compact');

        for (const message of messages) {
          for (const keyword of ['headers', 'traits']) {
            if (message.node[keyword] !== undefined) {
              report(`Message of an event channel has no ${keyword}: a record carries everything in its envelope`, message.location.child([keyword]).key());
            }
          }
          const messageBinding = kafkaBinding(ctx, message);
          if (messageBinding === undefined || messageBinding.node.key === undefined) {
            report('Message of an event channel must have bindings.kafka.key: the schema of the record key', message.location.key());
          } else {
            const key = deref(ctx, messageBinding.node.key, messageBinding.location.child(['key']));
            if (!isObject(key.node) || !typesOf(key.node).includes('string') || !isEventKeyPattern(key.node.pattern)) {
              report(`Record key must be a string whose pattern holds only ids and dates: ^${KEY_UUID}, the hotel, then segments :${KEY_UUID} or :${KEY_DATE}, then ${PATTERN_END}`, key.location.key());
            }
          }

          const name = message.node.name;
          if (typeof name !== 'string') {
            report('Message of an event channel must have a name, its message type', message.location.key());
          } else if (typeName !== null && !typeName.test(name)) {
            report(`Name of the message must be ${topic[1]}.<name>.${topic[2]}, a type of the topic of its channel`, message.location.key());
          }
          const body = deref(ctx, message.node.payload, message.location.child(['payload']));
          if (!isObject(body.node) || !isObject(body.node.properties)) {
            report('Message of an event channel must have a payload: an object schema of the envelope', message.location.key());
            continue;
          }
          const properties = body.node.properties;
          const required = Array.isArray(body.node.required) ? body.node.required : [];
          for (const field of Object.keys(properties)) {
            if (!ENVELOPE_FIELDS.includes(field)) {
              report(`Field "${field}" is not a field of the envelope; data of the message goes into payload`, body.location.child(['properties', field]).key());
            }
          }
          for (const field of ENVELOPE_REQUIRED.filter((item) => !required.includes(item) || properties[item] === undefined)) {
            report(`Envelope field "${field}" must be defined and required`, body.location.key());
          }
          for (const [field, definition] of Object.entries(ENVELOPE_REFS)) {
            const location = body.location.child(['properties', field]);
            if (properties[field] !== undefined && !refersToDefinition(ctx, properties[field], location, ENVELOPE_FILE, definition)) {
              report(`Envelope field "${field}" must be a $ref to envelope.v1.json#/$defs/${definition}`, location.key());
            }
          }
          if (properties.type !== undefined) {
            const type = deref(ctx, properties.type, body.location.child(['properties', 'type']));
            const values = isObject(type.node) && Array.isArray(type.node.enum) ? type.node.enum : [];
            if (!typesOf(type.node || {}).includes('string') || values.length !== 1 || values[0] !== name) {
              report('Envelope field "type" must be a string with one enum value, the name of the message', type.location.key());
            }
          }
          if (properties.payload !== undefined) {
            const location = body.location.child(['properties', 'payload']);
            const payload = deref(ctx, properties.payload, location);
            if (!refersToDefinition(ctx, properties.payload, location, /\.json$/i, undefined)) {
              report('Envelope field "payload" must be a $ref to a $defs entry of a .json file', location.key());
            } else if (!isObject(payload.node) || !Array.isArray(payload.node.required) || !payload.node.required.includes('hotel_id')) {
              report('Payload of an event must require hotel_id: the hotel is in every event', payload.location.key());
            }
          }
          if (compacted && (properties.version === undefined || !required.includes('version'))) {
            report('Message of a compacted topic must have a required version: a receiver keeps the newest state of a key by it', body.location.key());
          }
          if (!compacted && properties.version !== undefined) {
            report('Message of a topic without compaction has no version', body.location.child(['properties', 'version']).key());
          }
        }
      });
    },
  };
}

// Every object schema of an event, nested ones included, is closed: tests of
// the publisher then catch a field outside the contract, personal data
// included.
function EventClosed() {
  return {
    Root(root, ctx) {
      const report = createReporter(ctx);
      forEachEventChannel(ctx, root, ctx.location, ({ messages }) => {
        for (const message of messages) {
          for (const keyword of ['payload', 'headers']) {
            if (message.node[keyword] === undefined) {
              continue;
            }
            walkSchema(ctx, message.node[keyword], message.location.child([keyword]), (node, nodeLocation) => {
              if ((typesOf(node).includes('object') || isObject(node.properties)) && node.additionalProperties !== false) {
                report('Object schema of an event must have additionalProperties: false', nodeLocation.key());
              }
              for (const [name, property] of Object.entries(isObject(node.properties) ? node.properties : {})) {
                if (typeof property === 'boolean') {
                  report(`Property "${name}" of an event must have a schema, not ${property}: true admits any value`, nodeLocation.child(['properties', name]).key());
                }
              }
            });
          }
        }
      });
    },
  };
}

// Access to the event topics, from which the deployment builds topics and
// ACLs. Every root operation goes through a root channel and messages of that
// channel: the rules of events and the check of examples see only those. Per
// event channel: one channel per topic, exactly one send operation - the
// publisher - and every operation names its service in x-service, one of
// `services`; a receive operation reads with the Kafka group named after its
// service (ADR-0002). Operations of event channels have neither traits, which
// could change their bindings, nor a reply: an event has no reply.
function EventAccess(options) {
  const services = options.services;
  if (!Array.isArray(services) || services.length === 0 || !services.every((name) => typeof name === 'string')) {
    throw new Error('contracts/event-access: option services must be a list of service names');
  }
  return {
    Root(root, ctx) {
      const report = createReporter(ctx);
      const channels = new Map(rootChannels(ctx, root, ctx.location)
        .map((channel) => [channel.location.absolutePointer, channel]));
      for (const operation of rootOperations(ctx, root, ctx.location)) {
        const channel = channels.get(operation.channel);
        if (channel === undefined) {
          report('Operation must have channel, a $ref to a channel of the root channels', operation.location.key());
          continue;
        }
        const allowed = new Set(channelMessages(ctx, channel).map((message) => message.location.absolutePointer));
        const messages = Array.isArray(operation.node.messages) ? operation.node.messages : [];
        messages.forEach((message, index) => {
          const location = operation.location.child(['messages', String(index)]);
          if (!isRef(message) || !allowed.has(deref(ctx, message, location).location.absolutePointer)) {
            report('Message of an operation must be a $ref to a message of its channel', location.key());
          }
        });
        const reply = deref(ctx, operation.node.reply, operation.location.child(['reply']));
        if (isObject(reply.node) && reply.node.channel !== undefined) {
          const replyChannel = isRef(reply.node.channel)
            ? deref(ctx, reply.node.channel, reply.location.child(['channel'])).location.absolutePointer
            : undefined;
          if (!channels.has(replyChannel)) {
            report('Reply channel of an operation must be a $ref to a channel of the root channels', reply.location.key());
          }
        }
      }

      const topics = new Set();
      forEachEventChannel(ctx, root, ctx.location, ({ channel, operations }) => {
        const address = channel.node.address;
        if (typeof address === 'string') {
          if (topics.has(address)) {
            report(`Topic ${address} has another channel: one topic is one channel, with one publisher`, channel.location.key());
          }
          topics.add(address);
        }
        const sends = operations.filter((operation) => operation.node.action === 'send').length;
        if (sends !== 1) {
          report(`Event channel must have exactly one send operation, its publisher; it has ${sends}`, channel.location.key());
        }
        for (const operation of operations) {
          if (operation.node.traits !== undefined) {
            report('Operation of an event channel has no traits: a trait could change its bindings past this rule', operation.location.child(['traits']).key());
          }
          if (operation.node.reply !== undefined) {
            report('Operation of an event channel has no reply: an event has no reply', operation.location.child(['reply']).key());
          }
          const service = operation.node['x-service'];
          if (!services.includes(service)) {
            report(`Operation of an event channel must name its service in x-service, one of ${services.join(', ')}`, operation.location.key());
          } else if (operation.node.action === 'receive') {
            const binding = kafkaBinding(ctx, operation);
            const group = binding === undefined ? {} : deref(ctx, binding.node.groupId, binding.location.child(['groupId']));
            const values = isObject(group.node) && Array.isArray(group.node.enum) ? group.node.enum : [];
            if (values.length !== 1 || values[0] !== service) {
              report(`Receive operation must have bindings.kafka.groupId with the one value ${service}, the name of its service`, operation.location.key());
            }
          }
        }
      });
    },
  };
}

// A $ref has no sibling keys: the response validator ignores them. The
// walker resolves $ref before other visitors, so only a `ref` visitor sees them.
function RefSiblings() {
  return {
    ref: {
      enter(node, ctx) {
        const siblings = Object.keys(node).filter((key) => key !== '$ref');
        if (siblings.length > 0) {
          ctx.report({
            message: `$ref must have no sibling keys, found: ${siblings.join(', ')}; the response validator ignores them, use allOf instead`,
            location: ctx.location.child([siblings[0]]).key(),
          });
        }
      },
    },
  };
}

module.exports = function contractsPlugin() {
  return {
    id: 'contracts',
    rules: {
      oas3: {
        'security-empty-only-guest': SecurityEmptyOnlyGuest,
        'unauthorized-shape': UnauthorizedShape,
        'no-store-cache-control': NoStoreCacheControl,
        'error-media-types': ErrorMediaTypes,
        'problem-type-by-code': ProblemTypeByCode,
        'retry-after-429': RetryAfter429,
        'retry-after-503-internal': RetryAfter503Internal,
        'pii-placement': PiiPlacement,
        'public-request-closed': PublicRequestClosed,
        'webhook-shape': WebhookShape,
        'webhook-fields': WebhookFields,
        'response-closed': ResponseClosed,
        'no-webhooks-callbacks': NoWebhooksCallbacks,
        'string-limit': StringLimit,
        'subset-closed-object': SubsetClosedObject,
        'pattern-anchored': PatternAnchored,
        'ref-form': RefForm,
        'ref-siblings': RefSiblings,
      },
      async3: {
        'string-limit': StringLimit,
        'subset-closed-object': SubsetClosedObject,
        'pattern-anchored': PatternAnchoredAsync,
        'ref-form': RefFormAsync,
        'ref-siblings': RefSiblings,
        'event-fields': EventFields,
        'event-envelope': EventEnvelope,
        'event-closed': EventClosed,
        'event-access': EventAccess,
      },
    },
    typeExtension: {
      // Redocly 2.60.0 knows only some keys of topicConfiguration of the Kafka
      // channel binding and reports the others as not expected, while the
      // JSON Schema of the Kafka bindings 0.5.0 allows any key there
      // (additionalProperties: true). The topics need min.compaction.lag.ms.
      async3(types) {
        const configuration = types.KafkaTopicConfiguration;
        return {
          ...types,
          KafkaTopicConfiguration: {
            ...configuration,
            properties: { ...configuration.properties, 'min.compaction.lag.ms': { type: 'integer' } },
          },
        };
      },
    },
  };
};
