// First, before anything loads React: the opt-in switch that widens the gap between a commit
// and its effects (see effect-gap.ts). It does nothing unless its variable is set.
import "./effect-gap";
// Testing Library cleans up after each test only when the test runner has globals; Vitest here
// runs without them, so unmount explicitly.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
