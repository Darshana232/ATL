# Phase 0 — Repository & Decisions

**Status:** DONE · **Started:** 2026-09-04 · **Finished:** 2026-09-04

---

## 1. What we are building

A git repository and a decision log. No application code. The output is a place
to put code, plus the habit of recording *why* each choice was made at the
moment it was made.

## 2. Why now

Two reasons, and the second is the real one.

The mechanical reason: `.gitignore` must exist **before** the first commit. Git
stores history permanently, so a secret committed in commit #3 is in the
repository forever. Deleting the file in commit #4 does nothing — the blob is
still reachable. The only real remedy is to rotate the key and, if it is public,
assume it is compromised.

The important reason: **decision rationale decays fast**. A week from now I will
remember choosing npm over pnpm but not that `corepack` failed with `EACCES` on
a root-owned `/usr/local/bin`, and so I will not be able to tell whether the
decision still holds. Reconstructed rationale is always worse than recorded
rationale and is often simply wrong.

## 3. How it works

Git stores **snapshots**, not diffs, addressed by the SHA-1/SHA-256 of their
content. A commit points to a tree (the file layout), to its parent commit, and
carries a message. The chain of commits is the history.

Notice the shape: **content-addressed records, each pointing at its
predecessor.** That is a hash chain. Git is a hash chain, which means Phase 6's
audit trail is the same idea I am already using every time I commit. Changing an
old commit changes its hash, which changes every child's hash — exactly why
`git rebase` rewrites history rather than editing it in place.

```
cb1ce09 ──► c87e6b0 ──► 0d4e40b ──► f63f6ed ──► ... ──► HEAD (main)
  each commit stores its parent's hash
```

## 4. Concepts I need first

**Repository, staging area, commit.** The working tree is your files. `git add`
moves a snapshot into the staging area. `git commit` freezes the staged snapshot
into history. The staging area exists so you can commit *part* of your work — a
smaller, more coherent change than "everything I did today".

**Atomic commits.** One logical change per commit. This is not tidiness; it is
what makes `git bisect` able to find the commit that broke something, and
`git revert` able to undo one change without undoing four others.

**Commit messages are for the future.** The diff already shows *what* changed.
The message must explain *why*, because in six months the reasoning is
unrecoverable and the diff is not. `fix bug` is worthless; "pool 'error'
handler added: an unhandled 'error' event on an idle client terminates the Node
process" is worth reading.

**`.gitignore`.** Patterns git refuses to track. `git check-ignore -v <file>`
proves a file is ignored and names the rule — an actual check rather than an
assumption.

**Branches.** A branch is a movable pointer to a commit. That is all. This is
why creating one is instant.

## 5. Design choices & tradeoffs

| Choice | Alternative | Why | Cost |
|---|---|---|---|
| One repo for code + research + docs | Separate repos | The reality check and decision log must sit beside the code they constrain; splitting them guarantees drift | Repo carries ~250 KB of markdown |
| `main` as the branch name, stated explicitly | Inherit git's default | Reproducible across machines with different git configs | none |
| Commit `Research/` despite containing errors | Exclude it | Provenance: we need to show what we were told versus what we verified. The reality check names the errors | Someone may read it uncritically — mitigated by a warning in the commit message and in the README |
| Atomic commits from day one | One "initial commit" | `git log` becomes a readable design narrative; bisect works | ~8 commits instead of 1 |
| `docs/DECISIONS.md` as append-only ADRs | Decide in chat, write up later | Rationale recorded while fresh; supersede rather than edit | a few minutes per decision |

## 6. Files created/modified

```
.gitignore                        .env excluded from commit #1
docs/DECISIONS.md                 ADR-0001..0013
docs/RESEARCH_REALITY_CHECK.md    verified / corrected / unverified claims
docs/PROJECT_STATE.md             phase status, so sessions resume
docs/LEARNING_LOG.md              concepts and mistakes per phase
docs/ARCHITECTURE.md              target architecture
docs/EXTERNAL_APIS.md             Tier A-D evaluation of external services
README.md                         honest scope up front
CLAUDE.md  (root)                 imports the protocol + state files
Understanding/                    this folder
```

