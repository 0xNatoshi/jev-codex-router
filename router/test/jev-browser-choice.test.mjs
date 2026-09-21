import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildAsk,
  chooseElement,
  parseAx,
  readApiKey,
} from "../skills/jev-browser-choice/scripts/jev-choice.mjs";

const AX = [
  'Browser tab: 1, Title: "Search results", URL: "https://example.test/search?q=tea".',
  "1 AXWebArea Search results, URL: example.test/search?q=tea",
  "\t2 heading Search results",
  "\t3 textbox Description: Search, Value: tea",
  "\t4 button Description: Search, Disabled",
  "\t5 link Description: Green tea, Value: /tea/green",
  "\t\t6 text Green tea",
  "\t7 link Description: Black tea, Value: /tea/black",
  "\t8 checkbox Description: In stock only, Value: 1",
  "\t9 combobox Description: Sort by, Value: Relevance",
  "",
  "The focused UI element is 1 AXWebArea Search results, URL: example.test/search?q=tea",
].join("\n");

function fakeTab(ax = AX) {
  const reads = [];
  return {
    reads,
    ax: {
      get: async (mode, options) => {
        reads.push({ mode, options });
        return ax;
      },
    },
  };
}

// Lines captured verbatim from the in-app browser's accessibility dump: roles
// are phrases, and state markers sit between the role and the accessible name.
const IN_APP_AX = [
  'Browser tab: 1, Title: "Wikipedia, the free encyclopedia", URL: "https://en.wikipedia.org/wiki/Main_Page".',
  "\t1 AXWebArea Wikipedia, the free encyclopedia, URL: en.wikipedia.org/wi…",
  "\t\t5 pop up button Description: Main menu, ID: vector-main-menu-dropdown-checkbox",
  "\t\t\t8 search text field (settable) Description: Search Wikipedia, Help: Search Wikipedia [ctrl-option-f], ID: searchInput",
  "\t\t\t9 button Search",
  "\t\t\t\t12 link Description: Donate, Value: donate.wikimedia.org",
  "\t\t\t\t13 radio button (settable, integer) Description: Small",
  "\t\t\t\t14 heading Welcome to Wikipedia,",
  "",
  "The focused UI element is 1 AXWebArea Wikipedia, the free encyclopedia, URL: en.wikipedia.org/wi…",
].join("\n");

test("parseAx reads the in-app runtime's phrase roles and state markers", () => {
  const { page, candidates } = parseAx(IN_APP_AX);
  assert.equal(page.url, "https://en.wikipedia.org/wiki/Main_Page");
  assert.deepEqual(
    candidates.map((candidate) => [candidate.id, candidate.role, candidate.label]),
    [
      ["e5", "combobox", "Main menu"],
      ["e8", "searchbox", "Search Wikipedia"],
      ["e9", "button", "Search"],
      ["e12", "link", "Donate · value: donate.wikimedia.org"],
      ["e13", "radio", "Small"],
    ],
  );
});

test("parseAx resolves role spellings that differ only by spacing", () => {
  // X exposes its search field as "combo box"; a table of exact phrases misses it.
  const ax = [
    'Browser tab: 3, Title: "Explorer / X", URL: "https://x.com/explore".',
    "\t41 container Chercher",
    "\t43 combo box (settable) Requête de recherche",
    "\t44 button Rechercher",
  ].join("\n");
  const { candidates } = parseAx(ax);
  assert.deepEqual(
    candidates.map((candidate) => [candidate.id, candidate.role, candidate.label]),
    [
      ["e43", "combobox", "Requête de recherche"],
      ["e44", "button", "Rechercher"],
    ],
  );
});

test("chooseElement reads a full snapshot instead of a runtime diff", async () => {
  const tab = fakeTab(
    'Browser tab: 1, Title: "t", URL: "https://example.test/".\nThere has been no change in the accessibility tree.',
  );
  const decision = await chooseElement(tab, { goal: "Do something" });
  assert.equal(decision.status, "abstain");
  assert.equal(decision.reason, "no-actionable-elements");
  assert.deepEqual(tab.reads, [{ mode: "state", options: { disableDiffing: true } }]);
});

function fakeFetch(payload, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
    };
  };
  impl.calls = calls;
  return impl;
}

function answersFor(choice, presence, confidence = 0.62) {
  return {
    model: "jev-1.13.0",
    answers: {
      next: { type: "choice", choice, confidence },
      on_page: { type: "noul", noul: presence },
    },
    usage: { input_tokens: 412, output_tokens: 5 },
  };
}

test("parseAx keeps only actionable elements, with their runtime index", () => {
  const { page, candidates, actionable } = parseAx(AX);
  assert.equal(page.title, "Search results");
  assert.equal(page.url, "https://example.test/search?q=tea");
  assert.deepEqual(
    candidates.map((candidate) => [candidate.id, candidate.index, candidate.role]),
    [
      ["e3", 3, "textbox"],
      ["e4", 4, "button"],
      ["e5", 5, "link"],
      ["e7", 7, "link"],
      ["e8", 8, "checkbox"],
      ["e9", 9, "combobox"],
    ],
  );
  assert.equal(actionable, 6);
  assert.equal(candidates[0].label, "Search · value: tea");
  assert.equal(candidates[1].disabled, true);
  assert.equal(candidates[2].label, "Green tea · value: /tea/green");
});

test("parseAx stops at the focus footer and honours the limit", () => {
  const limited = parseAx(AX, { limit: 2 });
  assert.equal(limited.candidates.length, 2);
  assert.equal(limited.actionable, 6);
  assert.equal(limited.truncatedElements, 4);
  const footer = AX.split("\n").at(-1);
  assert.equal(parseAx(footer).candidates.length, 0);
});

