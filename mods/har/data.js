// HAR data for the herdr panels: everything comes from the `har` CLI
// (`har env status --json`, `har env runs list --json`) and the harness's own
// `.har/stages.json`, so Mission Control does not need to be running.
import { exec, run, readTextFile, writeTextFile, hc, panes as panesNow, spaces as spacesNow, agents as agentsNow,
  shared as sharedNow, setShared as setSharedNow, home, appHome, focused } from "herdr";

// Each read of the window state (spaces, panes, agents) or of a shared value copies it out of the app. A render
// asks for them per slot and per tab, which with many slots and spaces outran herdr's render budget ("This view
// could not be re-rendered: interrupted"). Between frameStart() and frameEnd() (one render) each is read once.
let frame = null;
export const frameStart = () => { frame = new Map(); };
export const frameEnd = () => { frame = null; };
const memo = (k, read) => { if (!frame) return read(); if (!frame.has(k)) frame.set(k, read()); return frame.get(k); };
const spaces = () => memo("spaces", spacesNow);
const panes = () => memo("panes", panesNow);
const agents = () => memo("agents", agentsNow);
const shared = (k) => memo(`shared:${k}`, () => sharedNow(k));
const setShared = (k, v) => { frame?.delete(`shared:${k}`); return setSharedNow(k, v); };

export const MC_URL = "http://localhost:3847";
const KEY = { repos: "har.repos", repo: "har.repo", slot: "har.slot", snap: "har.snapshot", tick: "har.refresh" };

export { home };
export const base = (p) => (p || "").replace(/\/+$/, "").split("/").pop() || p;
export const tilde = (p) => (p && p.startsWith(home()) ? "~" + p.slice(home().length) : p || "");

// ---- shared selection -------------------------------------------------------
export function repos(seed) {
  const list = shared(KEY.repos);
  if (Array.isArray(list) && list.length) return list;
  return (seed ?? []).map((r) => r.replace(/^~(?=\/)/, home()));
}
export const setRepos = (list) => setShared(KEY.repos, list);
export function currentRepo(seed) {
  const all = repos(seed), r = shared(KEY.repo);
  return all.includes(r) ? r : all[0] ?? null;
}
export const selectRepo = (r) => { setShared(KEY.repo, r); setShared(KEY.slot, null); };
export const currentSlot = () => { const s = shared(KEY.slot); return typeof s === "number" ? s : null; };
export const selectSlot = (id) => setShared(KEY.slot, id);
export const snapshot = (repo) => (shared(KEY.snap) ?? {})[repo] ?? null;
export const live = () => shared("har.live") ?? null;
export function setLive(v) {
  const cur = shared("har.live") ?? null;
  if (JSON.stringify(cur) !== JSON.stringify(v)) setShared("har.live", v);
}
export const bump = () => setShared(KEY.tick, Date.now());
/** Panel settings (persisted): slotView "compact" | "detailed", showFree, agent. */
export const SETTING_DEFAULTS = { slotView: "compact", showFree: true, spacing: "none", links: "herdr", newMode: "ask", nameSpaces: true, slotClick: "resume" };
export const setting = (k) => (shared("har.settings") ?? {})[k] ?? SETTING_DEFAULTS[k];
export const setSetting = (k, v) => setShared("har.settings", { ...(shared("har.settings") ?? {}), [k]: v });
export const expanded = (r) => (shared("har.expanded") ?? {})[r] ?? true;
export const toggleExpanded = (r) => setShared("har.expanded", { ...(shared("har.expanded") ?? {}), [r]: !expanded(r) });

/** Words a search can hit for one slot: id, work unit (+title), branch, PR number/title, agent titles (their prompt). */
export function slotHaystack(snap, slot) {
  const f = slotFacts(snap, slot);
  const unit = (snap.workUnits ?? []).find((w) => w.id === slot.work);
  return [`#${slot.id}`, `slot ${slot.id}`, slot.work, unit?.title, slot.branch,
    f.pr && `#${f.pr.number}`, f.pr && `pr ${f.pr.number}`, f.pr?.title, f.git?.subject,
    ...f.agents.map((a) => a.title), ...f.agents.map((a) => a.program?.name)].filter(Boolean).join("\n").toLowerCase();
}

/** The coding agent new slots start (a knownAgents key: "claude", "codex", ...). */
export const agentChoice = () => shared("har.agent") ?? "claude";
export const setAgentChoice = (k) => setShared("har.agent", k);
export function removeRepo(r) {
  const list = repos().filter((x) => x !== r);
  setRepos(list);
  if (shared(KEY.repo) === r) selectRepo(list[0] ?? null);
}
export const tick = () => shared(KEY.tick) ?? 0;

// ---- fetching -----------------------------------------------------------------
function trimRun(r) {
  const v = r.result?.data?.verification;
  return {
    id: r.runId, stage: r.stageId, kind: r.kind, slot: r.agentId ?? null, status: r.status,
    at: r.startedAt, ms: r.durationMs ?? null, full: Boolean(v && v.stages?.length > 3),
    stages: v?.stages?.map((s) => ({ name: s.name, pass: s.pass, skipped: s.skipped ?? false, ms: s.ms ?? null })) ?? null,
  };
}