## 7. How we test it

| Test | Asserts | Failure it prevents |
|---|---|---|
| `git check-ignore -v .env` | `.env` matched by `.gitignore:19` | committing a secret |
| `git log --diff-filter=A --name-only \| grep -x '.env'` | `.env` never added in any commit | a secret already in history |
| grep the live voucher secret across `git log --all -p` | the value appears in no commit | the specific secret we generated leaking |
| `git status --short` empty | nothing untracked or uncommitted | forgetting a file, then a broken clone |
| `git ls-files \| grep .claude` | machine-local settings untracked | committing another machine's config |

All five ran. `.env` was never committed and the live secret appears nowhere in
history.

## 8. Security notes

**Threat:** a secret enters git history.
**Vulnerability:** git history is permanent and, once pushed, distributed. `git
rm` in a later commit does not remove the blob.
**Mitigation:** `.gitignore` before commit #1, `.env` at mode `600`, a committed
`.env.example` carrying only the *shape*, and an explicit history scan.
**Why this mitigation:** it is preventive rather than corrective. The corrective
options (`filter-repo`, BFG) rewrite every subsequent commit hash and still
cannot un-leak a pushed value. Prevention is the only real control; everything
after is damage limitation.

**Threat:** committing machine-local configuration.
**Mitigation:** `.claude/settings.local.json` ignored; a shared
`.claude/settings.json` would be committed. The `.local` naming convention
carries the meaning.

## 9. What happens at scale

Git itself is unaffected by our scale. What changes with *team* size:

- **10 merchants / 1 developer** — direct commits to `main` are fine.
- **A team** — branch per change, pull requests, review before merge, CI gating.
  The atomic-commit habit starts paying off here: reviewers can follow one
  change at a time.
- **A regulated production system** — signed commits, protected branches,
  mandatory review, and an auditable link from a deployed artifact back to the
  commit that produced it. That last one is a compliance requirement, not a
  nicety: "which code made this decision?" must be answerable.

## 10. What I learned

- Git is a **hash chain of content-addressed snapshots**, which is the same
  primitive as the Phase 6 audit trail. Building the audit chain later is
  formalising something I already use daily.
- A commit message is written for the person debugging this in six months, and
  that person has the diff already — so the message owes them the *reasoning*.
- The staging area exists to let you commit a *subset* of your work. That is
  what makes atomic commits possible at all.
- `git check-ignore -v` **proves** a file is ignored. Assuming is not checking —
  the same lesson as an empty command output not meaning "passed".
- Recording decisions costs about two minutes and saves an argument with
  yourself later.

## 11. Mistakes made & why

**Almost committed `.claude/settings.local.json`.** It appeared in `git status`
and my first instinct was `git add .`. *Why it happened:* `git add .` is muscle
memory and it does not distinguish between what you wrote and what a tool
dropped in your directory. *Lesson:* read `git status` before staging, and
prefer naming paths explicitly over `.`.

**Wrote `docs/` before `Understanding/`.** They overlap, and I had to decide
after the fact which folder owns what. *Why:* I wrote documentation as an
output rather than deciding its audience first. *Lesson:* documentation has
readers; decide who they are before writing. `docs/` = operate and extend;
`Understanding/` = learn and explain. That split is now stated in
`Understanding/00_README.md` so it stops being ambiguous.

## 12. Open questions / debt

- No CI yet, so nothing enforces "tests pass before commit" except me.
  Deliberate — CI without a test suite is theatre. Arrives in Phase 12.
- No signed commits. Correct for a solo student project; would be required in a
  regulated environment.
- No pull-request workflow yet. Worth introducing artificially around Phase 4 so
  the habit exists before it is needed.
