'use strict';

/*
 * Redocly CLI plugin for bin/check.sh, not for redocly.yaml. Its rules report
 * what Redocly read and walked, as problems that check.sh reads back:
 * - version: the openapi and asyncapi fields of a document, as JSON.
 *   check.sh switches it on only in oas3_1Rules and async3Rules, so a report
 *   also proves that the rules of these sections ran on the document: a
 *   document of another version passes the lint with no rule of them;
 * - schemas: every $defs entry of a .json file that the walker visits as a
 *   schema, as <file>#/$defs/<name>. The rules of schemas see only those.
 */

const DEFINITION_POINTER = /^#\/\$defs\/[^/]+$/;

function Version() {
  return {
    Root(root, ctx) {
      ctx.report({ message: JSON.stringify({ openapi: root.openapi, asyncapi: root.asyncapi }), location: ctx.location });
    },
  };
}

function Schemas() {
  return {
    Schema(schema, ctx) {
      const file = ctx.location.source.absoluteRef;
      if (file.endsWith('.json') && DEFINITION_POINTER.test(ctx.location.pointer)) {
        ctx.report({ message: `${file}${ctx.location.pointer}`, location: ctx.location });
      }
    },
  };
}

module.exports = function lintProbePlugin() {
  return {
    id: 'probe',
    rules: {
      oas3: { version: Version, schemas: Schemas },
      async3: { version: Version, schemas: Schemas },
    },
  };
};
