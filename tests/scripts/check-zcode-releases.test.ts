import { describe, expect, test } from "bun:test";
import {
  buildIssueDraft,
  compareVersions,
  fetchNewReleases,
  hasMatchingIssue,
  issueMarker,
  parseChangelogPage,
  parseGitHubIssuePages,
  runReleaseCheck,
  validateEnvironment,
  type ExistingIssue,
  type Fetcher,
  type IssueClient,
  type IssueDraft,
} from "../../scripts/check-zcode-releases.ts";

function release(version: string, contents: string): string {
  return `
    <section>
      <h2>Release v${version}</h2>
      <article>${contents}</article>
    </section>
  `;
}

function page(...releases: string[]): string {
  return `<!doctype html><html><body>${releases.join("\n")}</body></html>`;
}

function fetchPages(pages: readonly string[]): {
  fetchImpl: Fetcher;
  urls: URL[];
} {
  const urls: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    urls.push(url);
    const pageNumber = Number(url.searchParams.get("page"));
    const contents = pages[pageNumber - 1];
    if (contents === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response(contents, { status: 200 });
  });
  return { fetchImpl, urls };
}

describe("ZCode changelog parsing", () => {
  test("converts semantic release notes to Markdown without translating the text", () => {
    const html = page(release("3.10.3", `
      <h2>New Features &amp; Changes</h2>
      <p>Use <strong>fast</strong> mode with <code>run()</code>.<br>Read the
        <a href="/en/docs">documentation</a>.</p>
      <ul>
        <li>Preserves <em>English</em> copy</li>
        <li>Supports nested lists
          <ol><li>First</li><li>Second</li></ol>
        </li>
      </ul>
    `));

    expect(parseChangelogPage(html)).toEqual([{
      version: "3.10.3",
      markdown: [
        "## New Features &amp; Changes",
        "Use **fast** mode with `run()`.<br>Read the [documentation](https://zcode.z.ai/en/docs).",
        "- Preserves *English* copy\n- Supports nested lists\n    1. First\n    2. Second",
      ].join("\n\n").replace("<br>", "  \n"),
    }]);
  });

  test("rejects missing release structure and duplicate headings", () => {
    expect(() => parseChangelogPage("<html><body>No releases</body></html>"))
      .toThrow("No ZCode release headings");
    expect(() => parseChangelogPage(page(
      release("3.10.3", "<p>One</p>"),
      release("3.10.3", "<p>Two</p>"),
    ))).toThrow("Duplicate ZCode release heading");
    expect(() => parseChangelogPage("<h2>Release v3.10.3</h2>"))
      .toThrow("Missing changelog article");
  });

  test("rejects unsupported content-bearing elements", () => {
    expect(() => parseChangelogPage(page(
      release("3.10.3", "<table><tr><td>Unexpected</td></tr></table>"),
    ))).toThrow("Unsupported changelog block element: <table>");
  });
});

describe("ZCode version discovery", () => {
  test("compares numeric version components", () => {
    expect(compareVersions("3.10.0", "3.9.9")).toBeGreaterThan(0);
    expect(compareVersions("3.10.2", "3.10.2")).toBe(0);
    expect(compareVersions("3.9.9", "3.10.0")).toBeLessThan(0);
    expect(() => compareVersions("3.10", "3.10.0")).toThrow("Invalid ZCode version");
  });

  test("loads cumulative pages until the current version is found", async () => {
    const first = page(
      release("3.10.2", "<p>Newest</p>"),
      release("3.10.1", "<p>Newer</p>"),
    );
    const second = page(
      release("3.10.2", "<p>Newest</p>"),
      release("3.10.1", "<p>Newer</p>"),
      release("3.9.2", "<p>Current</p>"),
    );
    const { fetchImpl, urls } = fetchPages([first, second]);

    await expect(fetchNewReleases("3.9.2", fetchImpl)).resolves.toEqual([
      { version: "3.10.1", markdown: "Newer" },
      { version: "3.10.2", markdown: "Newest" },
    ]);
    expect(urls.map((url) => url.searchParams.get("page"))).toEqual(["1", "2"]);
  });

  test("stops when a cumulative page adds no versions", async () => {
    const contents = page(release("3.2.0", "<p>Release notes</p>"));
    const { fetchImpl, urls } = fetchPages([contents, contents]);

    await expect(fetchNewReleases("3.0.0", fetchImpl)).resolves.toEqual([
      { version: "3.2.0", markdown: "Release notes" },
    ]);
    expect(urls).toHaveLength(2);
  });

  test("fails on HTTP errors and empty new release notes", async () => {
    const failingFetch: Fetcher = async () => new Response("unavailable", { status: 503 });
    await expect(fetchNewReleases("3.10.2", failingFetch)).rejects.toThrow("HTTP 503");

    const { fetchImpl } = fetchPages([page(
      release("3.10.3", ""),
      release("3.10.2", "<p>Current</p>"),
    )]);
    await expect(fetchNewReleases("3.10.2", fetchImpl)).rejects.toThrow(
      "Changelog for ZCode 3.10.3 is empty",
    );
  });
});