function trimSlot(s) {
  return {
    id: s.agentId, active: s.active, branch: s.branch ?? null, workDir: s.workDir ?? s.worktreePath ?? null,
    previews: s.previewUrls ?? {}, lastVerify: s.lastVerifyStatus ?? null, lastRunAt: s.lastRunAt ?? null,
    work: s.workUnitId ?? null, attempt: s.attemptId ?? null, baseBranch: s.baseBranch ?? null,
    baseCommit: s.baseCommit ? s.baseCommit.slice(0, 7) : null, since: s.sessionCreatedAt ?? null,
    dirty: s.dirty ?? null, ahead: s.ahead ?? null, behind: s.behind ?? null, stale: s.stale ?? false,
    usage: s.harnessUsage ?? null, mode: s.mode ?? null,
    blockers: (s.readiness?.blockers ?? []).filter((b) => b.code !== "slot_occupied" && b.code !== "slot_dirty").map((b) => b.message),
    warnings: s.readiness?.warnings ?? [],
  };
}

// herdr starts mods with its own PATH, which usually lacks the user's shell setup
// (nvm/volta/fnm/mise/asdf/Homebrew). bin/find-tools.sh finds har, node and gh — Settings
// paths, then the login shell, then the interactive shell (detached), then the usual install
// folders — and every command then runs with those folders first on PATH, so `#!/usr/bin/env node`
// scripts and volta/asdf shims work.
let resolved = null, resolving = null;
const WRAP = 'PATH="$0:$PATH"; exec "$@"';

async function bins() {
  const epoch = shared("har.toolsEpoch") ?? 0;   // bumped by resetBins in any panel
  if (resolved && resolved.epoch === epoch) return resolved;
  resolved = null;
  resolving ??= (async () => {
    try {
      const r = await exec("sh", [`${BIN()}/find-tools.sh`, "", setting("harPath") ?? "", setting("nodePath") ?? ""], { timeout: 60000 });
      const kv = {}, tried = [];
      for (const line of (r.stdout ?? "").split("\n")) {
        const m = /^(\w+)=(.*)$/.exec(line);
        if (!m) continue;
        if (m[1] === "tried") tried.push(m[2]); else kv[m[1]] = m[2];
      }
      if (!kv.har || !kv.node) {
        const err = new Error(["`har` not found. Tried:", ...tried.map((t) => `• ${t}`),
          "Fix: npm i -g @osfactory/har, or set its path in HAR Settings (gear in the sidebar). See docs/guide.md → Troubleshooting."].join("\n"));
        err.tried = tried;
        throw err;
      }
      resolved = { path: kv.path, har: kv.har, node: kv.node, gh: kv.gh || null, how: kv.how, tried, epoch };
      setShared("har.tools", { har: kv.har, node: kv.node, gh: kv.gh || null, how: kv.how, at: Date.now() });
      return resolved;
    } catch (e) {
      setShared("har.tools", { error: String(e.message ?? e), at: Date.now() });
      throw e;
    } finally { resolving = null; }
  })();
  return resolving;
}
/** Forget the found tools (after a Settings change); the next command looks again. */
export function resetBins() {
  resolved = null; prCache.clear();
  setShared("har.tools", null);
  setShared("har.toolsEpoch", Date.now());   // every panel's copy of the mod looks again
  bump();
}
/** What the last lookup found, for Settings: {har, node, gh, how} or {error}. */
export const toolsInfo = () => shared("har.tools") ?? null;
export const toolsEpoch = () => shared("har.toolsEpoch") ?? 0;

/** Runs a found tool with the found folders first on PATH (herdr's exec takes no env). */
async function runTool(cmd, args, opts) {
  const b = await bins();
  return exec("sh", ["-c", WRAP, b.path, cmd, ...args], opts);
}
export async function har(args, opts = {}) {
  return runTool((await bins()).har, args, { timeout: 30000, ...opts });
}
/** argv for a herdr terminal, with the found folders first on PATH ("har" stands for the found har). */
export function withPath(argv) {
  if (!resolved || resolved.epoch !== (shared("har.toolsEpoch") ?? 0)) return argv;
  const [cmd, ...rest] = argv;
  return ["sh", "-c", WRAP, resolved.path, cmd === "har" ? resolved.har : cmd, ...rest];
}
const BIN = () => `${home()}/.config/herdr-app/mods/har/bin`;
export const launchScript = () => `${BIN()}/launch-agent.sh`;
export const browserInstallScript = () => `${BIN()}/install-browser.sh`;
export const chatInstallScript = () => `${BIN()}/install-chat.sh`;

// herdr-claude-chat: the chat view of a Claude Code terminal (ctrl-shift-j). Installed beside this mod.
let chatOk = null;
export async function hasChat() {
  if (chatOk === null) chatOk = (await exec("test", ["-f", `${appHome()}/mods/claude-chat/mod.json`]).catch(() => null))?.code === 0;
  return chatOk;
}
export const chatInstalled = () => chatOk;

/** The space that holds a repo's slot-less chats ("har-project · chat"), if one is open. */
export const chatLabel = (repo) => `${base(repo)} · chat`;
export const chatSpace = (repo) => spaces().find((s) => s.name === chatLabel(repo)) ?? null;

