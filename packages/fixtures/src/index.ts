/**
 * @orbitrace/fixtures: synthetic Claude Code transcripts for tests and for the bundled demo.
 *
 * - The generator (`generateSession`, `generateAll`, `renderFixtureTree`) is seeded and
 *   pure. It is also available alone, with no Node dependency, as
 *   `@orbitrace/fixtures/generator`.
 * - The paths (`FIXTURES_DIR`, `FIXTURE_CONFIG_DIR`, `fixturePaths`) point at the generated
 *   files committed under `fixtures/` at the repository root.
 * - `writeFixtureTree` and `checkFixtureTree` write that folder and compare it with the
 *   generator.
 *
 * Everything in a fixture is invented. Nothing comes from a real session.
 */
export * from "./generator.js";
export * from "./paths.js";
export * from "./write.js";
