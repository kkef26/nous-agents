// apps/conductor/src/evaluators/deployed-pixel.ts
// AGT.SCOPER.SEAM_CLAUSE.3 — Conductor cold-read evaluator for deployed-pixel
// acceptance criteria.
//
// A deployed-pixel AC carries a test_contract of the shape:
//   { deployed_url: string, selector: string }
//
// The evaluator fetches the deployed_url with a single-shot HTTP GET, parses
// the returned HTML, and asserts that the CSS selector resolves to at least
// one element. It returns 'pass' or 'fail' — never throws.
//
// CONSTRAINTS (from clause body):
//   - NEVER read local source files or run shell commands. Only network and
//     DOM operations are permitted.
//   - NEVER launch a persistent browser process. Use a single-shot
//     fetch-and-parse strategy per evaluation call.
//   - NEVER hardcode deployed_url. Read it exclusively from the AC's
//     test_contract at runtime.
//
// The DOM parser is a minimal HTML query engine that handles the selector
// shapes seam clauses actually use: tag, #id, .class, [attr="value"],
// descendant combinators, and any composition thereof. It is not a full
// CSS4 selector engine — that would be overkill for seam wiring verification
// and would drag in a heavy dependency (jsdom / cheerio) that this repo
// deliberately avoids. If a selector shape isn't supported, the evaluator
// returns 'fail' rather than throwing.

import type { AcceptanceCriterion, DeployedPixelTestContract } from "../../../../scoper/src/decomposition.js";
import { DEPLOYED_PIXEL_VERIFICATION } from "../../../../scoper/src/decomposition.js";

export type DeployedPixelResult = "pass" | "fail";

const FETCH_TIMEOUT_MS = 15_000;

export async function evaluateDeployedPixelAC(ac: AcceptanceCriterion): Promise<DeployedPixelResult> {
  if (ac.verification !== DEPLOYED_PIXEL_VERIFICATION) return "fail";
  const tc = ac.test_contract;
  if (!isWellFormedContract(tc)) return "fail";

  let html: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(tc.deployed_url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return "fail";
    html = await res.text();
  } catch {
    return "fail";
  }

  return selectorMatches(html, tc.selector) ? "pass" : "fail";
}

function isWellFormedContract(tc: DeployedPixelTestContract | undefined): tc is DeployedPixelTestContract {
  if (!tc || typeof tc !== "object") return false;
  const url = tc.deployed_url;
  const sel = tc.selector;
  if (typeof url !== "string" || url.trim().length === 0) return false;
  if (typeof sel !== "string" || sel.trim().length === 0) return false;
  return true;
}

// ─── Minimal CSS selector matcher ───────────────────────────────────────────
//
// Supports: tag, #id, .class, [attr], [attr="value"], [attr=value],
// descendant combinators (whitespace-separated). Combines them left-to-right.
// Returns true iff at least one open-tag substring in `html` satisfies EVERY
// simple selector in the compound. Descendant combinators require that a
// matching element appears somewhere after a match for the previous simple
// selector.

interface SimpleSelector {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: Array<{ name: string; value?: string }>;
}

function parseCompoundSelector(sel: string): SimpleSelector | null {
  const s = sel.trim();
  if (s.length === 0) return null;
  const out: SimpleSelector = { classes: [], attrs: [] };

  // Extract [attr] or [attr="value"] blocks first — bracket content may
  // legitimately contain '.' and '#'.
  const bracketRe = /\[([^\]]+)\]/g;
  const bracketMatches: string[] = [];
  let stripped = s.replace(bracketRe, (_, inner) => {
    bracketMatches.push(inner);
    return "";
  });
  for (const b of bracketMatches) {
    const eq = b.indexOf("=");
    if (eq === -1) {
      out.attrs.push({ name: b.trim() });
    } else {
      const name = b.slice(0, eq).trim();
      let value = b.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out.attrs.push({ name, value });
    }
  }

  // Now stripped looks like: "div.foo.bar#baz" or ".x" or "#y" or "div"
  const parts = stripped.split(/(?=[.#])/);
  for (const p of parts) {
    if (p.length === 0) continue;
    if (p.startsWith("#")) {
      out.id = p.slice(1);
    } else if (p.startsWith(".")) {
      out.classes.push(p.slice(1));
    } else {
      out.tag = p.toLowerCase();
    }
  }
  return out;
}

function selectorMatches(html: string, selector: string): boolean {
  const compounds = selector.split(/\s+/).filter((c) => c.length > 0);
  const parsed: SimpleSelector[] = [];
  for (const c of compounds) {
    const p = parseCompoundSelector(c);
    if (!p) return false;
    parsed.push(p);
  }
  if (parsed.length === 0) return false;

  // Find all open tags in html — enough for descendant matching.
  const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
  interface OpenTag { start: number; tag: string; attrs: string; }
  const tags: OpenTag[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    tags.push({ start: m.index, tag: m[1].toLowerCase(), attrs: m[2] });
  }
  if (tags.length === 0) return false;

  // Walk descendant chain: for compound i, find a tag matching it whose index
  // is strictly greater than the index of the tag matched for compound i-1.
  let cursor = -1;
  for (const compound of parsed) {
    let found = -1;
    for (let i = cursor + 1; i < tags.length; i++) {
      if (tagMatchesCompound(tags[i], compound)) {
        found = i;
        break;
      }
    }
    if (found === -1) return false;
    cursor = found;
  }
  return true;
}

function tagMatchesCompound(tag: { tag: string; attrs: string }, sel: SimpleSelector): boolean {
  if (sel.tag && tag.tag !== sel.tag) return false;
  const attrs = tag.attrs;
  if (sel.id) {
    if (!attrMatches(attrs, "id", sel.id)) return false;
  }
  for (const cls of sel.classes) {
    const classAttr = extractAttr(attrs, "class");
    if (!classAttr) return false;
    const classList = classAttr.split(/\s+/);
    if (!classList.includes(cls)) return false;
  }
  for (const a of sel.attrs) {
    if (a.value === undefined) {
      if (extractAttr(attrs, a.name) === null) return false;
    } else {
      if (!attrMatches(attrs, a.name, a.value)) return false;
    }
  }
  return true;
}

function extractAttr(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${escapeRegex(name)}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = attrs.match(re);
  if (!m) {
    // Boolean attribute: name present without value
    const boolRe = new RegExp(`\\b${escapeRegex(name)}\\b(?!\\s*=)`, "i");
    return attrs.match(boolRe) ? "" : null;
  }
  return m[2] ?? m[3] ?? m[4] ?? "";
}

function attrMatches(attrs: string, name: string, expected: string): boolean {
  const actual = extractAttr(attrs, name);
  return actual === expected;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