// ---- conversations ------------------------------------------------------------------------
// Claude Code and Codex conversations, from bin/conversations.mjs. Cached 30 s; a read in flight is shared.
//   conversations(repo, onChange, { repo, exclude: [branches] })   a project's own (not its active slots')
//   conversations(workDir, onChange, { repo, branch })            a slot's: started in its worktree, or bound
//                                                                  to it by HAR when they launched it
// `onChange` asks for a render once the list arrives; slotConversations() waits for it.
const convCache = new Map();
export const CONV_PAGE = 4, CONV_MORE = 8, CONV_LIMIT = 60;
function convEntry(dir, scope) {
  const extra = !scope?.repo ? [] : scope.branch ? ["--repo", scope.repo, "--branch", scope.branch]
    : scope.exclude?.length ? ["--repo", scope.repo, "--exclude-branches", scope.exclude.join(",")] : [];
  const key = [dir, ...extra].join("\n");
  const c = convCache.get(key);
  if (c && (c.loading || Date.now() - c.at <= 30000)) return c;
  const entry = { at: Date.now(), list: c?.list ?? null, loading: true, onChange: null };
  convCache.set(key, entry);
  entry.done = (async () => {
    try {
      const { node } = await bins();
      const r = await runTool(node, [`${BIN()}/conversations.mjs`, dir, String(CONV_LIMIT), ...extra], { timeout: 15000 });
      entry.list = JSON.parse(r.stdout).items ?? [];
    } catch { entry.list = entry.list ?? []; }
    entry.loading = false; entry.at = Date.now();
    entry.onChange?.();
  })();
  return entry;
}
export function conversations(dir, onChange, scope) {
  const e = convEntry(dir, scope);
  if (e.loading) e.onChange = onChange;
  return e.list;
}
const slotScope = (repo, slot) => ({ repo, branch: slot.branch ?? null });
/** A slot's conversations for rendering (null while the first read runs). */
export const slotConvs = (repo, slot, onChange) => (slot?.workDir ? conversations(slot.workDir, onChange, slotScope(repo, slot)) : []);
/** A slot's conversations, waiting for the read when nothing is cached yet. */
export async function slotConversations(repo, slot) {
  if (!slot?.workDir) return [];
  const e = convEntry(slot.workDir, slotScope(repo, slot));
  if (e.list == null) await e.done;
  return e.list ?? [];
}
/** A project's own conversations, without the ones bound to its active slots. */
export const repoConvs = (repo, onChange) =>
  conversations(repo, onChange, { repo, exclude: (snapshot(repo)?.slots ?? []).filter((s) => s.active && s.branch).map((s) => s.branch) });

// ---- worktree --------------------------------------------------------------------------
// A slot worktree's git state (bin/worktree.mjs): branch, base, ahead/behind, changed files and the commits to
// draw. Cached 5 s per worktree, so the slot view follows edits while it's shown.
const wtCache = new Map();
export function worktree(slot, onChange) {
  if (!slot?.workDir) return null;
  const key = `${slot.workDir}\n${slot.baseBranch ?? ""}`;
  const c = wtCache.get(key);
  if (!c || (!c.loading && Date.now() - c.at > 5000)) {
    const entry = { at: Date.now(), data: c?.data ?? null, loading: true, onChange };
    wtCache.set(key, entry);
    (async () => {
      try {
        const { node } = await bins();
        const r = await runTool(node, [`${BIN()}/worktree.mjs`, slot.workDir, ...(slot.baseBranch ? [slot.baseBranch] : [])], { timeout: 10000 });
        entry.data = JSON.parse(r.stdout);
      } catch (e) { entry.data = entry.data ?? { error: String(e?.message ?? e) }; }
      entry.loading = false; entry.at = Date.now();
      entry.onChange?.();
    })();
  } else if (c.loading) c.onChange = onChange;
  return wtCache.get(key).data;
}
/** Reads the worktree again on the next render (after a git action). */
export function rereadWorktree(slot) {
  for (const [k, e] of wtCache) if (k.startsWith(`${slot.workDir}\n`) && !e.loading) e.at = 0;
}

/** Runs git in a worktree: { ok, out } with stderr (or stdout) as the message when it fails. */
export async function git(dir, args) {
  // through runTool: git hooks (HAR's commit gate) need har and node on PATH
  const r = await runTool("git", ["-C", dir, ...args], { timeout: 120000 }).catch((e) => ({ code: 1, stderr: String(e?.message ?? e), stdout: "" }));
  return { ok: r.code === 0, out: (r.code === 0 ? r.stdout : r.stderr || r.stdout || `git ${args[0]} failed`).trim() };
}

/** A valid new branch name (git check-ref-format), or why not. */
export async function checkBranch(dir, name) {
  if (!name.trim()) return "Type a name.";
  const r = await exec("git", ["-C", dir, "check-ref-format", "--branch", name.trim()]).catch(() => ({ code: 1 }));
  if (r.code !== 0) return "Not a valid branch name.";
  const e = await exec("git", ["-C", dir, "rev-parse", "--verify", "--quiet", `refs/heads/${name.trim()}`]).catch(() => ({ code: 1 }));
  return e.code === 0 ? "A branch with this name exists." : null;
}

/** Opens a file in $VISUAL / $EDITOR: a desktop editor (Cursor, VS Code, Zed, Sublime) with the worktree as its
 *  folder; else the system's app (xdg-open / open). Resolves false when the editor is a terminal one, so the
 *  caller opens it in a tab instead. */
