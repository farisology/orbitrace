// Error codes and the path-free error helpers (ticket #75).
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  INTERNAL_ERROR_MESSAGE,
  isTransportErrorCode,
  SessionReplayError,
  toTransportError,
  TRANSPORT_ERROR_CODES,
  type TransportErrorCode,
} from "../../src/index.js";

describe("TRANSPORT_ERROR_CODES", () => {
  it("lists every TransportErrorCode once", () => {
    expectTypeOf<(typeof TRANSPORT_ERROR_CODES)[number]>().toEqualTypeOf<TransportErrorCode>();
    expect(TRANSPORT_ERROR_CODES).toEqual([
      "not-found",
      "unreadable",
      "invalid",
      "unsupported",
      "unauthorized",
      "internal",
    ]);
    expect(new Set(TRANSPORT_ERROR_CODES).size).toBe(TRANSPORT_ERROR_CODES.length);
  });
});

describe("isTransportErrorCode", () => {
  it("accepts the codes and rejects anything else", () => {
    for (const code of TRANSPORT_ERROR_CODES) expect(isTransportErrorCode(code)).toBe(true);
    for (const value of ["", "NOT-FOUND", "timeout", 404, null, undefined, {}]) {
      expect(isTransportErrorCode(value)).toBe(false);
    }
  });
});

describe("SessionReplayError", () => {
  it("is an Error with a code and the given message", () => {
    const error = new SessionReplayError("unreadable", "The session transcript could not be read.");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SessionReplayError");
    expect(error.code).toBe("unreadable");
    expect(error.message).toBe("The session transcript could not be read.");
  });
});

describe("toTransportError", () => {
  it("keeps the code and message of a SessionReplayError as a plain object", () => {
    const info = toTransportError(new SessionReplayError("not-found", "No session with that key."));
    expect(info).toEqual({ code: "not-found", message: "No session with that key." });
    expect(Object.getPrototypeOf(info)).toBe(Object.prototype);
  });

  it("turns anything else into internal without passing its message on", () => {
    // An invented path, standing for what a file error would name.
    const fileError = Object.assign(new Error("ENOENT: open '/srv/example/secret.jsonl'"), {
      code: "ENOENT",
    });
    for (const thrown of [fileError, "text", undefined, { code: "not-found", message: "x" }]) {
      expect(toTransportError(thrown)).toEqual({
        code: "internal",
        message: INTERNAL_ERROR_MESSAGE,
      });
    }
  });
});
