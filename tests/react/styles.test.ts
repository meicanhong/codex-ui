import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(
  new URL("../../src/styles.css", import.meta.url),
  "utf8",
);

describe("default Codex UI styles", () => {
  it("styles Streamdown without requiring host Tailwind source scanning", () => {
    const requiredSelectors = [
      'data-streamdown="unordered-list"',
      'data-streamdown="ordered-list"',
      'data-streamdown="code-block"',
      'data-streamdown="code-block-header"',
      'data-streamdown="code-block-body"',
      'data-streamdown="code-block-copy-button"',
      'data-streamdown="table-wrapper"',
      'data-streamdown="table"',
      'data-streamdown="image-wrapper"',
      'data-streamdown="link-safety-modal"',
    ];

    for (const selector of requiredSelectors) {
      expect(styles).toContain(selector);
    }
    expect(styles).not.toContain("@source");
    expect(styles).toContain('table[data-streamdown="table"] tbody');
  });

  it("keeps muted small text above a 4.5 contrast ratio", () => {
    const muted = readHexVariable("--codex-ui-muted");
    const background = readHexVariable("--codex-ui-bg");
    const surface = readHexVariable("--codex-ui-surface");

    expect(contrast(muted, background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(muted, surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("exposes semantic tokens for critical interaction states", () => {
    const variables = [
      "--codex-ui-error-bg",
      "--codex-ui-focus",
      "--codex-ui-focus-ring",
      "--codex-ui-disabled-text",
      "--codex-ui-disabled-bg",
      "--codex-ui-approval-border",
      "--codex-ui-approval-text",
      "--codex-ui-approval-bg",
      "--codex-ui-approval-primary",
    ];

    for (const variable of variables) {
      expect(styles).toContain(`${variable}:`);
      expect(styles).toContain(`var(${variable})`);
    }
  });
});

function readHexVariable(name: string) {
  const match = styles.match(new RegExp(`${name}:\\s*(#[0-9a-f]{3,8})`, "i"));
  if (!match?.[1]) throw new Error(`Missing ${name}`);
  return match[1];
}

function contrast(foreground: string, background: string) {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(hex: string) {
  const normalized = hex.slice(1);
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((channel) => `${channel}${channel}`)
          .join("")
      : normalized;
  const channels = expanded.match(/.{2}/g);
  if (!channels || channels.length < 3) throw new Error(`Invalid color ${hex}`);
  const [red = "0", green = "0", blue = "0"] = channels;
  return (
    0.2126 * linearChannel(red) +
    0.7152 * linearChannel(green) +
    0.0722 * linearChannel(blue)
  );
}

function linearChannel(hex: string) {
  const channel = Number.parseInt(hex, 16) / 255;
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}