export async function openInEditor(dir, file) {
  const script = `e="\${VISUAL:-\${EDITOR:-}}"; set -- "$1" "$2"
case "\${e##*/}" in
  cursor|code|code-insiders|codium|windsurf) "$e" "$1" --goto "$2" >/dev/null 2>&1 & ;;
  zed|subl|subl3) "$e" "$1" "$2" >/dev/null 2>&1 & ;;
  "") if command -v xdg-open >/dev/null; then xdg-open "$2" >/dev/null 2>&1 & else open "$2" & fi ;;
  *) exit 9 ;;
esac`;
  const r = await exec("bash", ["-ic", script, "open", dir, `${dir}/${file}`]).catch(() => ({ code: 1 }));
  return r.code !== 9;
}

async function collect(repo, slots) {
  const { node } = await bins();
  const list = slots.filter((s) => s.active).map((s) => ({ id: s.id, workDir: s.workDir, baseBranch: s.baseBranch }));
  const r = await runTool(node, [`${BIN()}/collect.mjs`, repo, JSON.stringify(list)], { timeout: 20000 });
  return JSON.parse(r.stdout);
}

// PRs change slowly and gh is a network call: refresh at most once a minute per repo.
const prCache = new Map();
async function pullRequests(repo) {
  const c = prCache.get(repo);
  if (c && Date.now() - c.at < 60000) return c.list;
  const { gh } = await bins();
  if (!gh) return null;
  const r = await runTool(gh, ["pr", "list", "--state", "all", "--limit", "100", "--json", "number,state,headRefName,headRefOid,url,title,isDraft,updatedAt"], { cwd: repo, timeout: 20000 }).catch(() => null);
  let list = null;
  try { list = r && r.code === 0 ? JSON.parse(r.stdout) : null; } catch { /* not a GitHub repo */ }
  prCache.set(repo, { at: Date.now(), list });
  return list;
}

// OTel usage lives in Mission Control (it ingests the agents' OTel exports and attributes them to slots).
let mcRepos = { at: 0, list: [] };
async function mcRepoId(repo) {
  if (Date.now() - mcRepos.at > 60000) {
    const r = await fetch(`${MC_URL}/api/repos`);
    const body = await r.json();
    mcRepos = { at: Date.now(), list: Array.isArray(body) ? body : body.repos ?? [] };
  }
  return mcRepos.list.find((x) => x.path === repo || x.harnessRoot === repo)?.id ?? null;
}
const sumUsage = (rows) => rows.reduce((a, u) => {
  a.cost += u.costUsd ?? 0; a.tokens += u.tokensTotal ?? 0; a.input += u.tokensInput ?? 0; a.output += u.tokensOutput ?? 0;
  a.cacheRead += u.tokensCacheRead ?? 0; a.cacheWrite += u.tokensCacheCreation ?? 0; a.sessions += 1;
  if (u.costUsd == null && (u.tokensTotal ?? 0) > 0) a.unpriced = true;
  for (const [m, v] of Object.entries(u.modelBreakdown ?? {})) {
    const x = (a.models[m] ??= { cost: 0, tokens: 0 });
    x.cost += v.costUsd ?? 0; x.tokens += v.tokensTotal ?? 0;
  }
  return a;
}, { cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: 0, models: {}, unpriced: false });
export { sumUsage };

async function usage(repo) {
  try {
    const id = await mcRepoId(repo);
    if (!id) return { error: "not in Mission Control" };
    const body = await (await fetch(`${MC_URL}/api/repos/${id}/usage`)).json();
    const rows = (body.usage ?? []).map((u) => ({
      slot: u.agentId ?? null, workDir: u.workDir ?? null, work: u.workUnitId ?? null, attempt: u.attemptId ?? null, tool: u.agentTool,
      costUsd: u.costUsd, tokensTotal: u.tokensTotal, tokensInput: u.tokensInput, tokensOutput: u.tokensOutput,
      tokensCacheRead: u.tokensCacheRead, tokensCacheCreation: u.tokensCacheCreation, modelBreakdown: u.modelBreakdown, last: u.lastSeenAt,
    }));
    const unassigned = (body.unassigned ?? []).map((u) => ({ ...u, slot: null, work: null, last: u.lastSeenAt }));
    return { id, rows, unassigned, error: null };
  } catch { return { error: "Mission Control is not running (har control up)" }; }
}

async function lines(repo) {
  const r = await har(["line", "status", "--json", "--repo", repo], { cwd: repo }).catch(() => null);
  try { return r && r.code === 0 ? JSON.parse(r.stdout) : []; } catch { return []; }
}

