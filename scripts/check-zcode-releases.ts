import { CURRENT_ZCODE_ARTIFACT } from "../src/zcode/discovery/manifest.ts";

export const ZCODE_CHANGELOG_URL = "https://zcode.z.ai/en/changelog";

interface HtmlNode {
  tagName: string;
  attributes: ReadonlyMap<string, string>;
  children: HtmlChild[];
}

type HtmlChild = HtmlNode | string;

export interface ChangelogRelease {
  version: string;
  markdown: string;
}

export type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ExistingIssue {
  title: string;
  body: string | null;
  state: "open" | "closed";
}

export interface IssueDraft {
  version: string;
  title: string;
  body: string;
}

export interface IssueClient {
  listIssues(repository: string): Promise<ExistingIssue[]>;
  createIssue(repository: string, draft: IssueDraft): Promise<string>;
}

interface ReleaseCheckOptions {
  currentVersion: string;
  repository: string;
  fetchImpl: Fetcher;
  issueClient: IssueClient;
  log: (message: string) => void;
}

interface ActiveArticle {
  version: string;
  root: HtmlNode;
  stack: HtmlNode[];
}

function parseVersion(version: string): readonly [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) {
    throw new Error(`Invalid ZCode version: ${version}`);
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new Error(`Invalid ZCode version: ${version}`);
  }

  return [major, minor, patch];
}

export function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);

  for (let index = 0; index < leftParts.length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined || rightPart === undefined) {
      throw new Error("Invalid version component index");
    }
    const difference = leftPart - rightPart;
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

function textContent(node: HtmlNode): string {
  return node.children.map((child) =>
    typeof child === "string" ? child : textContent(child)
  ).join("");
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ");
}