test("buildAsk offers every candidate as a choice and bounds the state", () => {
  const { page, candidates } = parseAx(AX);
  const { state, questions } = buildAsk({
    goal: "find a green tea".repeat(60),
    page,
    candidates,
    history: Array.from({ length: 9 }, (_, i) => `step ${i}`),
  });
  assert.equal(questions.next.type, "choice");
  assert.deepEqual(Object.keys(questions.next.criteria), candidates.map((c) => c.id));
  assert.equal(questions.on_page.type, "noul");
  assert.ok(state.task.length <= 600);
  assert.equal(state.elements.length, candidates.length);
  assert.equal(state.elements[1].disabled, true);
  assert.deepEqual(state.elements[0], { id: "e3", role: "textbox", label: "Search · value: tea" });
  assert.equal(state.recent_actions.length, 6);
  assert.equal(state.recent_actions.at(-1), "step 8");
  assert.deepEqual(state.page, { title: "Search results", url: "https://example.test/search?q=tea" });
});

test("chooseElement returns the offered element Jev picked", async () => {
  const fetchImpl = fakeFetch(answersFor("e5", 0.93));
  const decision = await chooseElement(fakeTab(), {
    goal: "open green tea",
    apiKey: "test-key",
    fetch: fetchImpl,
  });
  assert.equal(decision.status, "choose");
  assert.equal(decision.index, 5);
  assert.equal(decision.id, "e5");
  assert.equal(decision.role, "link");
  assert.equal(decision.label, "Green tea · value: /tea/green");
  assert.equal(decision.presence, 0.93);
  assert.equal(decision.model, "jev-1.13.0");
  assert.equal(decision.usage.input_tokens, 412);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(fetchImpl.calls[0].headers.authorization, "Bearer test-key");
  assert.equal(JSON.stringify(decision).includes("test-key"), false);
  const sent = fetchImpl.calls[0].body;
  assert.equal(sent.model, "jev-latest");
  assert.equal(sent.questions.next.type, "choice");
  assert.equal(sent.state.elements.length, 6);
  assert.match(sent.questions.next.instructions, /untrusted data/);
});

test("chooseElement abstains when Jev says the element is not on the page", async () => {
  const decision = await chooseElement(fakeTab(), {
    goal: "open green tea",
    apiKey: "test-key",
    fetch: fakeFetch(answersFor("e5", 0.2, 0.8)),
  });
  assert.equal(decision.status, "abstain");
  assert.equal(decision.reason, "presence-below-threshold");
  assert.equal(decision.presence, 0.2);
});

test("chooseElement abstains on a choice that was never offered", async () => {
  const decision = await chooseElement(fakeTab(), {
    goal: "open green tea",
    apiKey: "test-key",
    fetch: fakeFetch(answersFor("e99", 0.9)),
  });
  assert.equal(decision.status, "abstain");
  assert.equal(decision.reason, "choice-not-offered");
  assert.equal(decision.choice, "e99");
});

test("chooseElement abstains without calling Jev when nothing is actionable", async () => {
  const fetchImpl = fakeFetch(answersFor("e1", 1));
  const decision = await chooseElement(fakeTab("1 AXWebArea Empty\n\t2 text nothing to do"), {
    goal: "anything",
    fetch: fetchImpl,
  });
  assert.equal(decision.status, "abstain");
  assert.equal(decision.reason, "no-actionable-elements");
  assert.equal(fetchImpl.calls.length, 0);
});

test("askJev goes through the local router when a caller can reach loopback", async () => {
  const fetchImpl = fakeFetch(answersFor("e5", 0.9));
  await chooseElement(fakeTab(), {
    goal: "open green tea",
    askUrl: "http://127.0.0.1:4319/ask",
    fetch: fetchImpl,
  });
  assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:4319/ask");
  assert.equal("authorization" in fetchImpl.calls[0].headers, false);
});

test("readApiKey reads the env files the router uses, and stops at the environment", async () => {
  const saved = process.env.TYPESAFE_API_KEY;
  const dir = mkdtempSync(path.join(tmpdir(), "jev-key-"));
  const file = path.join(dir, "env");
  writeFileSync(file, 'OTHER=1\nTYPESAFE_API_KEY="file-key"\n');
  try {
    delete process.env.TYPESAFE_API_KEY;
    assert.equal(await readApiKey({ keyFiles: [path.join(dir, "missing"), file] }), "file-key");
    process.env.TYPESAFE_API_KEY = "env-key";
    assert.equal(await readApiKey({ keyFiles: [file] }), "env-key");
  } finally {
    delete process.env.TYPESAFE_API_KEY;
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chooseElement reports an unreachable or failing endpoint without throwing", async () => {
  const offline = await chooseElement(fakeTab(), {
    goal: "open green tea",
    apiKey: "test-key",
    fetch: async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:4319");
    },
  });
  assert.equal(offline.status, "error");
  assert.equal(offline.reason, "request-failed");
  assert.match(offline.detail, /ECONNREFUSED/);

  const failing = await chooseElement(fakeTab(), {
    goal: "open green tea",
    apiKey: "test-key",
    fetch: fakeFetch("nope", { status: 502 }),
  });
  assert.equal(failing.status, "error");
  assert.match(failing.detail, /502/);
});

test("chooseElement says so when no key is configured, without calling anything", async () => {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const decision = await chooseElement(fakeTab(), {
      goal: "open green tea",
      keyFiles: [],
      fetch: async () => {
        throw new Error("fetch must not be called without a key");
      },
    });
    assert.equal(decision.status, "error");
    assert.equal(decision.reason, "no-api-key");
    assert.match(decision.detail, /TYPESAFE_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  }
});

test("chooseElement requires a goal", async () => {
  await assert.rejects(() => chooseElement(fakeTab(), { goal: "  " }), /goal is required/);
});