export async function load(repo) {
  const out = { at: Date.now(), error: null, slots: [], runs: [], stages: [], profile: null, remote: null,
    git: {}, workUnits: [], prs: null, usage: { error: "loading" }, lines: [] };
  const [status, runs, stagesText, prs, use, lns] = await Promise.all([
    har(["env", "status", "--json", "--repo", repo], { cwd: repo }),
    har(["env", "runs", "list", "--json", "--limit", "80", "--repo", repo], { cwd: repo }),
    readTextFile(`${repo}/.har/stages.json`).catch(() => null),
    pullRequests(repo).catch(() => null),
    usage(repo),
    lines(repo),
  ]);
  out.prs = prs; out.usage = use; out.lines = Array.isArray(lns) ? lns : [];
  try {
    const d = JSON.parse(status.stdout);
    out.slots = (d.slots ?? []).map(trimSlot);
    out.profile = d.profile ?? null; out.remote = d.gitRemote ?? null;
  } catch { out.error = (status.stderr || status.stdout || "har env status failed").trim().split("\n").slice(-3).join("\n"); }
  try { out.runs = (JSON.parse(runs.stdout).runs ?? []).map(trimRun); } catch { /* runs are optional */ }
  try {
    const reg = JSON.parse(stagesText ?? "{}");
    out.stages = reg.verificationStages ?? [];
    out.stageIds = (reg.stages ?? []).map((s) => s.id);
    out.slotCount = reg.agentSlots ? (Array.isArray(reg.agentSlots) ? reg.agentSlots.length : Object.keys(reg.agentSlots).length) : null;
  } catch { /* keep empty */ }
  try { const x = await collect(repo, out.slots); out.git = x.git ?? {}; out.workUnits = x.workUnits ?? []; } catch { /* optional */ }
  return out;
}

export function store(repo, data) {
  const all = { ...(shared(KEY.snap) ?? {}) };
  all[repo] = data;
  setShared(KEY.snap, all);
}

// ---- herdr <-> HAR joins ------------------------------------------------------
const inside = (cwd, dir) => Boolean(cwd && dir && (cwd === dir || cwd.startsWith(dir + "/")));

// A repo's "· chat" space holds conversations without a slot: never count it as a slot's, even for a slot
// that runs in the repo folder itself (launched with --no-worktree).
const isChat = (name) => / · chat$/.test(name ?? "");

/** Agents (herdr) whose pane lives in this slot's worktree. */
export function slotAgents(slot) {
  if (!slot?.workDir) return [];
  const byPane = new Map(panes().map((p) => [p.pane, p]));
  return agents().filter((a) => !isChat(a.space_name) && inside(byPane.get(a.pane)?.cwd, slot.workDir));
}

/** Agents (herdr) whose pane lives in any of these folders. */
export function slotAgentsIn(dirs) {
  if (!dirs?.length) return [];
  const byPane = new Map(panes().map((p) => [p.pane, p]));
  return agents().filter((a) => !isChat(a.space_name) && dirs.some((d) => inside(byPane.get(a.pane)?.cwd, d)));
}

/** "har-project#2" or "har-project#2 · telemetry-depth" (and not "har-project#20"). */
const namedFor = (repo, slot, name) => {
  const pre = `${base(repo)}#${slot.id}`;
  return name === pre || (name ?? "").startsWith(`${pre} `);
};

/** spaces() and panes() copy the whole window state: read them once and pass this along when looking up many. */
export function spaceIndex() {
  const all = spaces(), ps = panes(), tabSpace = new Map();
  for (const sp of all) for (const t of sp.tabs) tabSpace.set(t.id, sp);
  return { all, ps, tabSpace };
}

/** The herdr space for this slot: the one named after it, else the one with a terminal in its worktree, else
 *  the one made in its worktree. Pass the repo so the name can be matched (slots of different projects share
 *  ids: har-project#1, otel-hook#1). */
export function slotSpace(slot, repo, ix = spaceIndex()) {
  if (!slot) return null;
  if (repo) { const byName = ix.all.find((s) => namedFor(repo, slot, s.name)); if (byName) return byName; }
  if (!slot.workDir) return null;
  for (const p of ix.ps) {
    if (!inside(p.cwd, slot.workDir)) continue;
    const sp = ix.tabSpace.get(p.tab);
    if (sp && !isChat(sp.name)) return sp;
  }
  return ix.all.find((s) => !isChat(s.name) && inside(s.folder, slot.workDir)) ?? null;
}

/** Agents (herdr) in one tab. */
/** Every herdr agent (one read of the window state). */
export const allAgents = () => agents();
export const agentsInTab = (tab) => agents().filter((a) => a.tab === tab);

/** Which project (and slot) each open space belongs to: Map space id → { repo, slot } (slot null for a
 *  "· chat" space). One pass over the window state, for the OPEN SPACES list. */
export function spaceOwners(ix = spaceIndex()) {
  const own = new Map();
  for (const r of repos()) {
    const chat = ix.all.find((sp) => sp.name === chatLabel(r));
    if (chat && !own.has(chat.id)) own.set(chat.id, { repo: r, slot: null });
    for (const s of snapshot(r)?.slots ?? []) {
      if (!s.active) continue;
      const sp = slotSpace(s, r, ix);
      if (sp && !own.has(sp.id)) own.set(sp.id, { repo: r, slot: s });
    }
  }
  return own;
}

export const STATUS_RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
export function worst(list) {
  return list.reduce((acc, a) => ((STATUS_RANK[a.status] ?? 0) > (STATUS_RANK[acc] ?? 0) ? a.status : acc), null);
}

// ---- live verification ------------------------------------------------------
export const verifyTabName = (repo, id) => `verify · ${base(repo)}#${id}`;

/** The terminal of a running/finished `har env verify` tab this panel started. */
export function verifyTerminal(repo, id) {
  const name = verifyTabName(repo, id);
  for (const s of spaces()) for (const t of s.tabs) {
    if (t.name !== name) continue;
    const p = panes().find((p) => p.tab === t.id && p.terminal);
    if (p) return { terminal: p.terminal, tab: t.id, space: s.id };
  }
  return null;
}