describe("ZCode release issues", () => {
  test("builds the fixed Japanese issue wrapper with the English changelog", () => {
    const draft = buildIssueDraft({ version: "3.10.3", markdown: "## Bug Fixes\n\n- Fixed it." });
    expect(draft.title).toBe("ZCode 3.10.3 に対応する");
    expect(draft.body).toContain("ZCode 3.10.3 がリリースされたため");
    expect(draft.body).toContain("Changelog: https://zcode.z.ai/en/changelog");
    expect(draft.body).toContain("## Changelog\n\n## Bug Fixes\n\n- Fixed it.");
    expect(draft.body).toContain(issueMarker("3.10.3"));
  });

  test("matches open or closed issues by exact title or marker", () => {
    const draft = buildIssueDraft({ version: "3.10.3", markdown: "Notes" });
    const openByTitle: ExistingIssue = { title: draft.title, body: null, state: "open" };
    const closedByMarker: ExistingIssue = {
      title: "Older title",
      body: issueMarker("3.10.3"),
      state: "closed",
    };

    expect(hasMatchingIssue(draft, [openByTitle])).toBeTrue();
    expect(hasMatchingIssue(draft, [closedByMarker])).toBeTrue();
    expect(hasMatchingIssue(draft, [])).toBeFalse();
  });

  test("parses paginated issues and excludes pull requests", () => {
    expect(parseGitHubIssuePages([[{
      title: "Open",
      body: null,
      state: "open",
    }, {
      title: "Closed",
      body: "body",
      state: "closed",
    }, {
      title: "PR",
      body: null,
      state: "open",
      pull_request: { url: "https://api.github.test/pulls/1" },
    }]])).toEqual([
      { title: "Open", body: null, state: "open" },
      { title: "Closed", body: "body", state: "closed" },
    ]);
  });

  test("creates each new version once and resumes idempotently", async () => {
    const contents = page(
      release("3.10.4", "<p>Four</p>"),
      release("3.10.3", "<p>Three</p>"),
      release("3.10.2", "<p>Current</p>"),
    );
    const existing: ExistingIssue[] = [];
    const created: IssueDraft[] = [];
    const issueClient: IssueClient = {
      async listIssues() {
        return [...existing];
      },
      async createIssue(_repository, draft) {
        created.push(draft);
        existing.push({ title: draft.title, body: draft.body, state: "open" });
        return `https://github.test/issues/${created.length}`;
      },
    };
    const fetchImpl: Fetcher = async () => new Response(contents);
    const options = {
      currentVersion: "3.10.2",
      repository: "owner/repository",
      fetchImpl,
      issueClient,
      log: () => {},
    };

    await expect(runReleaseCheck(options)).resolves.toEqual([
      "https://github.test/issues/1",
      "https://github.test/issues/2",
    ]);
    expect(created.map((draft) => draft.version)).toEqual(["3.10.3", "3.10.4"]);
    await expect(runReleaseCheck(options)).resolves.toEqual([]);
    expect(created).toHaveLength(2);
  });

  test("does not create an issue when listing existing issues fails", async () => {
    let createCalls = 0;
    const issueClient: IssueClient = {
      async listIssues() {
        throw new Error("GitHub API unavailable");
      },
      async createIssue() {
        createCalls += 1;
        return "unreachable";
      },
    };
    const contents = page(
      release("3.10.3", "<p>New</p>"),
      release("3.10.2", "<p>Current</p>"),
    );

    await expect(runReleaseCheck({
      currentVersion: "3.10.2",
      repository: "owner/repository",
      fetchImpl: async () => new Response(contents),
      issueClient,
      log: () => {},
    })).rejects.toThrow("GitHub API unavailable");
    expect(createCalls).toBe(0);
  });

  test("requires the GitHub Actions environment", () => {
    expect(() => validateEnvironment({ GITHUB_REPOSITORY: "owner/repository" }))
      .toThrow("GH_TOKEN is required");
    expect(() => validateEnvironment({ GH_TOKEN: "token", GITHUB_REPOSITORY: "invalid" }))
      .toThrow("owner/name format");
    expect(validateEnvironment({ GH_TOKEN: "token", GITHUB_REPOSITORY: "owner/repository" }))
      .toEqual({ repository: "owner/repository" });
  });
});
