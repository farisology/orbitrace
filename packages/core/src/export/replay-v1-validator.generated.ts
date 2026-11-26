/* eslint-disable */
// @ts-nocheck
// GENERATED FILE. Do not edit by hand.
//
// Precompiled validator for packages/core/schema/replay-v1.schema.json, produced by Ajv
// 8.20.0 standalone code with the options in test/export/validator-source.ts.
// Shipping precompiled code means export and validation need no Ajv and no `new Function`
// at run time. test/export/validator-source.test.ts fails when this file no longer matches
// the schema. To regenerate, from packages/core run:
//   npx vitest run -u test/export/validator-source.test.ts
"use strict";
export const validate = validate20;
export default validate20;
const schema31 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/farisology/orbitrace/blob/dev/packages/core/schema/replay-v1.schema.json",
  title: "Orbitrace replay, format version 1",
  description:
    "Structure-only replay of one agent session. Times are seconds from the session start on the compressed timeline. No text, tool inputs or outputs, paths, command lines, working directory, branch, title, session id or subagent description. Every object rejects properties it does not list.",
  type: "object",
  additionalProperties: false,
  required: ["formatVersion", "agents", "warps", "totals"],
  properties: {
    formatVersion: { const: 1 },
    agents: {
      description: "Main agent first, then subagents in id order (a1, a2, ...).",
      type: "array",
      minItems: 1,
      prefixItems: [{ $ref: "#/$defs/mainAgent" }],
      items: { $ref: "#/$defs/subagent" },
    },
    warps: {
      description: "Idle gaps removed from the timeline, in 'at' order.",
      type: "array",
      items: { $ref: "#/$defs/warp" },
    },
    totals: { $ref: "#/$defs/sessionTotals" },
  },
  $defs: {
    seconds: {
      description: "Seconds from session start on the compressed timeline.",
      type: "number",
      minimum: 0,
    },
    secondsOrNull: { type: ["number", "null"], minimum: 0 },
    count: { type: "integer", minimum: 0 },
    agentRef: { type: "string", pattern: "^(main|a[1-9][0-9]{0,5})$" },
    agentName: {
      description: "Agent type, such as code-reviewer. An identifier: no spaces.",
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$",
    },
    callsign: {
      description: "Agent name, plus #n when the name repeats.",
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}(#[1-9][0-9]{0,5})?$",
    },
    model: {
      description: "Model id, such as claude-opus-5-5, or null when unknown.",
      type: ["string", "null"],
      pattern: "^[a-z0-9][a-z0-9._-]{0,63}$",
    },
    family: {
      description:
        "Model family, an open lower-case identifier derived from the model id (for Claude, the word after claude-). Known to the renderer: fable, opus, sonnet, haiku, unknown. A renderer draws any other value as unknown.",
      type: "string",
      pattern: "^[a-z][a-z0-9-]{0,31}$",
    },
    effort: { enum: ["low", "medium", "high", "xhigh", "max", null] },
    toolName: {
      description:
        "Runtime tool name for display, or mcp:<server> for an MCP tool. The raw mcp__<server>__<tool> form is rejected.",
      type: "string",
      pattern: "^(mcp:[A-Za-z0-9][A-Za-z0-9._-]{0,63}|[A-Za-z][A-Za-z0-9_]{0,63})$",
      not: { pattern: "^mcp__" },
    },
    toolKind: {
      description:
        "What the call does, independent of the runtime. Renderers decide colour and behaviour from this field only; name is a label.",
      enum: ["shell", "read", "edit", "agent", "mcp", "other"],
    },
    toolCall: {
      type: "object",
      additionalProperties: false,
      required: ["name", "kind", "start", "end", "failed"],
      properties: {
        name: { $ref: "#/$defs/toolName" },
        kind: { $ref: "#/$defs/toolKind" },
        start: { $ref: "#/$defs/seconds" },
        end: { $ref: "#/$defs/secondsOrNull" },
        failed: { type: "boolean" },
      },
      description: "kind is mcp exactly when name starts with mcp:.",
      if: { properties: { name: { type: "string", pattern: "^mcp:" } } },
      then: { properties: { kind: { const: "mcp" } } },
      else: { properties: { kind: { not: { const: "mcp" } } } },
    },
    reply: {
      type: "object",
      additionalProperties: false,
      required: ["t", "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"],
      properties: {
        t: { $ref: "#/$defs/seconds" },
        inputTokens: { $ref: "#/$defs/count" },
        outputTokens: { $ref: "#/$defs/count" },
        cacheReadTokens: { $ref: "#/$defs/count" },
        cacheCreationTokens: { $ref: "#/$defs/count" },
      },
    },
    agentTotals: {
      type: "object",
      additionalProperties: false,
      required: [
        "toolCalls",
        "failedToolCalls",
        "replies",
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheCreationTokens",
      ],
      properties: {
        toolCalls: { $ref: "#/$defs/count" },
        failedToolCalls: { $ref: "#/$defs/count" },
        replies: { $ref: "#/$defs/count" },
        inputTokens: { $ref: "#/$defs/count" },
        outputTokens: { $ref: "#/$defs/count" },
        cacheReadTokens: { $ref: "#/$defs/count" },
        cacheCreationTokens: { $ref: "#/$defs/count" },
      },
    },
    sessionTotals: {
      type: "object",
      additionalProperties: false,
      required: [
        "agents",
        "toolCalls",
        "failedToolCalls",
        "replies",
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheCreationTokens",
        "duration",
        "realDuration",
      ],
      properties: {
        agents: { $ref: "#/$defs/count" },
        toolCalls: { $ref: "#/$defs/count" },
        failedToolCalls: { $ref: "#/$defs/count" },
        replies: { $ref: "#/$defs/count" },
        inputTokens: { $ref: "#/$defs/count" },
        outputTokens: { $ref: "#/$defs/count" },
        cacheReadTokens: { $ref: "#/$defs/count" },
        cacheCreationTokens: { $ref: "#/$defs/count" },
        duration: { $ref: "#/$defs/seconds" },
        realDuration: { type: "number", minimum: 0 },
      },
    },
    mainAgent: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "name",
        "callsign",
        "model",
        "family",
        "effort",
        "parent",
        "wave",
        "start",
        "end",
        "tools",
        "replies",
        "totals",
      ],
      properties: {
        id: { const: "main" },
        name: { const: "main" },
        callsign: { const: "main" },
        model: { $ref: "#/$defs/model" },
        family: { $ref: "#/$defs/family" },
        effort: { $ref: "#/$defs/effort" },
        parent: { type: "null" },
        wave: { type: "null" },
        start: { $ref: "#/$defs/seconds" },
        end: { $ref: "#/$defs/secondsOrNull" },
        tools: { type: "array", items: { $ref: "#/$defs/toolCall" } },
        replies: { type: "array", items: { $ref: "#/$defs/reply" } },
        totals: { $ref: "#/$defs/agentTotals" },
      },
    },
    subagent: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "name",
        "callsign",
        "model",
        "family",
        "effort",
        "parent",
        "wave",
        "start",
        "end",
        "tools",
        "replies",
        "totals",
      ],
      properties: {
        id: { type: "string", pattern: "^a[1-9][0-9]{0,5}$" },
        name: { $ref: "#/$defs/agentName" },
        callsign: { $ref: "#/$defs/callsign" },
        model: { $ref: "#/$defs/model" },
        family: { $ref: "#/$defs/family" },
        effort: { $ref: "#/$defs/effort" },
        parent: { $ref: "#/$defs/agentRef" },
        wave: { $ref: "#/$defs/count" },
        start: { $ref: "#/$defs/seconds" },
        end: { $ref: "#/$defs/secondsOrNull" },
        tools: { type: "array", items: { $ref: "#/$defs/toolCall" } },
        replies: { type: "array", items: { $ref: "#/$defs/reply" } },
        totals: { $ref: "#/$defs/agentTotals" },
      },
    },
    warp: {
      type: "object",
      additionalProperties: false,
      required: ["at", "skipped"],
      properties: {
        at: { $ref: "#/$defs/seconds" },
        skipped: { type: "number", exclusiveMinimum: 0 },
      },
    },
  },
};
const schema32 = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "callsign",
    "model",
    "family",
    "effort",
    "parent",
    "wave",
    "start",
    "end",
    "tools",
    "replies",
    "totals",
  ],
  properties: {
    id: { const: "main" },
    name: { const: "main" },
    callsign: { const: "main" },
    model: { $ref: "#/$defs/model" },
    family: { $ref: "#/$defs/family" },
    effort: { $ref: "#/$defs/effort" },
    parent: { type: "null" },
    wave: { type: "null" },
    start: { $ref: "#/$defs/seconds" },
    end: { $ref: "#/$defs/secondsOrNull" },
    tools: { type: "array", items: { $ref: "#/$defs/toolCall" } },
    replies: { type: "array", items: { $ref: "#/$defs/reply" } },
    totals: { $ref: "#/$defs/agentTotals" },
  },
};
const schema33 = {
  description: "Model id, such as claude-opus-5-5, or null when unknown.",
  type: ["string", "null"],
  pattern: "^[a-z0-9][a-z0-9._-]{0,63}$",
};
const schema34 = {
  description:
    "Model family, an open lower-case identifier derived from the model id (for Claude, the word after claude-). Known to the renderer: fable, opus, sonnet, haiku, unknown. A renderer draws any other value as unknown.",
  type: "string",
  pattern: "^[a-z][a-z0-9-]{0,31}$",
};
const schema35 = { enum: ["low", "medium", "high", "xhigh", "max", null] };
const schema36 = {
  description: "Seconds from session start on the compressed timeline.",
  type: "number",
  minimum: 0,
};
const schema37 = { type: ["number", "null"], minimum: 0 };
const func1 = Object.prototype.hasOwnProperty;
const pattern4 = new RegExp("^[a-z0-9][a-z0-9._-]{0,63}$", "u");
const pattern5 = new RegExp("^[a-z][a-z0-9-]{0,31}$", "u");
const schema38 = {
  type: "object",
  additionalProperties: false,
  required: ["name", "kind", "start", "end", "failed"],
  properties: {
    name: { $ref: "#/$defs/toolName" },
    kind: { $ref: "#/$defs/toolKind" },
    start: { $ref: "#/$defs/seconds" },
    end: { $ref: "#/$defs/secondsOrNull" },
    failed: { type: "boolean" },
  },
  description: "kind is mcp exactly when name starts with mcp:.",
  if: { properties: { name: { type: "string", pattern: "^mcp:" } } },
  then: { properties: { kind: { const: "mcp" } } },
  else: { properties: { kind: { not: { const: "mcp" } } } },
};
const schema39 = {
  description:
    "Runtime tool name for display, or mcp:<server> for an MCP tool. The raw mcp__<server>__<tool> form is rejected.",
  type: "string",
  pattern: "^(mcp:[A-Za-z0-9][A-Za-z0-9._-]{0,63}|[A-Za-z][A-Za-z0-9_]{0,63})$",
  not: { pattern: "^mcp__" },
};
const schema40 = {
  description:
    "What the call does, independent of the runtime. Renderers decide colour and behaviour from this field only; name is a label.",
  enum: ["shell", "read", "edit", "agent", "mcp", "other"],
};
const pattern6 = new RegExp("^mcp:", "u");
const pattern7 = new RegExp("^mcp__", "u");
const pattern8 = new RegExp(
  "^(mcp:[A-Za-z0-9][A-Za-z0-9._-]{0,63}|[A-Za-z][A-Za-z0-9_]{0,63})$",
  "u",
);
function validate22(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {},
) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate22.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = undefined;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = undefined;
  }
  const _errs1 = errors;
  let valid0 = true;
  const _errs2 = errors;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.name !== undefined) {
      let data0 = data.name;
      const _errs3 = errors;
      if (errors === _errs3) {
        if (typeof data0 === "string") {
          if (!pattern6.test(data0)) {
            const err0 = {};
            if (vErrors === null) {
              vErrors = [err0];
            } else {
              vErrors.push(err0);
            }
            errors++;
          }
        } else {
          const err1 = {};
          if (vErrors === null) {
            vErrors = [err1];
          } else {
            vErrors.push(err1);
          }
          errors++;
        }
      }
    }
  }
  var _valid0 = _errs2 === errors;
  errors = _errs1;
  if (vErrors !== null) {
    if (_errs1) {
      vErrors.length = _errs1;
    } else {
      vErrors = null;
    }
  }
  let ifClause0;
  if (_valid0) {
    const _errs5 = errors;
    if (data && typeof data == "object" && !Array.isArray(data)) {
      if (data.kind !== undefined) {
        if ("mcp" !== data.kind) {
          const err2 = {
            instancePath: instancePath + "/kind",
            schemaPath: "#/then/properties/kind/const",
            keyword: "const",
            params: { allowedValue: "mcp" },
            message: "must be equal to constant",
          };
          if (vErrors === null) {
            vErrors = [err2];
          } else {
            vErrors.push(err2);
          }
          errors++;
        }
      }
    }
    var _valid0 = _errs5 === errors;
    valid0 = _valid0;
    if (valid0) {
      var props0 = {};
      props0.kind = true;
      props0.name = true;
    }
    ifClause0 = "then";
  } else {
    const _errs7 = errors;
    if (data && typeof data == "object" && !Array.isArray(data)) {
      if (data.kind !== undefined) {
        const _errs9 = errors;
        const _errs10 = errors;
        if ("mcp" !== data.kind) {
          const err3 = {};
          if (vErrors === null) {
            vErrors = [err3];
          } else {
            vErrors.push(err3);
          }
          errors++;
        }
        var valid4 = _errs10 === errors;
        if (valid4) {
          const err4 = {
            instancePath: instancePath + "/kind",
            schemaPath: "#/else/properties/kind/not",
            keyword: "not",
            params: {},
            message: "must NOT be valid",
          };
          if (vErrors === null) {
            vErrors = [err4];
          } else {
            vErrors.push(err4);
          }
          errors++;
        } else {
          errors = _errs9;
          if (vErrors !== null) {
            if (_errs9) {
              vErrors.length = _errs9;
            } else {
              vErrors = null;
            }
          }
        }
      }
    }
    var _valid0 = _errs7 === errors;
    valid0 = _valid0;
    if (valid0) {
      if (props0 !== true) {
        props0 = props0 || {};
        props0.kind = true;
      }
    }
    ifClause0 = "else";
  }
  if (!valid0) {
    const err5 = {
      instancePath,
      schemaPath: "#/if",
      keyword: "if",
      params: { failingKeyword: ifClause0 },
      message: 'must match "' + ifClause0 + '" schema',
    };
    if (vErrors === null) {
      vErrors = [err5];
    } else {
      vErrors.push(err5);
    }
    errors++;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.name === undefined) {
      const err6 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "name" },
        message: "must have required property '" + "name" + "'",
      };
      if (vErrors === null) {
        vErrors = [err6];
      } else {
        vErrors.push(err6);
      }
      errors++;
    }
    if (data.kind === undefined) {
      const err7 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "kind" },
        message: "must have required property '" + "kind" + "'",
      };
      if (vErrors === null) {
        vErrors = [err7];
      } else {
        vErrors.push(err7);
      }
      errors++;
    }
    if (data.start === undefined) {
      const err8 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "start" },
        message: "must have required property '" + "start" + "'",
      };
      if (vErrors === null) {
        vErrors = [err8];
      } else {
        vErrors.push(err8);
      }
      errors++;
    }
    if (data.end === undefined) {
      const err9 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "end" },
        message: "must have required property '" + "end" + "'",
      };
      if (vErrors === null) {
        vErrors = [err9];
      } else {
        vErrors.push(err9);
      }
      errors++;
    }
    if (data.failed === undefined) {
      const err10 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "failed" },
        message: "must have required property '" + "failed" + "'",
      };
      if (vErrors === null) {
        vErrors = [err10];
      } else {
        vErrors.push(err10);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(
        key0 === "name" ||
        key0 === "kind" ||
        key0 === "start" ||
        key0 === "end" ||
        key0 === "failed"
      )) {
        const err11 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
    }
    if (data.name !== undefined) {
      let data3 = data.name;
      const _errs15 = errors;
      const _errs16 = errors;
      if (typeof data3 === "string") {
        if (!pattern7.test(data3)) {
          const err12 = {};
          if (vErrors === null) {
            vErrors = [err12];
          } else {
            vErrors.push(err12);
          }
          errors++;
        }
      }
      var valid7 = _errs16 === errors;
      if (valid7) {
        const err13 = {
          instancePath: instancePath + "/name",
          schemaPath: "#/$defs/toolName/not",
          keyword: "not",
          params: {},
          message: "must NOT be valid",
        };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      } else {
        errors = _errs15;
        if (vErrors !== null) {
          if (_errs15) {
            vErrors.length = _errs15;
          } else {
            vErrors = null;
          }
        }
      }
      if (typeof data3 === "string") {
        if (!pattern8.test(data3)) {
          const err14 = {
            instancePath: instancePath + "/name",
            schemaPath: "#/$defs/toolName/pattern",
            keyword: "pattern",
            params: {
              pattern: "^(mcp:[A-Za-z0-9][A-Za-z0-9._-]{0,63}|[A-Za-z][A-Za-z0-9_]{0,63})$",
            },
            message:
              'must match pattern "' +
              "^(mcp:[A-Za-z0-9][A-Za-z0-9._-]{0,63}|[A-Za-z][A-Za-z0-9_]{0,63})$" +
              '"',
          };
          if (vErrors === null) {
            vErrors = [err14];
          } else {
            vErrors.push(err14);
          }
          errors++;
        }
      } else {
        const err15 = {
          instancePath: instancePath + "/name",
          schemaPath: "#/$defs/toolName/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err15];
        } else {
          vErrors.push(err15);
        }
        errors++;
      }
    }
    if (data.kind !== undefined) {
      let data4 = data.kind;
      if (!(
        data4 === "shell" ||
        data4 === "read" ||
        data4 === "edit" ||
        data4 === "agent" ||
        data4 === "mcp" ||
        data4 === "other"
      )) {
        const err16 = {
          instancePath: instancePath + "/kind",
          schemaPath: "#/$defs/toolKind/enum",
          keyword: "enum",
          params: { allowedValues: schema40.enum },
          message: "must be equal to one of the allowed values",
        };
        if (vErrors === null) {
          vErrors = [err16];
        } else {
          vErrors.push(err16);
        }
        errors++;
      }
    }
    if (data.start !== undefined) {
      let data5 = data.start;
      if (typeof data5 == "number" && isFinite(data5)) {
        if (data5 < 0 || isNaN(data5)) {
          const err17 = {
            instancePath: instancePath + "/start",
            schemaPath: "#/$defs/seconds/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err17];
          } else {
            vErrors.push(err17);
          }
          errors++;
        }
      } else {
        const err18 = {
          instancePath: instancePath + "/start",
          schemaPath: "#/$defs/seconds/type",
          keyword: "type",
          params: { type: "number" },
          message: "must be number",
        };
        if (vErrors === null) {
          vErrors = [err18];
        } else {
          vErrors.push(err18);
        }
        errors++;
      }
    }
    if (data.end !== undefined) {
      let data6 = data.end;
      if (!(typeof data6 == "number" && isFinite(data6)) && data6 !== null) {
        const err19 = {
          instancePath: instancePath + "/end",
          schemaPath: "#/$defs/secondsOrNull/type",
          keyword: "type",
          params: { type: schema37.type },
          message: "must be number,null",
        };
        if (vErrors === null) {
          vErrors = [err19];
        } else {
          vErrors.push(err19);
        }
        errors++;
      }
      if (typeof data6 == "number" && isFinite(data6)) {
        if (data6 < 0 || isNaN(data6)) {
          const err20 = {
            instancePath: instancePath + "/end",
            schemaPath: "#/$defs/secondsOrNull/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err20];
          } else {
            vErrors.push(err20);
          }
          errors++;
        }
      }
    }
    if (data.failed !== undefined) {
      if (typeof data.failed !== "boolean") {
        const err21 = {
          instancePath: instancePath + "/failed",
          schemaPath: "#/properties/failed/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err21];
        } else {
          vErrors.push(err21);
        }
        errors++;
      }
    }
  } else {
    const err22 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err22];
    } else {
      vErrors.push(err22);
    }
    errors++;
  }
  validate22.errors = vErrors;
  return errors === 0;
}
validate22.evaluated = { props: true, dynamicProps: false, dynamicItems: false };
const schema43 = {
  type: "object",
  additionalProperties: false,
  required: ["t", "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"],
  properties: {
    t: { $ref: "#/$defs/seconds" },
    inputTokens: { $ref: "#/$defs/count" },
    outputTokens: { $ref: "#/$defs/count" },
    cacheReadTokens: { $ref: "#/$defs/count" },
    cacheCreationTokens: { $ref: "#/$defs/count" },
  },
};
const schema45 = { type: "integer", minimum: 0 };
function validate24(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {},
) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate24.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = undefined;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = undefined;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.t === undefined) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "t" },
        message: "must have required property '" + "t" + "'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.inputTokens === undefined) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "inputTokens" },
        message: "must have required property '" + "inputTokens" + "'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.outputTokens === undefined) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "outputTokens" },
        message: "must have required property '" + "outputTokens" + "'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.cacheReadTokens === undefined) {
      const err3 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "cacheReadTokens" },
        message: "must have required property '" + "cacheReadTokens" + "'",
      };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.cacheCreationTokens === undefined) {
      const err4 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "cacheCreationTokens" },
        message: "must have required property '" + "cacheCreationTokens" + "'",
      };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(
        key0 === "t" ||
        key0 === "inputTokens" ||
        key0 === "outputTokens" ||
        key0 === "cacheReadTokens" ||
        key0 === "cacheCreationTokens"
      )) {
        const err5 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
    }
    if (data.t !== undefined) {
      let data0 = data.t;
      if (typeof data0 == "number" && isFinite(data0)) {
        if (data0 < 0 || isNaN(data0)) {
          const err6 = {
            instancePath: instancePath + "/t",
            schemaPath: "#/$defs/seconds/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err6];
          } else {
            vErrors.push(err6);
          }
          errors++;
        }
      } else {
        const err7 = {
          instancePath: instancePath + "/t",
          schemaPath: "#/$defs/seconds/type",
          keyword: "type",
          params: { type: "number" },
          message: "must be number",
        };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
    }
    if (data.inputTokens !== undefined) {
      let data1 = data.inputTokens;
      if (!(typeof data1 == "number" && !(data1 % 1) && !isNaN(data1) && isFinite(data1))) {
        const err8 = {
          instancePath: instancePath + "/inputTokens",
          schemaPath: "#/$defs/count/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
      if (typeof data1 == "number" && isFinite(data1)) {
        if (data1 < 0 || isNaN(data1)) {
          const err9 = {
            instancePath: instancePath + "/inputTokens",
            schemaPath: "#/$defs/count/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err9];
          } else {
            vErrors.push(err9);
          }
          errors++;
        }
      }
    }
    if (data.outputTokens !== undefined) {
      let data2 = data.outputTokens;
      if (!(typeof data2 == "number" && !(data2 % 1) && !isNaN(data2) && isFinite(data2))) {
        const err10 = {
          instancePath: instancePath + "/outputTokens",
          schemaPath: "#/$defs/count/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
      if (typeof data2 == "number" && isFinite(data2)) {
        if (data2 < 0 || isNaN(data2)) {
          const err11 = {
            instancePath: instancePath + "/outputTokens",
            schemaPath: "#/$defs/count/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err11];
          } else {
            vErrors.push(err11);
          }
          errors++;
        }
      }
    }
    if (data.cacheReadTokens !== undefined) {
      let data3 = data.cacheReadTokens;
      if (!(typeof data3 == "number" && !(data3 % 1) && !isNaN(data3) && isFinite(data3))) {
        const err12 = {
          instancePath: instancePath + "/cacheReadTokens",
          schemaPath: "#/$defs/count/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err12];
        } else {
          vErrors.push(err12);
        }
        errors++;
      }
      if (typeof data3 == "number" && isFinite(data3)) {
        if (data3 < 0 || isNaN(data3)) {
          const err13 = {
            instancePath: instancePath + "/cacheReadTokens",
            schemaPath: "#/$defs/count/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err13];
          } else {
            vErrors.push(err13);
          }
          errors++;
        }
      }
    }
    if (data.cacheCreationTokens !== undefined) {
      let data4 = data.cacheCreationTokens;
      if (!(typeof data4 == "number" && !(data4 % 1) && !isNaN(data4) && isFinite(data4))) {
        const err14 = {
          instancePath: instancePath + "/cacheCreationTokens",
          schemaPath: "#/$defs/count/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err14];
        } else {
          vErrors.push(err14);
        }
        errors++;
      }
      if (typeof data4 == "number" && isFinite(data4)) {
        if (data4 < 0 || isNaN(data4)) {
          const err15 = {
            instancePath: instancePath + "/cacheCreationTokens",
            schemaPath: "#/$defs/count/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err15];
          } else {
            vErrors.push(err15);
          }
          errors++;
        }
      }
    }
  } else {
    const err16 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err16];
    } else {
      vErrors.push(err16);
    }
    errors++;
  }
  validate24.errors = vErrors;
  return errors === 0;
}
validate24.evaluated = { props: true, dynamicProps: false, dynamicItems: false };
const schema49 = {
  type: "object",
  additionalProperties: false,
  required: [
    "toolCalls",
    "failedToolCalls",
    "replies",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheCreationTokens",
  ],
  properties: {
    toolCalls: { $ref: "#/$defs/count" },
    failedToolCalls: { $ref: "#/$defs/count" },
    replies: { $ref: "#/$defs/count" },
    inputTokens: { $ref: "#/$defs/count" },
    outputTokens: { $ref: "#/$defs/count" },
    cacheReadTokens: { $ref: "#/$defs/count" },
    cacheCreationTokens: { $ref: "#/$defs/count" },
  },
};
function validate26(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {},
) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate26.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = undefined;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = undefined;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.toolCalls === undefined) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "toolCalls" },
        message: "must have required property '" + "toolCalls" + "'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.failedToolCalls === undefined) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "failedToolCalls" },
        message: "must have required property '" + "failedToolCalls" + "'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.replies === undefined) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "replies" },
        message: "must have required property '" + "replies" + "'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.inputTokens === undefined) {
      const err3 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "inputTokens" },
        message: "must have required property '" + "inputTokens" + "'",
      };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.outputTokens === undefined) {
      const err4 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "outputTokens" },
        message: "must have required property '" + "outputTokens" + "'",
      };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.cacheReadTokens === undefined) {
      const err5 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "cacheReadTokens" },
        message: "must have required property '" + "cacheReadTokens" + "'",
      };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    if (data.cacheCreationTokens === undefined) {
      const err6 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "cacheCreationTokens" },
        message: "must have required property '" + "cacheCreationTokens" + "'",
      };
      if (vErrors === null) {
        vErrors = [err6];
      } else {
        vErrors.push(err6);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(
        key0 === "toolCalls" ||
        key0 === "failedToolCalls" ||
        key0 === "replies" ||
        key0 === "inputTokens" ||
        key0 === "outputTokens" ||
        key0 === "cacheReadTokens" ||
        key0 === "cacheCreationTokens"
      )) {
        const err7 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
    }
    if (data.toolCalls !== undefined) {
      let data0 = data.toolCalls;
      if (!(typeof data0 == "number" && !(data0 % 1) && !isNaN(data0) && isFinite(data0))) {
        const err8 = {
          instancePath: instancePath + "/toolCalls",
          schemaPath: "#/$defs/count/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
      if (typeof data0 == "number" && isFinite(data0)) {
        if (data0 < 0 || isNaN(data0)) {
          const err9 = {
            instancePath: instancePath + "/toolCalls",
            schemaPath: "#/$defs/count/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err9];
          } else {
            vErrors.push(err9);
          }
          errors++;
        }
      }
    }
    if (data.failedToolCalls !== undefined) {
      let data1 = data.failedToolCalls;
      if (!(typeof data1 == "number" && !(data1 % 1) && !isNaN(data1) && isFinite(data1))) {
        const err10 = {
          instancePath: instancePath + "/failedToolCalls",
          schemaPath: "#/$defs/count/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
      if (typeof data1 == "number" && isFinite(data1)) {
        if (data1 < 0 || isNaN(data1)) {
          const err11 = {
            instancePath: instancePath + "/failedToolCalls",
            schemaPath: "#/$defs/count/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err11];
          } else {
            vErrors.push(err11);
          }
          errors++;
        }
      }
    }
    if (data.replies !== undefined) {
      let data2 = data.replies;
      if (!(typeof data2 == "number" && !(data2 % 1) && !isNaN(data2) && isFinite(data2))) {
        const err12 = {
          instancePath: instancePath + "/replies",
          schemaPath: "#/$defs/count/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err12];
        } else {
          vErrors.push(err12);
        }
        errors++;
      }
      if (typeof data2 == "number" && isFinite(data2)) {
        if (data2 < 0 || isNaN(data2)) {
          const err13 = {
            instancePath: instancePath + "/replies",
            schemaPath: "#/$defs/count/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err13];
          } else {
            vErrors.push(err13);
          }
          errors++;
        }
      }
    }
    if (data.inputTokens !== undefined) {
      let data3 = data.inputTokens;
      if (!(typeof data3 == "number" && !(data3 % 1) && !isNaN(data3) && isFinite(data3))) {
        const err14 = {
          instancePath: instancePath + "/inputTokens",
          schemaPath: "#/$defs/count/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err14];
        } else {
          vErrors.push(err14);
        }
        errors++;
      }
      if (typeof data3 == "number" && isFinite(data3)) {
        if (data3 < 0 || isNaN(data3)) {
          const err15 = {
            instancePath: instancePath + "/inputTokens",
            schemaPath: "#/$defs/count/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err15];
          } else {
            vErrors.push(err15);
          }
          errors++;
        }
      }
    }
    if (data.outputTokens !== undefined) {
      let data4 = data.outputTokens;
      if (!(typeof data4 == "number" && !(data4 % 1) && !isNaN(data4) && isFinite(data4))) {
        const err16 = {
          instancePath: instancePath + "/outputTokens",
          schemaPath: "#/$defs/count/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err16];
        } else {
          vErrors.push(err16);
        }
        errors++;
      }
      if (typeof data4 == "number" && isFinite(data4)) {
        if (data4 < 0 || isNaN(data4)) {
          const err17 = {
            instancePath: instancePath + "/outputTokens",
            schemaPath: "#/$defs/count/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err17];
          } else {
            vErrors.push(err17);
          }
          errors++;
        }
      }
    }
    if (data.cacheReadTokens !== undefined) {
      let data5 = data.cacheReadTokens;
      if (!(typeof data5 == "number" && !(data5 % 1) && !isNaN(data5) && isFinite(data5))) {
        const err18 = {
          instancePath: instancePath + "/cacheReadTokens",
          schemaPath: "#/$defs/count/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err18];
        } else {
          vErrors.push(err18);
        }
        errors++;
      }
      if (typeof data5 == "number" && isFinite(data5)) {
        if (data5 < 0 || isNaN(data5)) {
          const err19 = {
            instancePath: instancePath + "/cacheReadTokens",
            schemaPath: "#/$defs/count/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err19];
          } else {
            vErrors.push(err19);
          }
          errors++;
        }
      }
    }
    if (data.cacheCreationTokens !== undefined) {
      let data6 = data.cacheCreationTokens;
      if (!(typeof data6 == "number" && !(data6 % 1) && !isNaN(data6) && isFinite(data6))) {
        const err20 = {
          instancePath: instancePath + "/cacheCreationTokens",
          schemaPath: "#/$defs/count/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err20];
        } else {
          vErrors.push(err20);
        }
        errors++;
      }
      if (typeof data6 == "number" && isFinite(data6)) {
        if (data6 < 0 || isNaN(data6)) {
          const err21 = {
            instancePath: instancePath + "/cacheCreationTokens",
            schemaPath: "#/$defs/count/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err21];
          } else {
            vErrors.push(err21);
          }
          errors++;
        }
      }
    }
  } else {
    const err22 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err22];
    } else {
      vErrors.push(err22);
    }
    errors++;
  }
  validate26.errors = vErrors;
  return errors === 0;
}
validate26.evaluated = { props: true, dynamicProps: false, dynamicItems: false };
function validate21(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {},
) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate21.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = undefined;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = undefined;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.id === undefined) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "id" },
        message: "must have required property '" + "id" + "'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.name === undefined) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "name" },
        message: "must have required property '" + "name" + "'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.callsign === undefined) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "callsign" },
        message: "must have required property '" + "callsign" + "'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.model === undefined) {
      const err3 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "model" },
        message: "must have required property '" + "model" + "'",
      };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.family === undefined) {
      const err4 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "family" },
        message: "must have required property '" + "family" + "'",
      };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.effort === undefined) {
      const err5 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "effort" },
        message: "must have required property '" + "effort" + "'",
      };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    if (data.parent === undefined) {
      const err6 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "parent" },
        message: "must have required property '" + "parent" + "'",
      };
      if (vErrors === null) {
        vErrors = [err6];
      } else {
        vErrors.push(err6);
      }
      errors++;
    }
    if (data.wave === undefined) {
      const err7 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "wave" },
        message: "must have required property '" + "wave" + "'",
      };
      if (vErrors === null) {
        vErrors = [err7];
      } else {
        vErrors.push(err7);
      }
      errors++;
    }
    if (data.start === undefined) {
      const err8 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "start" },
        message: "must have required property '" + "start" + "'",
      };
      if (vErrors === null) {
        vErrors = [err8];
      } else {
        vErrors.push(err8);
      }
      errors++;
    }
    if (data.end === undefined) {
      const err9 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "end" },
        message: "must have required property '" + "end" + "'",
      };
      if (vErrors === null) {
        vErrors = [err9];
      } else {
        vErrors.push(err9);
      }
      errors++;
    }
    if (data.tools === undefined) {
      const err10 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "tools" },
        message: "must have required property '" + "tools" + "'",
      };
      if (vErrors === null) {
        vErrors = [err10];
      } else {
        vErrors.push(err10);
      }
      errors++;
    }
    if (data.replies === undefined) {
      const err11 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "replies" },
        message: "must have required property '" + "replies" + "'",
      };
      if (vErrors === null) {
        vErrors = [err11];
      } else {
        vErrors.push(err11);
      }
      errors++;
    }
    if (data.totals === undefined) {
      const err12 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "totals" },
        message: "must have required property '" + "totals" + "'",
      };
      if (vErrors === null) {
        vErrors = [err12];
      } else {
        vErrors.push(err12);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!func1.call(schema32.properties, key0)) {
        const err13 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
    }
    if (data.id !== undefined) {
      if ("main" !== data.id) {
        const err14 = {
          instancePath: instancePath + "/id",
          schemaPath: "#/properties/id/const",
          keyword: "const",
          params: { allowedValue: "main" },
          message: "must be equal to constant",
        };
        if (vErrors === null) {
          vErrors = [err14];
        } else {
          vErrors.push(err14);
        }
        errors++;
      }
    }
    if (data.name !== undefined) {
      if ("main" !== data.name) {
        const err15 = {
          instancePath: instancePath + "/name",
          schemaPath: "#/properties/name/const",
          keyword: "const",
          params: { allowedValue: "main" },
          message: "must be equal to constant",
        };
        if (vErrors === null) {
          vErrors = [err15];
        } else {
          vErrors.push(err15);
        }
        errors++;
      }
    }
    if (data.callsign !== undefined) {
      if ("main" !== data.callsign) {
        const err16 = {
          instancePath: instancePath + "/callsign",
          schemaPath: "#/properties/callsign/const",
          keyword: "const",
          params: { allowedValue: "main" },
          message: "must be equal to constant",
        };
        if (vErrors === null) {
          vErrors = [err16];
        } else {
          vErrors.push(err16);
        }
        errors++;
      }
    }
    if (data.model !== undefined) {
      let data3 = data.model;
      if (typeof data3 !== "string" && data3 !== null) {
        const err17 = {
          instancePath: instancePath + "/model",
          schemaPath: "#/$defs/model/type",
          keyword: "type",
          params: { type: schema33.type },
          message: "must be string,null",
        };
        if (vErrors === null) {
          vErrors = [err17];
        } else {
          vErrors.push(err17);
        }
        errors++;
      }
      if (typeof data3 === "string") {
        if (!pattern4.test(data3)) {
          const err18 = {
            instancePath: instancePath + "/model",
            schemaPath: "#/$defs/model/pattern",
            keyword: "pattern",
            params: { pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" },
            message: 'must match pattern "' + "^[a-z0-9][a-z0-9._-]{0,63}$" + '"',
          };
          if (vErrors === null) {
            vErrors = [err18];
          } else {
            vErrors.push(err18);
          }
          errors++;
        }
      }
    }
    if (data.family !== undefined) {
      let data4 = data.family;
      if (typeof data4 === "string") {
        if (!pattern5.test(data4)) {
          const err19 = {
            instancePath: instancePath + "/family",
            schemaPath: "#/$defs/family/pattern",
            keyword: "pattern",
            params: { pattern: "^[a-z][a-z0-9-]{0,31}$" },
            message: 'must match pattern "' + "^[a-z][a-z0-9-]{0,31}$" + '"',
          };
          if (vErrors === null) {
            vErrors = [err19];
          } else {
            vErrors.push(err19);
          }
          errors++;
        }
      } else {
        const err20 = {
          instancePath: instancePath + "/family",
          schemaPath: "#/$defs/family/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err20];
        } else {
          vErrors.push(err20);
        }
        errors++;
      }
    }
    if (data.effort !== undefined) {
      let data5 = data.effort;
      if (!(
        data5 === "low" ||
        data5 === "medium" ||
        data5 === "high" ||
        data5 === "xhigh" ||
        data5 === "max" ||
        data5 === null
      )) {
        const err21 = {
          instancePath: instancePath + "/effort",
          schemaPath: "#/$defs/effort/enum",
          keyword: "enum",
          params: { allowedValues: schema35.enum },
          message: "must be equal to one of the allowed values",
        };
        if (vErrors === null) {
          vErrors = [err21];
        } else {
          vErrors.push(err21);
        }
        errors++;
      }
    }
    if (data.parent !== undefined) {
      if (data.parent !== null) {
        const err22 = {
          instancePath: instancePath + "/parent",
          schemaPath: "#/properties/parent/type",
          keyword: "type",
          params: { type: "null" },
          message: "must be null",
        };
        if (vErrors === null) {
          vErrors = [err22];
        } else {
          vErrors.push(err22);
        }
        errors++;
      }
    }
    if (data.wave !== undefined) {
      if (data.wave !== null) {
        const err23 = {
          instancePath: instancePath + "/wave",
          schemaPath: "#/properties/wave/type",
          keyword: "type",
          params: { type: "null" },
          message: "must be null",
        };
        if (vErrors === null) {
          vErrors = [err23];
        } else {
          vErrors.push(err23);
        }
        errors++;
      }
    }
    if (data.start !== undefined) {
      let data8 = data.start;
      if (typeof data8 == "number" && isFinite(data8)) {
        if (data8 < 0 || isNaN(data8)) {
          const err24 = {
            instancePath: instancePath + "/start",
            schemaPath: "#/$defs/seconds/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err24];
          } else {
            vErrors.push(err24);
          }
          errors++;
        }
      } else {
        const err25 = {
          instancePath: instancePath + "/start",
          schemaPath: "#/$defs/seconds/type",
          keyword: "type",
          params: { type: "number" },
          message: "must be number",
        };
        if (vErrors === null) {
          vErrors = [err25];
        } else {
          vErrors.push(err25);
        }
        errors++;
      }
    }
    if (data.end !== undefined) {
      let data9 = data.end;
      if (!(typeof data9 == "number" && isFinite(data9)) && data9 !== null) {
        const err26 = {
          instancePath: instancePath + "/end",
          schemaPath: "#/$defs/secondsOrNull/type",
          keyword: "type",
          params: { type: schema37.type },
          message: "must be number,null",
        };
        if (vErrors === null) {
          vErrors = [err26];
        } else {
          vErrors.push(err26);
        }
        errors++;
      }
      if (typeof data9 == "number" && isFinite(data9)) {
        if (data9 < 0 || isNaN(data9)) {
          const err27 = {
            instancePath: instancePath + "/end",
            schemaPath: "#/$defs/secondsOrNull/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err27];
          } else {
            vErrors.push(err27);
          }
          errors++;
        }
      }
    }
    if (data.tools !== undefined) {
      let data10 = data.tools;
      if (Array.isArray(data10)) {
        const len0 = data10.length;
        for (let i0 = 0; i0 < len0; i0++) {
          if (
            !validate22(data10[i0], {
              instancePath: instancePath + "/tools/" + i0,
              parentData: data10,
              parentDataProperty: i0,
              rootData,
              dynamicAnchors,
            })
          ) {
            vErrors = vErrors === null ? validate22.errors : vErrors.concat(validate22.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err28 = {
          instancePath: instancePath + "/tools",
          schemaPath: "#/properties/tools/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err28];
        } else {
          vErrors.push(err28);
        }
        errors++;
      }
    }
    if (data.replies !== undefined) {
      let data12 = data.replies;
      if (Array.isArray(data12)) {
        const len1 = data12.length;
        for (let i1 = 0; i1 < len1; i1++) {
          if (
            !validate24(data12[i1], {
              instancePath: instancePath + "/replies/" + i1,
              parentData: data12,
              parentDataProperty: i1,
              rootData,
              dynamicAnchors,
            })
          ) {
            vErrors = vErrors === null ? validate24.errors : vErrors.concat(validate24.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err29 = {
          instancePath: instancePath + "/replies",
          schemaPath: "#/properties/replies/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err29];
        } else {
          vErrors.push(err29);
        }
        errors++;
      }
    }
    if (data.totals !== undefined) {
      if (
        !validate26(data.totals, {
          instancePath: instancePath + "/totals",
          parentData: data,
          parentDataProperty: "totals",
          rootData,
          dynamicAnchors,
        })
      ) {
        vErrors = vErrors === null ? validate26.errors : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err30 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err30];
    } else {
      vErrors.push(err30);
    }
    errors++;
  }
  validate21.errors = vErrors;
  return errors === 0;
}
validate21.evaluated = { props: true, dynamicProps: false, dynamicItems: false };
const schema57 = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "callsign",
    "model",
    "family",
    "effort",
    "parent",
    "wave",
    "start",
    "end",
    "tools",
    "replies",
    "totals",
  ],
  properties: {
    id: { type: "string", pattern: "^a[1-9][0-9]{0,5}$" },
    name: { $ref: "#/$defs/agentName" },
    callsign: { $ref: "#/$defs/callsign" },
    model: { $ref: "#/$defs/model" },
    family: { $ref: "#/$defs/family" },
    effort: { $ref: "#/$defs/effort" },
    parent: { $ref: "#/$defs/agentRef" },
    wave: { $ref: "#/$defs/count" },
    start: { $ref: "#/$defs/seconds" },
    end: { $ref: "#/$defs/secondsOrNull" },
    tools: { type: "array", items: { $ref: "#/$defs/toolCall" } },
    replies: { type: "array", items: { $ref: "#/$defs/reply" } },
    totals: { $ref: "#/$defs/agentTotals" },
  },
};
const schema58 = {
  description: "Agent type, such as code-reviewer. An identifier: no spaces.",
  type: "string",
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$",
};
const schema59 = {
  description: "Agent name, plus #n when the name repeats.",
  type: "string",
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}(#[1-9][0-9]{0,5})?$",
};
const schema63 = { type: "string", pattern: "^(main|a[1-9][0-9]{0,5})$" };
const pattern9 = new RegExp("^a[1-9][0-9]{0,5}$", "u");
const pattern10 = new RegExp("^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$", "u");
const pattern11 = new RegExp("^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}(#[1-9][0-9]{0,5})?$", "u");
const pattern14 = new RegExp("^(main|a[1-9][0-9]{0,5})$", "u");
function validate29(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {},
) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate29.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = undefined;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = undefined;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.id === undefined) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "id" },
        message: "must have required property '" + "id" + "'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.name === undefined) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "name" },
        message: "must have required property '" + "name" + "'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.callsign === undefined) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "callsign" },
        message: "must have required property '" + "callsign" + "'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.model === undefined) {
      const err3 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "model" },
        message: "must have required property '" + "model" + "'",
      };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.family === undefined) {
      const err4 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "family" },
        message: "must have required property '" + "family" + "'",
      };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.effort === undefined) {
      const err5 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "effort" },
        message: "must have required property '" + "effort" + "'",
      };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    if (data.parent === undefined) {
      const err6 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "parent" },
        message: "must have required property '" + "parent" + "'",
      };
      if (vErrors === null) {
        vErrors = [err6];
      } else {
        vErrors.push(err6);
      }
      errors++;
    }
    if (data.wave === undefined) {
      const err7 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "wave" },
        message: "must have required property '" + "wave" + "'",
      };
      if (vErrors === null) {
        vErrors = [err7];
      } else {
        vErrors.push(err7);
      }
      errors++;
    }
    if (data.start === undefined) {
      const err8 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "start" },
        message: "must have required property '" + "start" + "'",
      };
      if (vErrors === null) {
        vErrors = [err8];
      } else {
        vErrors.push(err8);
      }
      errors++;
    }
    if (data.end === undefined) {
      const err9 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "end" },
        message: "must have required property '" + "end" + "'",
      };
      if (vErrors === null) {
        vErrors = [err9];
      } else {
        vErrors.push(err9);
      }
      errors++;
    }
    if (data.tools === undefined) {
      const err10 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "tools" },
        message: "must have required property '" + "tools" + "'",
      };
      if (vErrors === null) {
        vErrors = [err10];
      } else {
        vErrors.push(err10);
      }
      errors++;
    }
    if (data.replies === undefined) {
      const err11 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "replies" },
        message: "must have required property '" + "replies" + "'",
      };
      if (vErrors === null) {
        vErrors = [err11];
      } else {
        vErrors.push(err11);
      }
      errors++;
    }
    if (data.totals === undefined) {
      const err12 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "totals" },
        message: "must have required property '" + "totals" + "'",
      };
      if (vErrors === null) {
        vErrors = [err12];
      } else {
        vErrors.push(err12);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!func1.call(schema57.properties, key0)) {
        const err13 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
    }
    if (data.id !== undefined) {
      let data0 = data.id;
      if (typeof data0 === "string") {
        if (!pattern9.test(data0)) {
          const err14 = {
            instancePath: instancePath + "/id",
            schemaPath: "#/properties/id/pattern",
            keyword: "pattern",
            params: { pattern: "^a[1-9][0-9]{0,5}$" },
            message: 'must match pattern "' + "^a[1-9][0-9]{0,5}$" + '"',
          };
          if (vErrors === null) {
            vErrors = [err14];
          } else {
            vErrors.push(err14);
          }
          errors++;
        }
      } else {
        const err15 = {
          instancePath: instancePath + "/id",
          schemaPath: "#/properties/id/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err15];
        } else {
          vErrors.push(err15);
        }
        errors++;
      }
    }
    if (data.name !== undefined) {
      let data1 = data.name;
      if (typeof data1 === "string") {
        if (!pattern10.test(data1)) {
          const err16 = {
            instancePath: instancePath + "/name",
            schemaPath: "#/$defs/agentName/pattern",
            keyword: "pattern",
            params: { pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$" },
            message: 'must match pattern "' + "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$" + '"',
          };
          if (vErrors === null) {
            vErrors = [err16];
          } else {
            vErrors.push(err16);
          }
          errors++;
        }
      } else {
        const err17 = {
          instancePath: instancePath + "/name",
          schemaPath: "#/$defs/agentName/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err17];
        } else {
          vErrors.push(err17);
        }
        errors++;
      }
    }
    if (data.callsign !== undefined) {
      let data2 = data.callsign;
      if (typeof data2 === "string") {
        if (!pattern11.test(data2)) {
          const err18 = {
            instancePath: instancePath + "/callsign",
            schemaPath: "#/$defs/callsign/pattern",
            keyword: "pattern",
            params: { pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}(#[1-9][0-9]{0,5})?$" },
            message:
              'must match pattern "' +
              "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}(#[1-9][0-9]{0,5})?$" +
              '"',
          };
          if (vErrors === null) {
            vErrors = [err18];
          } else {
            vErrors.push(err18);
          }
          errors++;
        }
      } else {
        const err19 = {
          instancePath: instancePath + "/callsign",
          schemaPath: "#/$defs/callsign/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err19];
        } else {
          vErrors.push(err19);
        }
        errors++;
      }
    }
    if (data.model !== undefined) {
      let data3 = data.model;
      if (typeof data3 !== "string" && data3 !== null) {
        const err20 = {
          instancePath: instancePath + "/model",
          schemaPath: "#/$defs/model/type",
          keyword: "type",
          params: { type: schema33.type },
          message: "must be string,null",
        };
        if (vErrors === null) {
          vErrors = [err20];
        } else {
          vErrors.push(err20);
        }
        errors++;
      }
      if (typeof data3 === "string") {
        if (!pattern4.test(data3)) {
          const err21 = {
            instancePath: instancePath + "/model",
            schemaPath: "#/$defs/model/pattern",
            keyword: "pattern",
            params: { pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" },
            message: 'must match pattern "' + "^[a-z0-9][a-z0-9._-]{0,63}$" + '"',
          };
          if (vErrors === null) {
            vErrors = [err21];
          } else {
            vErrors.push(err21);
          }
          errors++;
        }
      }
    }
    if (data.family !== undefined) {
      let data4 = data.family;
      if (typeof data4 === "string") {
        if (!pattern5.test(data4)) {
          const err22 = {
            instancePath: instancePath + "/family",
            schemaPath: "#/$defs/family/pattern",
            keyword: "pattern",
            params: { pattern: "^[a-z][a-z0-9-]{0,31}$" },
            message: 'must match pattern "' + "^[a-z][a-z0-9-]{0,31}$" + '"',
          };
          if (vErrors === null) {
            vErrors = [err22];
          } else {
            vErrors.push(err22);
          }
          errors++;
        }
      } else {
        const err23 = {
          instancePath: instancePath + "/family",
          schemaPath: "#/$defs/family/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err23];
        } else {
          vErrors.push(err23);
        }
        errors++;
      }
    }
    if (data.effort !== undefined) {
      let data5 = data.effort;
      if (!(
        data5 === "low" ||
        data5 === "medium" ||
        data5 === "high" ||
        data5 === "xhigh" ||
        data5 === "max" ||
        data5 === null
      )) {
        const err24 = {
          instancePath: instancePath + "/effort",
          schemaPath: "#/$defs/effort/enum",
          keyword: "enum",
          params: { allowedValues: schema35.enum },
          message: "must be equal to one of the allowed values",
        };
        if (vErrors === null) {
          vErrors = [err24];
        } else {
          vErrors.push(err24);
        }
        errors++;
      }
    }
    if (data.parent !== undefined) {
      let data6 = data.parent;
      if (typeof data6 === "string") {
        if (!pattern14.test(data6)) {
          const err25 = {
            instancePath: instancePath + "/parent",
            schemaPath: "#/$defs/agentRef/pattern",
            keyword: "pattern",
            params: { pattern: "^(main|a[1-9][0-9]{0,5})$" },
            message: 'must match pattern "' + "^(main|a[1-9][0-9]{0,5})$" + '"',
          };
          if (vErrors === null) {
            vErrors = [err25];
          } else {
            vErrors.push(err25);
          }
          errors++;
        }
      } else {
        const err26 = {
          instancePath: instancePath + "/parent",
          schemaPath: "#/$defs/agentRef/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err26];
        } else {
          vErrors.push(err26);
        }
        errors++;
      }
    }
    if (data.wave !== undefined) {
      let data7 = data.wave;
      if (!(typeof data7 == "number" && !(data7 % 1) && !isNaN(data7) && isFinite(data7))) {
        const err27 = {
          instancePath: instancePath + "/wave",
          schemaPath: "#/$defs/count/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err27];
        } else {
          vErrors.push(err27);
        }
        errors++;
      }
      if (typeof data7 == "number" && isFinite(data7)) {
        if (data7 < 0 || isNaN(data7)) {
          const err28 = {
            instancePath: instancePath + "/wave",
            schemaPath: "#/$defs/count/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err28];
          } else {
            vErrors.push(err28);
          }
          errors++;
        }
      }
    }
    if (data.start !== undefined) {
      let data8 = data.start;
      if (typeof data8 == "number" && isFinite(data8)) {
        if (data8 < 0 || isNaN(data8)) {
          const err29 = {
            instancePath: instancePath + "/start",
            schemaPath: "#/$defs/seconds/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err29];
          } else {
            vErrors.push(err29);
          }
          errors++;
        }
      } else {
        const err30 = {
          instancePath: instancePath + "/start",
          schemaPath: "#/$defs/seconds/type",
          keyword: "type",
          params: { type: "number" },
          message: "must be number",
        };
        if (vErrors === null) {
          vErrors = [err30];
        } else {
          vErrors.push(err30);
        }
        errors++;
      }
    }
    if (data.end !== undefined) {
      let data9 = data.end;
      if (!(typeof data9 == "number" && isFinite(data9)) && data9 !== null) {
        const err31 = {
          instancePath: instancePath + "/end",
          schemaPath: "#/$defs/secondsOrNull/type",
          keyword: "type",
          params: { type: schema37.type },
          message: "must be number,null",
        };
        if (vErrors === null) {
          vErrors = [err31];
        } else {
          vErrors.push(err31);
        }
        errors++;
      }
      if (typeof data9 == "number" && isFinite(data9)) {
        if (data9 < 0 || isNaN(data9)) {
          const err32 = {
            instancePath: instancePath + "/end",
            schemaPath: "#/$defs/secondsOrNull/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err32];
          } else {
            vErrors.push(err32);
          }
          errors++;
        }
      }
    }
    if (data.tools !== undefined) {
      let data10 = data.tools;
      if (Array.isArray(data10)) {
        const len0 = data10.length;
        for (let i0 = 0; i0 < len0; i0++) {
          if (
            !validate22(data10[i0], {
              instancePath: instancePath + "/tools/" + i0,
              parentData: data10,
              parentDataProperty: i0,
              rootData,
              dynamicAnchors,
            })
          ) {
            vErrors = vErrors === null ? validate22.errors : vErrors.concat(validate22.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err33 = {
          instancePath: instancePath + "/tools",
          schemaPath: "#/properties/tools/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err33];
        } else {
          vErrors.push(err33);
        }
        errors++;
      }
    }
    if (data.replies !== undefined) {
      let data12 = data.replies;
      if (Array.isArray(data12)) {
        const len1 = data12.length;
        for (let i1 = 0; i1 < len1; i1++) {
          if (
            !validate24(data12[i1], {
              instancePath: instancePath + "/replies/" + i1,
              parentData: data12,
              parentDataProperty: i1,
              rootData,
              dynamicAnchors,
            })
          ) {
            vErrors = vErrors === null ? validate24.errors : vErrors.concat(validate24.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err34 = {
          instancePath: instancePath + "/replies",
          schemaPath: "#/properties/replies/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err34];
        } else {
          vErrors.push(err34);
        }
        errors++;
      }
    }
    if (data.totals !== undefined) {
      if (
        !validate26(data.totals, {
          instancePath: instancePath + "/totals",
          parentData: data,
          parentDataProperty: "totals",
          rootData,
          dynamicAnchors,
        })
      ) {
        vErrors = vErrors === null ? validate26.errors : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err35 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err35];
    } else {
      vErrors.push(err35);
    }
    errors++;
  }
  validate29.errors = vErrors;
  return errors === 0;
}
validate29.evaluated = { props: true, dynamicProps: false, dynamicItems: false };
const schema67 = {
  type: "object",
  additionalProperties: false,
  required: ["at", "skipped"],
  properties: { at: { $ref: "#/$defs/seconds" }, skipped: { type: "number", exclusiveMinimum: 0 } },
};
function validate34(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {},
) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate34.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = undefined;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = undefined;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.at === undefined) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "at" },
        message: "must have required property '" + "at" + "'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.skipped === undefined) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "skipped" },
        message: "must have required property '" + "skipped" + "'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "at" || key0 === "skipped")) {
        const err2 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
    if (data.at !== undefined) {
      let data0 = data.at;
      if (typeof data0 == "number" && isFinite(data0)) {
        if (data0 < 0 || isNaN(data0)) {
          const err3 = {
            instancePath: instancePath + "/at",
            schemaPath: "#/$defs/seconds/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err3];
          } else {
            vErrors.push(err3);
          }
          errors++;
        }
      } else {
        const err4 = {
          instancePath: instancePath + "/at",
          schemaPath: "#/$defs/seconds/type",
          keyword: "type",
          params: { type: "number" },
          message: "must be number",
        };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.skipped !== undefined) {
      let data1 = data.skipped;
      if (typeof data1 == "number" && isFinite(data1)) {
        if (data1 <= 0 || isNaN(data1)) {
          const err5 = {
            instancePath: instancePath + "/skipped",
            schemaPath: "#/properties/skipped/exclusiveMinimum",
            keyword: "exclusiveMinimum",
            params: { comparison: ">", limit: 0 },
            message: "must be > 0",
          };
          if (vErrors === null) {
            vErrors = [err5];
          } else {
            vErrors.push(err5);
          }
          errors++;
        }
      } else {
        const err6 = {
          instancePath: instancePath + "/skipped",
          schemaPath: "#/properties/skipped/type",
          keyword: "type",
          params: { type: "number" },
          message: "must be number",
        };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
  } else {
    const err7 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err7];
    } else {
      vErrors.push(err7);
    }
    errors++;
  }
  validate34.errors = vErrors;
  return errors === 0;
}
validate34.evaluated = { props: true, dynamicProps: false, dynamicItems: false };
const schema69 = {
  type: "object",
  additionalProperties: false,
  required: [
    "agents",
    "toolCalls",
    "failedToolCalls",
    "replies",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheCreationTokens",
    "duration",
    "realDuration",
  ],
  properties: {
    agents: { $ref: "#/$defs/count" },
    toolCalls: { $ref: "#/$defs/count" },
    failedToolCalls: { $ref: "#/$defs/count" },
    replies: { $ref: "#/$defs/count" },
    inputTokens: { $ref: "#/$defs/count" },
    outputTokens: { $ref: "#/$defs/count" },
    cacheReadTokens: { $ref: "#/$defs/count" },
    cacheCreationTokens: { $ref: "#/$defs/count" },
    duration: { $ref: "#/$defs/seconds" },
    realDuration: { type: "number", minimum: 0 },
  },
};
function validate36(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {},
) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate36.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = undefined;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = undefined;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.agents === undefined) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "agents" },
        message: "must have required property '" + "agents" + "'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.toolCalls === undefined) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "toolCalls" },
        message: "must have required property '" + "toolCalls" + "'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.failedToolCalls === undefined) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "failedToolCalls" },
        message: "must have required property '" + "failedToolCalls" + "'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.replies === undefined) {
      const err3 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "replies" },
        message: "must have required property '" + "replies" + "'",
      };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.inputTokens === undefined) {
      const err4 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "inputTokens" },
        message: "must have required property '" + "inputTokens" + "'",
      };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.outputTokens === undefined) {
      const err5 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "outputTokens" },
        message: "must have required property '" + "outputTokens" + "'",
      };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    if (data.cacheReadTokens === undefined) {
      const err6 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "cacheReadTokens" },
        message: "must have required property '" + "cacheReadTokens" + "'",
      };
      if (vErrors === null) {
        vErrors = [err6];
      } else {
        vErrors.push(err6);
      }
      errors++;
    }
    if (data.cacheCreationTokens === undefined) {
      const err7 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "cacheCreationTokens" },
        message: "must have required property '" + "cacheCreationTokens" + "'",
      };
      if (vErrors === null) {
        vErrors = [err7];
      } else {
        vErrors.push(err7);
      }
      errors++;
    }
    if (data.duration === undefined) {
      const err8 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "duration" },
        message: "must have required property '" + "duration" + "'",
      };
      if (vErrors === null) {
        vErrors = [err8];
      } else {
        vErrors.push(err8);
      }
      errors++;
    }
    if (data.realDuration === undefined) {
      const err9 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "realDuration" },
        message: "must have required property '" + "realDuration" + "'",
      };
      if (vErrors === null) {
        vErrors = [err9];
      } else {
        vErrors.push(err9);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!func1.call(schema69.properties, key0)) {
        const err10 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
    }
    if (data.agents !== undefined) {
      let data0 = data.agents;
      if (!(typeof data0 == "number" && !(data0 % 1) && !isNaN(data0) && isFinite(data0))) {
        const err11 = {
          instancePath: instancePath + "/agents",
          schemaPath: "#/$defs/count/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
      if (typeof data0 == "number" && isFinite(data0)) {
        if (data0 < 0 || isNaN(data0)) {
          const err12 = {
            instancePath: instancePath + "/agents",
            schemaPath: "#/$defs/count/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err12];
          } else {
            vErrors.push(err12);
          }
          errors++;
        }
      }
    }
    if (data.toolCalls !== undefined) {
      let data1 = data.toolCalls;
      if (!(typeof data1 == "number" && !(data1 % 1) && !isNaN(data1) && isFinite(data1))) {
        const err13 = {
          instancePath: instancePath + "/toolCalls",
          schemaPath: "#/$defs/count/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
      if (typeof data1 == "number" && isFinite(data1)) {
        if (data1 < 0 || isNaN(data1)) {
          const err14 = {
            instancePath: instancePath + "/toolCalls",
            schemaPath: "#/$defs/count/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err14];
          } else {
            vErrors.push(err14);
          }
          errors++;
        }
      }
    }
    if (data.failedToolCalls !== undefined) {
      let data2 = data.failedToolCalls;
      if (!(typeof data2 == "number" && !(data2 % 1) && !isNaN(data2) && isFinite(data2))) {
        const err15 = {
          instancePath: instancePath + "/failedToolCalls",
          schemaPath: "#/$defs/count/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err15];
        } else {
          vErrors.push(err15);
        }
        errors++;
      }
      if (typeof data2 == "number" && isFinite(data2)) {
        if (data2 < 0 || isNaN(data2)) {
          const err16 = {
            instancePath: instancePath + "/failedToolCalls",
            schemaPath: "#/$defs/count/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err16];
          } else {
            vErrors.push(err16);
          }
          errors++;
        }
      }
    }
    if (data.replies !== undefined) {
      let data3 = data.replies;
      if (!(typeof data3 == "number" && !(data3 % 1) && !isNaN(data3) && isFinite(data3))) {
        const err17 = {
          instancePath: instancePath + "/replies",
          schemaPath: "#/$defs/count/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err17];
        } else {
          vErrors.push(err17);
        }
        errors++;
      }
      if (typeof data3 == "number" && isFinite(data3)) {
        if (data3 < 0 || isNaN(data3)) {
          const err18 = {
            instancePath: instancePath + "/replies",
            schemaPath: "#/$defs/count/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err18];
          } else {
            vErrors.push(err18);
          }
          errors++;
        }
      }
    }
    if (data.inputTokens !== undefined) {
      let data4 = data.inputTokens;
      if (!(typeof data4 == "number" && !(data4 % 1) && !isNaN(data4) && isFinite(data4))) {
        const err19 = {
          instancePath: instancePath + "/inputTokens",
          schemaPath: "#/$defs/count/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err19];
        } else {
          vErrors.push(err19);
        }
        errors++;
      }
      if (typeof data4 == "number" && isFinite(data4)) {
        if (data4 < 0 || isNaN(data4)) {
          const err20 = {
            instancePath: instancePath + "/inputTokens",
            schemaPath: "#/$defs/count/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err20];
          } else {
            vErrors.push(err20);
          }
          errors++;
        }
      }
    }
    if (data.outputTokens !== undefined) {
      let data5 = data.outputTokens;
      if (!(typeof data5 == "number" && !(data5 % 1) && !isNaN(data5) && isFinite(data5))) {
        const err21 = {
          instancePath: instancePath + "/outputTokens",
          schemaPath: "#/$defs/count/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err21];
        } else {
          vErrors.push(err21);
        }
        errors++;
      }
      if (typeof data5 == "number" && isFinite(data5)) {
        if (data5 < 0 || isNaN(data5)) {
          const err22 = {
            instancePath: instancePath + "/outputTokens",
            schemaPath: "#/$defs/count/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err22];
          } else {
            vErrors.push(err22);
          }
          errors++;
        }
      }
    }
    if (data.cacheReadTokens !== undefined) {
      let data6 = data.cacheReadTokens;
      if (!(typeof data6 == "number" && !(data6 % 1) && !isNaN(data6) && isFinite(data6))) {
        const err23 = {
          instancePath: instancePath + "/cacheReadTokens",
          schemaPath: "#/$defs/count/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err23];
        } else {
          vErrors.push(err23);
        }
        errors++;
      }
      if (typeof data6 == "number" && isFinite(data6)) {
        if (data6 < 0 || isNaN(data6)) {
          const err24 = {
            instancePath: instancePath + "/cacheReadTokens",
            schemaPath: "#/$defs/count/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err24];
          } else {
            vErrors.push(err24);
          }
          errors++;
        }
      }
    }
    if (data.cacheCreationTokens !== undefined) {
      let data7 = data.cacheCreationTokens;
      if (!(typeof data7 == "number" && !(data7 % 1) && !isNaN(data7) && isFinite(data7))) {
        const err25 = {
          instancePath: instancePath + "/cacheCreationTokens",
          schemaPath: "#/$defs/count/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err25];
        } else {
          vErrors.push(err25);
        }
        errors++;
      }
      if (typeof data7 == "number" && isFinite(data7)) {
        if (data7 < 0 || isNaN(data7)) {
          const err26 = {
            instancePath: instancePath + "/cacheCreationTokens",
            schemaPath: "#/$defs/count/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err26];
          } else {
            vErrors.push(err26);
          }
          errors++;
        }
      }
    }
    if (data.duration !== undefined) {
      let data8 = data.duration;
      if (typeof data8 == "number" && isFinite(data8)) {
        if (data8 < 0 || isNaN(data8)) {
          const err27 = {
            instancePath: instancePath + "/duration",
            schemaPath: "#/$defs/seconds/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err27];
          } else {
            vErrors.push(err27);
          }
          errors++;
        }
      } else {
        const err28 = {
          instancePath: instancePath + "/duration",
          schemaPath: "#/$defs/seconds/type",
          keyword: "type",
          params: { type: "number" },
          message: "must be number",
        };
        if (vErrors === null) {
          vErrors = [err28];
        } else {
          vErrors.push(err28);
        }
        errors++;
      }
    }
    if (data.realDuration !== undefined) {
      let data9 = data.realDuration;
      if (typeof data9 == "number" && isFinite(data9)) {
        if (data9 < 0 || isNaN(data9)) {
          const err29 = {
            instancePath: instancePath + "/realDuration",
            schemaPath: "#/properties/realDuration/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err29];
          } else {
            vErrors.push(err29);
          }
          errors++;
        }
      } else {
        const err30 = {
          instancePath: instancePath + "/realDuration",
          schemaPath: "#/properties/realDuration/type",
          keyword: "type",
          params: { type: "number" },
          message: "must be number",
        };
        if (vErrors === null) {
          vErrors = [err30];
        } else {
          vErrors.push(err30);
        }
        errors++;
      }
    }
  } else {
    const err31 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err31];
    } else {
      vErrors.push(err31);
    }
    errors++;
  }
  validate36.errors = vErrors;
  return errors === 0;
}
validate36.evaluated = { props: true, dynamicProps: false, dynamicItems: false };
function validate20(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {},
) {
  /*# sourceURL="https://github.com/farisology/orbitrace/blob/dev/packages/core/schema/replay-v1.schema.json" */ let vErrors =
    null;
  let errors = 0;
  const evaluated0 = validate20.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = undefined;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = undefined;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.formatVersion === undefined) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "formatVersion" },
        message: "must have required property '" + "formatVersion" + "'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.agents === undefined) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "agents" },
        message: "must have required property '" + "agents" + "'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.warps === undefined) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "warps" },
        message: "must have required property '" + "warps" + "'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.totals === undefined) {
      const err3 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "totals" },
        message: "must have required property '" + "totals" + "'",
      };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(
        key0 === "formatVersion" ||
        key0 === "agents" ||
        key0 === "warps" ||
        key0 === "totals"
      )) {
        const err4 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.formatVersion !== undefined) {
      if (1 !== data.formatVersion) {
        const err5 = {
          instancePath: instancePath + "/formatVersion",
          schemaPath: "#/properties/formatVersion/const",
          keyword: "const",
          params: { allowedValue: 1 },
          message: "must be equal to constant",
        };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
    }
    if (data.agents !== undefined) {
      let data1 = data.agents;
      if (Array.isArray(data1)) {
        if (data1.length < 1) {
          const err6 = {
            instancePath: instancePath + "/agents",
            schemaPath: "#/properties/agents/minItems",
            keyword: "minItems",
            params: { limit: 1 },
            message: "must NOT have fewer than 1 items",
          };
          if (vErrors === null) {
            vErrors = [err6];
          } else {
            vErrors.push(err6);
          }
          errors++;
        }
        const len0 = data1.length;
        if (len0 > 0) {
          if (
            !validate21(data1[0], {
              instancePath: instancePath + "/agents/0",
              parentData: data1,
              parentDataProperty: 0,
              rootData,
              dynamicAnchors,
            })
          ) {
            vErrors = vErrors === null ? validate21.errors : vErrors.concat(validate21.errors);
            errors = vErrors.length;
          }
        }
        const len1 = data1.length;
        var valid2 = len1 <= 1;
        if (!valid2) {
          for (let i0 = 1; i0 < len1; i0++) {
            const _errs6 = errors;
            if (
              !validate29(data1[i0], {
                instancePath: instancePath + "/agents/" + i0,
                parentData: data1,
                parentDataProperty: i0,
                rootData,
                dynamicAnchors,
              })
            ) {
              vErrors = vErrors === null ? validate29.errors : vErrors.concat(validate29.errors);
              errors = vErrors.length;
            }
            var valid2 = _errs6 === errors;
          }
        }
      } else {
        const err7 = {
          instancePath: instancePath + "/agents",
          schemaPath: "#/properties/agents/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
    }
    if (data.warps !== undefined) {
      let data4 = data.warps;
      if (Array.isArray(data4)) {
        const len2 = data4.length;
        for (let i1 = 0; i1 < len2; i1++) {
          if (
            !validate34(data4[i1], {
              instancePath: instancePath + "/warps/" + i1,
              parentData: data4,
              parentDataProperty: i1,
              rootData,
              dynamicAnchors,
            })
          ) {
            vErrors = vErrors === null ? validate34.errors : vErrors.concat(validate34.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err8 = {
          instancePath: instancePath + "/warps",
          schemaPath: "#/properties/warps/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
    if (data.totals !== undefined) {
      if (
        !validate36(data.totals, {
          instancePath: instancePath + "/totals",
          parentData: data,
          parentDataProperty: "totals",
          rootData,
          dynamicAnchors,
        })
      ) {
        vErrors = vErrors === null ? validate36.errors : vErrors.concat(validate36.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err9 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err9];
    } else {
      vErrors.push(err9);
    }
    errors++;
  }
  validate20.errors = vErrors;
  return errors === 0;
}
validate20.evaluated = { props: true, dynamicProps: false, dynamicItems: false };