// "  → unit-tests...        ✓ (33684ms)"  (no mark yet = running)
const STAGE_LINE = /→\s+([\w:.@/-]+?)\.\.\.\s*(\S)?\s*(?:\((\d+)ms\))?\s*$/;
export async function readLiveVerify(terminal) {
  const r = await hc(["read", terminal, "--lines", "400"]);
  if (r.code !== 0) return null;
  const stages = new Map();
  let full = false;
  for (const raw of r.stdout.split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
    if (/--full/.test(line)) full = true;
    const m = STAGE_LINE.exec(line);
    if (!m) continue;
    const mark = m[2];
    const state = !mark ? "running" : mark === "✓" ? "pass" : /[·⊘-]/.test(mark) ? "skipped" : "fail";
    stages.set(m[1], { name: m[1], state, ms: m[3] ? Number(m[3]) : null });
  }
  const list = [...stages.values()];
  const done = /"total_ms"|Verification (pass|fail)/i.test(r.stdout) || (list.length > 0 && list.every((s) => s.state !== "running") && /\$\s*$/.test(r.stdout.trimEnd()));
  return { stages: list, running: list.some((s) => s.state === "running") && !done, full };
}

// ---- formatting -----------------------------------------------------------------
export function ago(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function dur(ms) {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}s`;
}

/** Latest verify-kind run for a slot (since its session began, when known). */
export function lastVerify(snap, slot) {
  if (!snap) return null;
  const since = slot?.since ? new Date(slot.since).getTime() : 0;
  return snap.runs.find((r) => r.kind === "verify" && r.slot === slot.id && r.stages && new Date(r.at).getTime() >= since) ?? null;
}

/** Opens a URL with the desktop's handler. */
const systemOpen = (url) => exec("xdg-open", [url]).catch(() => exec("open", [url]));

// herdr-web-browser (https://github.com/MattJColes/herdr-web-browser): pages open in a pane beside
// the focused one instead of the system browser. Its CLI calls `herdr-app`, which lives in
// ~/.local/bin — not on herdr's own PATH — so run it with that folder prepended.
const BROWSER = () => `${home()}/.local/bin/herdr-web-browser`;
let browserOk = null;
export async function hasBrowser() {
  if (browserOk === null) browserOk = (await exec("test", ["-x", BROWSER()]).catch(() => null))?.code === 0;
  return browserOk;
}
export const browserInstalled = () => browserOk;

/** Opens a URL in the default system browser, whatever Settings → Links says. */
export const openSystemUrl = (url) => systemOpen(url);

/** Opens a URL in the herdr browser (Settings → Links), else the system browser. */
export async function openUrl(url) {
  if (setting("links") !== "system" && (await hasBrowser())) {
    const owner = focused()?.terminal;
    const r = await exec("sh", ["-c", 'PATH="$HOME/.local/bin:$PATH"; exec "$@"', "sh", BROWSER(), ...(owner ? ["--owner", owner] : []), "open", url, "--show"],
      { timeout: 30000 }).catch(() => null);
    if (r?.code === 0) return r;
  }
  return systemOpen(url);
}

// ---- spacing --------------------------------------------------------------------------
/** Gaps and corners of the work area, written into layouts/har.json (herdr applies it live). */
export const SPACING = {
  none: { padding: 0, gap: 0, paneGap: 0, radius: 0, divider: true },
  compact: { padding: 4, gap: 4, paneGap: 4, radius: 6, divider: false },
  comfortable: { padding: 8, gap: 8, paneGap: 8, radius: 10, divider: false },
};
export const spacing = () => SPACING[setting("spacing")] ?? SPACING.none;

function findNode(n, id) {
  if (!n || typeof n !== "object") return null;
  if (n.id === id) return n;
  for (const c of n.children ?? []) { const f = findNode(c, id); if (f) return f; }
  return null;
}

/** Rewrites the HAR layout's spacing when it differs from the setting. Resolves true when it wrote. */
export async function applySpacing() {
  const path = `${appHome()}/layouts/har.json`;
  const text = await readTextFile(path).catch(() => null);
  if (!text) return false;
  let L;
  try { L = JSON.parse(text); } catch { return false; }
  const s = spacing();
  const body = findNode(L, "work-body"), main = findNode(L, "main");
  if (!body || !main?.content?.pane) return false;
  const pane = main.content.pane;
  const want = { padding: s.padding, gap: s.gap, paneGap: s.paneGap, radius: s.radius, divider: s.divider };
  const have = { padding: body.padding ?? 0, gap: body.gap ?? 0, paneGap: pane.gap ?? 0, radius: pane.radius ?? 0, divider: Boolean(body.divider) };
  if (JSON.stringify(want) === JSON.stringify(have)) return false;
  body.padding = s.padding; body.gap = s.gap; pane.gap = s.paneGap; pane.radius = s.radius;
  if (s.divider) body.divider = { width: 1, color: "border" }; else delete body.divider;
  await writeTextFile(path, JSON.stringify(L, null, 2) + "\n", text);
  return true;
}

/** Finds this harness in Mission Control and opens the slot page (or MC's home). */
export async function openMissionControl(repo, slotId) {
  try {
    const r = await fetch(`${MC_URL}/api/repos`);
    const body = await r.json();
    const list = Array.isArray(body) ? body : body.repos ?? body.repositories ?? [];
    const hit = list.find((x) => x.path === repo || x.harnessRoot === repo || x.repoPath === repo);
    if (hit) return openUrl(`${MC_URL}/repos/${hit.id}${slotId != null ? `/slots/${slotId}` : ""}`);
  } catch { /* MC not running: fall through */ }
  return openUrl(MC_URL);
}

/** Harnesses registered with HAR on this machine that still exist. */
export async function knownRepos() {
  let list = [];
  try { list = JSON.parse(await readTextFile(`${home()}/.har/repos.json`)).repos ?? []; } catch { return []; }
  const ok = await exec("sh", ["-c", 'for d in "$@"; do [ -f "$d/.har/stages.json" ] && echo "$d"; done', "sh", ...list]).catch(() => null);
  return (ok?.stdout ?? "").split("\n").filter(Boolean);
}

// ---- project discovery -----------------------------------------------------------
/** Every harness HAR knows on this machine (~/.har/repos.json) plus .har/ folders found under ~. */
export async function discoverRepos() {
  const found = new Set();
  try { for (const r of JSON.parse(await readTextFile(`${home()}/.har/repos.json`)).repos ?? []) found.add(r); } catch { /* none */ }
  const r = await exec("sh", ["-c",
    `find "$HOME" -maxdepth 5 \\( -name node_modules -o -name .git -o -name worktrees -o -name .cache -o -name .local -o -name .npm -o -name .har-fixtures -o -name agentbench-work \\) -prune -o -path '*/.har/stages.json' -print 2>/dev/null`],
    { timeout: 20000 }).catch(() => null);
  for (const l of (r?.stdout ?? "").split("\n")) if (l.endsWith("/.har/stages.json")) found.add(l.slice(0, -"/.har/stages.json".length));
  const ok = await exec("sh", ["-c", 'for d in "$@"; do [ -f "$d/.har/stages.json" ] && echo "$d"; done', "sh", ...found]).catch(() => null);
  return (ok?.stdout ?? "").split("\n").filter(Boolean).sort((a, b) => base(a).localeCompare(base(b)));
}

/** A cheap per-project summary (slots in use, failing, stale) for the project list. */
export async function summarize(repo) {
  const r = await har(["env", "status", "--json", "--repo", repo], { cwd: repo }).catch(() => null);
  try {
    const slots = JSON.parse(r.stdout).slots ?? [];
    const active = slots.filter((s) => s.active);
    return { at: Date.now(), total: slots.length, active: active.length, fail: active.filter((s) => s.lastVerifyStatus === "fail").length,
      stale: active.filter((s) => s.stale).length, dirty: active.filter((s) => s.dirty).length, workDirs: active.map((s) => s.workDir) };
  } catch { return { at: Date.now(), error: true }; }
}
export const summaries = () => shared("har.summaries") ?? {};
export function storeSummary(repo, s) { setShared("har.summaries", { ...summaries(), [repo]: s }); }

// ---- per-slot facts -----------------------------------------------------------------
export function slotUsage(snap, slot) {
  const rows = snap?.usage?.rows ?? [];
  return sumUsage(rows.filter((u) => (slot.attempt && u.attempt === slot.attempt) || (slot.workDir && u.workDir === slot.workDir)));
}
export function workUsage(snap, work) { return sumUsage((snap?.usage?.rows ?? []).filter((u) => u.work === work)); }
export function repoUsage(snap) {
  const u = snap?.usage ?? {};
  return { attributed: sumUsage(u.rows ?? []), unattributed: sumUsage(u.unassigned ?? []), all: sumUsage([...(u.rows ?? []), ...(u.unassigned ?? [])]) };
}

export function slotPR(snap, slot) {
  const g = snap?.git?.[slot.id];
  if (!slot.active || (slot.ahead ?? 0) === 0) return null;   // fresh slot: HEAD is the base commit, no PR is its own
  const prs = snap?.prs ?? [];
  const names = new Set([slot.branch, ...(g?.remotes ?? []).map((r) => r.replace(/^[^/]+\//, ""))].filter(Boolean));
  const hits = prs.filter((p) => names.has(p.headRefName) || (g?.head && p.headRefOid === g.head));
  return hits.find((p) => p.state === "OPEN") ?? hits[0] ?? null;
}

/**
 * Everything someone needs to decide whether a slot can be freed.
 * verdict: "free" (nothing to lose), "safe" (work landed), "caution" (pushed, not landed), "keep" (would lose work / in use).
 */
export function slotFacts(snap, slot) {
  const g = snap?.git?.[slot.id] ?? null;
  const pr = slotPR(snap, slot);
  const agents = slotAgents(slot);
  const busy = agents.filter((a) => a.status === "working" || a.status === "blocked");
  const dirty = Boolean(slot.dirty) || (g?.changed ?? 0) > 0;
  const unpushed = g?.unpushed ?? null;
  const pushed = (slot.ahead ?? 0) > 0 && (g?.remotes?.length ?? 0) > 0;
  const landed = pr?.state === "MERGED" || (g?.merged && (slot.ahead ?? 0) > 0);
  const reasons = [];
  let verdict;
  if (!slot.active) verdict = "free";
  else if (busy.length) { verdict = "keep"; reasons.push(`${busy.length} agent${busy.length > 1 ? "s" : ""} ${busy[0].status}`); }
  else if (dirty) { verdict = "keep"; reasons.push(`${g?.changed ?? "some"} uncommitted change${g?.changed === 1 ? "" : "s"}`); }
  else if (unpushed > 0) { verdict = "keep"; reasons.push(`${unpushed} unpushed commit${unpushed > 1 ? "s" : ""}`); }
  else if (landed) { verdict = "safe"; reasons.push(pr?.state === "MERGED" ? `PR #${pr.number} merged` : `merged into ${slot.baseBranch ?? "base"}`); }
  else if ((slot.ahead ?? 0) === 0) { verdict = "safe"; reasons.push("no commits yet"); }
  else if (pr?.state === "CLOSED") { verdict = "safe"; reasons.push(`PR #${pr.number} closed`); }
  else { verdict = "caution"; reasons.push(pr ? `PR #${pr.number} ${pr.isDraft ? "draft" : "open"}` : pushed ? "pushed, no PR" : "commits not landed"); }
  return { git: g, pr, agents, busy, dirty, unpushed, pushed, landed, verdict, reasons, usage: slotUsage(snap, slot) };
}

