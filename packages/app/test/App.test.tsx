import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App, PLACEHOLDER_TEXT } from "../src/index";

describe("@orbitrace/app", () => {
  it("renders the placeholder page", () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain("<h1>Orbitrace</h1>");
    expect(html).toContain(PLACEHOLDER_TEXT);
  });
});
