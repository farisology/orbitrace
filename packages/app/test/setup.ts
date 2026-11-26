// Testing Library cleans up after each test only when the test runner has globals; Vitest here
// runs without them, so unmount explicitly.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