export function money(v) {
  if (v == null) return "—";
  if (v === 0) return "$0";
  if (v < 0.01) return "<$0.01";
  return v < 100 ? `$${v.toFixed(2)}` : `$${Math.round(v).toLocaleString()}`;
}
export function tokens(n) {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
  return `${(n / 1e9).toFixed(1)}B`;
}

// ---- names --------------------------------------------------------------------------------
/** "har-project#2 · telemetry-depth": how spaces for a slot are named. */
export const slotLabel = (repo, slot) => `${base(repo)}#${slot.id}${slot.work ? ` · ${slot.work}` : ""}`;

/** Renames herdr spaces (and their unnamed tabs) after the slot they work in (Settings → Names).
 *  A space someone renamed to something else is left alone. */
export function syncNames(repo, snap) {
  if (setting("nameSpaces") === false || !snap) return;
  for (const s of snap.slots) {
    if (!s.active) continue;
    const sp = slotSpace(s, repo);
    if (!sp) continue;
    const want = slotLabel(repo, s);
    const ours = !sp.named || sp.name.startsWith(`${base(repo)}#${s.id}`);
    if (ours && sp.name !== want) run("space.rename", { id: sp.id, name: want });
    if (!s.work) continue;
    const inSlot = new Set(panes().filter((p) => inside(p.cwd, s.workDir)).map((p) => p.tab));
    for (const t of sp.tabs ?? []) {
      if (!t.named && inSlot.has(t.id)) run("tab.rename", { id: t.id, name: `#${s.id} · ${s.work}` });
    }
  }
}

