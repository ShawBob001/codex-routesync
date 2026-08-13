# Community Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add repository-specific community guidance and verify GitHub's Community Profile health score.

**Architecture:** Keep community files under `.github/`, route sensitive reports privately, and use structured forms for public participation. Add CI and dependency automation, plus a factual long-term maintenance statement.

**Tech Stack:** Markdown, GitHub Issue Forms YAML, GitHub Actions, Dependabot, npm workspaces, GitHub APIs.

---

### Task 1: Add policies and contribution guidance

- [ ] Add `SECURITY.md`, `CONTRIBUTING.md`, and the Contributor Covenant.
- [ ] Document the real repository commands, credential boundaries, and reporting routes.

### Task 2: Add structured contribution templates

- [ ] Add bug, feature, and question forms plus issue chooser configuration.
- [ ] Add a pull request template covering tests, docs, security, and compatibility.

### Task 3: Add maintenance automation and positioning

- [ ] Add CI and weekly dependency update configuration.
- [ ] Add a factual long-term maintenance commitment and roadmap.

### Task 4: Verify and publish

- [ ] Parse YAML, scan placeholders, and run `npm run verify`.
- [ ] Enable private vulnerability reporting and security updates.
- [ ] Push to `main` and verify GitHub's measured Community Profile.