function escapeMarkdown(text: string): string {
  return normalizeText(text).replace(/([\\`*_[\]<>~])/g, "\\$1");
}

function inlineCode(text: string): string {
  const normalized = normalizeText(text).trim();
  const longestRun = Math.max(0, ...Array.from(normalized.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longestRun + 1);
  const padding = normalized.startsWith("`") || normalized.endsWith("`") ? " " : "";
  return `${fence}${padding}${normalized}${padding}${fence}`;
}

function markdownLinkTarget(href: string): string {
  let url: URL;
  try {
    url = new URL(href, ZCODE_CHANGELOG_URL);
  } catch {
    throw new Error(`Invalid changelog link: ${href}`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported changelog link protocol: ${url.protocol}`);
  }

  return url.href.replaceAll("(", "%28").replaceAll(")", "%29");
}

function renderInlineChildren(children: readonly HtmlChild[]): string {
  return children.map((child) => {
    if (typeof child === "string") {
      return escapeMarkdown(child);
    }

    const content = renderInlineChildren(child.children);
    switch (child.tagName) {
      case "span":
        return content;
      case "a": {
        const href = child.attributes.get("href");
        if (href === undefined) {
          throw new Error("Changelog link is missing href");
        }
        return `[${content.trim()}](${markdownLinkTarget(href)})`;
      }
      case "strong":
      case "b":
        return `**${content.trim()}**`;
      case "em":
      case "i":
        return `*${content.trim()}*`;
      case "code":
        return inlineCode(textContent(child));
      case "br":
        return "  \n";
      default:
        throw new Error(`Unsupported inline changelog element: <${child.tagName}>`);
    }
  }).join("");
}

function renderListItem(node: HtmlNode, marker: string, depth: number): string {
  const inlineChildren: HtmlChild[] = [];
  const nestedLists: HtmlNode[] = [];

  for (const child of node.children) {
    if (typeof child !== "string" && (child.tagName === "ul" || child.tagName === "ol")) {
      nestedLists.push(child);
    } else if (typeof child !== "string" && child.tagName === "p") {
      inlineChildren.push(...child.children);
    } else {
      inlineChildren.push(child);
    }
  }

  const content = renderInlineChildren(inlineChildren).trim();
  if (content.length === 0 && nestedLists.length === 0) {
    throw new Error("Changelog contains an empty list item");
  }

  const indentation = "    ".repeat(depth);
  let markdown = `${indentation}${marker}${content}`.trimEnd();
  for (const nestedList of nestedLists) {
    markdown += `\n${renderList(nestedList, depth + 1)}`;
  }
  return markdown;
}

function renderList(node: HtmlNode, depth: number): string {
  const ordered = node.tagName === "ol";
  const items: string[] = [];

  for (const child of node.children) {
    if (typeof child === "string") {
      if (child.trim().length !== 0) {
        throw new Error("Changelog list contains text outside a list item");
      }
      continue;
    }
    if (child.tagName !== "li") {
      throw new Error(`Unsupported changelog list element: <${child.tagName}>`);
    }

    const marker = ordered ? `${items.length + 1}. ` : "- ";
    items.push(renderListItem(child, marker, depth));
  }

  if (items.length === 0) {
    throw new Error("Changelog contains an empty list");
  }
  return items.join("\n");
}

function renderArticle(root: HtmlNode): string {
  const blocks: string[] = [];

  for (const child of root.children) {
    if (typeof child === "string") {
      if (child.trim().length !== 0) {
        blocks.push(escapeMarkdown(child).trim());
      }
      continue;
    }

    switch (child.tagName) {
      case "h1":
      case "h2":
      case "h3": {
        const level = Number(child.tagName.slice(1));
        const heading = renderInlineChildren(child.children).trim();
        if (heading.length === 0) {
          throw new Error("Changelog contains an empty heading");
        }
        blocks.push(`${"#".repeat(level)} ${heading}`);
        break;
      }
      case "p": {
        const paragraph = renderInlineChildren(child.children).trim();
        if (paragraph.length === 0) {
          throw new Error("Changelog contains an empty paragraph");
        }
        blocks.push(paragraph);
        break;
      }
      case "ul":
      case "ol":
        blocks.push(renderList(child, 0));
        break;
      default:
        throw new Error(`Unsupported changelog block element: <${child.tagName}>`);
    }
  }

  return blocks.join("\n\n").trim();
}

export function parseChangelogPage(html: string): ChangelogRelease[] {
  const releaseHeaders = new Set<string>();
  const releases = new Map<string, ChangelogRelease>();
  let h2Text: string[] | undefined;
  let pendingVersion: string | undefined;
  let activeArticle: ActiveArticle | undefined;

  const rewriter = new HTMLRewriter()
    .on("h2", {
      element(element) {
        h2Text = [];
        element.onEndTag(() => {
          const heading = normalizeText(h2Text?.join("") ?? "").trim();
          h2Text = undefined;
          const match = /^Release v(\d+\.\d+\.\d+)$/.exec(heading);
          if (match === null) {
            return;
          }

          const version = match[1];
          if (version === undefined) {
            throw new Error(`Invalid ZCode release heading: ${heading}`);
          }
          if (releaseHeaders.has(version)) {
            throw new Error(`Duplicate ZCode release heading: ${version}`);
          }
          releaseHeaders.add(version);
          pendingVersion = version;
        });
      },
      text(text) {
        h2Text?.push(text.text);
      },
    })
    .on("article", {
      element(element) {
        if (pendingVersion === undefined) {
          return;
        }
        if (activeArticle !== undefined) {
          throw new Error("Nested changelog articles are not supported");
        }

        const root: HtmlNode = { tagName: "article", attributes: new Map(), children: [] };
        activeArticle = { version: pendingVersion, root, stack: [root] };
        pendingVersion = undefined;

        element.onEndTag(() => {
          if (activeArticle === undefined || activeArticle.stack.length !== 1) {
            throw new Error("Malformed changelog article");
          }
          const release: ChangelogRelease = {
            version: activeArticle.version,
            markdown: renderArticle(activeArticle.root),
          };
          if (releases.has(release.version)) {
            throw new Error(`Duplicate ZCode release article: ${release.version}`);
          }
          releases.set(release.version, release);
          activeArticle = undefined;
        });
      },
      text(text) {
        const current = activeArticle?.stack.at(-1);
        current?.children.push(text.text);
      },
    })
    .on("article *", {
      element(element) {
        if (activeArticle === undefined) {
          return;
        }

        const parent = activeArticle.stack.at(-1);
        if (parent === undefined) {
          throw new Error("Malformed changelog element stack");
        }
        const node: HtmlNode = {
          tagName: element.tagName,
          attributes: new Map(element.attributes),
          children: [],
        };
        parent.children.push(node);

        if (element.canHaveContent) {
          activeArticle.stack.push(node);
          element.onEndTag(() => {
            const closed = activeArticle?.stack.pop();
            if (closed !== node) {
              throw new Error("Malformed changelog element nesting");
            }
          });
        }
      },
    });

  rewriter.transform(html);

  if (activeArticle !== undefined) {
    throw new Error("Unclosed changelog article");
  }
  if (releaseHeaders.size === 0) {
    throw new Error("No ZCode release headings found in changelog");
  }
  for (const version of releaseHeaders) {
    if (!releases.has(version)) {
      throw new Error(`Missing changelog article for ZCode ${version}`);
    }
  }

  return [...releases.values()];
}

export async function fetchNewReleases(
  currentVersion: string,
  fetchImpl: Fetcher = fetch,
): Promise<ChangelogRelease[]> {
  parseVersion(currentVersion);
  const collected = new Map<string, ChangelogRelease>();
  let previousCount = 0;

  for (let page = 1;; page += 1) {
    const url = new URL(ZCODE_CHANGELOG_URL);
    url.searchParams.set("page", String(page));
    const response = await fetchImpl(url, {
      headers: {
        accept: "text/html",
        "user-agent": "zcode-acp-release-check",
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch ZCode changelog: HTTP ${response.status}`);
    }

    for (const release of parseChangelogPage(await response.text())) {
      const existing = collected.get(release.version);
      if (existing !== undefined && existing.markdown !== release.markdown) {
        throw new Error(`Conflicting changelog content for ZCode ${release.version}`);
      }
      collected.set(release.version, release);
    }

    if (collected.has(currentVersion)) {
      break;
    }
    if (collected.size === previousCount) {
      break;
    }
    previousCount = collected.size;
  }

  const releases = [...collected.values()]
    .filter((release) => compareVersions(release.version, currentVersion) > 0)
    .sort((left, right) => compareVersions(left.version, right.version));

  for (const release of releases) {
    if (release.markdown.length === 0) {
      throw new Error(`Changelog for ZCode ${release.version} is empty`);
    }
  }
  return releases;
}

export function issueMarker(version: string): string {
  parseVersion(version);
  return `<!-- zcode-acp:zcode-release:${version} -->`;
}

export function buildIssueDraft(release: ChangelogRelease): IssueDraft {
  if (release.markdown.trim().length === 0) {
    throw new Error(`Changelog for ZCode ${release.version} is empty`);
  }
  parseVersion(release.version);

  const title = `ZCode ${release.version} に対応する`;
  const body = [
    `ZCode ${release.version} がリリースされたため、zcode-acp も同バージョンへ追従する必要があります。`,
    `Changelog: ${ZCODE_CHANGELOG_URL}`,
    "## Changelog",
    release.markdown.trim(),
    issueMarker(release.version),
    "",
  ].join("\n\n");

  return { version: release.version, title, body };
}

export function hasMatchingIssue(draft: IssueDraft, issues: readonly ExistingIssue[]): boolean {
  const marker = issueMarker(draft.version);
  return issues.some((issue) => issue.title === draft.title || issue.body?.includes(marker) === true);
}

async function runGh(args: readonly string[], input?: string): Promise<string> {
  const subprocess = Bun.spawn(["gh", ...args], {
    env: process.env,
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (input !== undefined) {
    const stdin = subprocess.stdin;
    if (stdin === undefined || typeof stdin === "number") {
      throw new Error("Failed to open gh standard input");
    }
    stdin.write(input);
    stdin.end();
  }

  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`gh ${args[0] ?? ""} failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  return stdout.trim();
}

export function parseGitHubIssuePages(value: unknown): ExistingIssue[] {
  if (!Array.isArray(value) || !value.every(Array.isArray)) {
    throw new Error("Unexpected response from GitHub issues API");
  }

  const issues: ExistingIssue[] = [];
  for (const page of value) {
    for (const item of page) {
      if (typeof item !== "object" || item === null) {
        throw new Error("Unexpected issue entry from GitHub issues API");
      }
      const candidate = item as Record<string, unknown>;
      if ("pull_request" in candidate) {
        continue;
      }
      if (typeof candidate.title !== "string") {
        throw new Error("GitHub issue is missing a title");
      }
      if (candidate.body !== null && typeof candidate.body !== "string") {
        throw new Error("GitHub issue has an invalid body");
      }
      if (candidate.state !== "open" && candidate.state !== "closed") {
        throw new Error("GitHub issue has an invalid state");
      }
      issues.push({ title: candidate.title, body: candidate.body, state: candidate.state });
    }
  }
  return issues;
}

export const ghIssueClient: IssueClient = {
  async listIssues(repository) {
    const output = await runGh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/issues?state=all&per_page=100`,
    ]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new Error("GitHub issues API returned invalid JSON");
    }
    return parseGitHubIssuePages(parsed);
  },

  async createIssue(repository, draft) {
    return await runGh([
      "issue",
      "create",
      "--repo",
      repository,
      "--title",
      draft.title,
      "--body-file",
      "-",
    ], draft.body);
  },
};

export async function runReleaseCheck(options: ReleaseCheckOptions): Promise<string[]> {
  const releases = await fetchNewReleases(options.currentVersion, options.fetchImpl);
  const drafts = releases.map(buildIssueDraft);
  const issues = await options.issueClient.listIssues(options.repository);
  const createdUrls: string[] = [];

  for (const draft of drafts) {
    if (hasMatchingIssue(draft, issues)) {
      options.log(`Skipping ZCode ${draft.version}: matching issue already exists`);
      continue;
    }

    const url = await options.issueClient.createIssue(options.repository, draft);
    issues.push({ title: draft.title, body: draft.body, state: "open" });
    createdUrls.push(url);
    options.log(`Created issue for ZCode ${draft.version}: ${url}`);
  }

  if (drafts.length === 0) {
    options.log(`No ZCode release newer than ${options.currentVersion}`);
  }
  return createdUrls;
}

export function validateEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): { repository: string } {
  const token = environment.GH_TOKEN;
  const repository = environment.GITHUB_REPOSITORY;
  if (token === undefined || token.length === 0) {
    throw new Error("GH_TOKEN is required");
  }
  if (repository === undefined || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be in owner/name format");
  }
  return { repository };
}

async function main(): Promise<void> {
  const { repository } = validateEnvironment(process.env);

  await runReleaseCheck({
    currentVersion: CURRENT_ZCODE_ARTIFACT.appVersion,
    repository,
    fetchImpl: fetch,
    issueClient: ghIssueClient,
    log: console.log,
  });
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