// ---- hints ----------------------------------------------------------------------------------
/**
 * What to do next with a slot, from its facts: [{ text, level: "info"|"warn"|"done", action? }].
 * action is one of "free", "verify-full", "push", "push-pr", "agent", "focus".
 */
export function hints(snap, slot) {
  if (!slot?.active) return [];
  const f = slotFacts(snap, slot);
  const last = lastVerify(snap, slot);
  const out = [];
  const idleDays = slot.since ? (Date.now() - new Date(slot.since).getTime()) / 86400000 : 0;
  const blocked = f.agents.find((a) => a.status === "blocked");
  if (blocked) out.push({ text: "An agent in this slot is waiting for you.", level: "warn", action: "focus", agent: blocked.address });
  if (f.pr?.state === "MERGED" && !f.dirty && !f.unpushed) out.push({ text: `PR #${f.pr.number} is merged — this slot can be freed.`, level: "done", action: "free" });
  else if ((slot.ahead ?? 0) === 0 && !f.dirty && !f.agents.length && idleDays > 1) out.push({ text: `No commits in ${Math.floor(idleDays)} days and no agent open — free it?`, level: "info", action: "free" });
  if (f.unpushed > 0 && !f.pr) out.push({ text: `${f.unpushed} commit${f.unpushed > 1 ? "s" : ""} not pushed and no PR yet.`, level: "warn", action: "push-pr" });
  else if (f.unpushed > 0 && f.pr?.state === "OPEN") out.push({ text: `${f.unpushed} commit${f.unpushed > 1 ? "s" : ""} not pushed to PR #${f.pr.number}.`, level: "warn", action: "push" });
  if (f.dirty && !f.agents.length) out.push({ text: "Uncommitted changes and no agent open.", level: "warn", action: "agent" });
  if ((slot.ahead ?? 0) > 0 && f.pr?.state !== "MERGED" && (!last || last.status !== "pass" || !last.full))
    out.push({ text: last ? `Last verify ${last.full ? "--full " : ""}${last.status} — run verify --full before completing.` : "Never verified — run verify --full before completing.", level: "info", action: "verify-full" });
  if (slot.stale && f.pr?.state !== "MERGED") out.push({ text: `${slot.behind} commits behind ${slot.baseBranch ?? "base"} — rebase before opening or updating the PR.`, level: "info" });
  if (slot.usage === "bypass_warning") out.push({ text: "Changes were made outside the harness (har reports a bypass).", level: "info" });
  return out;
}

/** Slots that can be freed with nothing to lose: work merged, or nothing committed, clean, no agent. */
export function freeable(snap) {
  return (snap?.slots ?? []).filter((s) => s.active).filter((s) => {
    const f = slotFacts(snap, s);
    return f.verdict === "safe" && !f.dirty && !f.unpushed && !f.busy.length;
  });
}
