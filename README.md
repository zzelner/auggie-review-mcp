# auggie-review-mcp

On-demand code review via the [Auggie CLI](https://docs.augmentcode.com/cli/overview) through the [Model Context Protocol](https://modelcontextprotocol.io) — **no PR required**.

## Why

Augment's GitHub App only triggers code reviews on pull requests. This MCP server lets you run AI-powered code reviews at any point in your development cycle — from any MCP client (Claude Code, Cursor, Cline, Windsurf, etc.).

**Key features:**
- Review uncommitted changes, branches, specific files, or remote PRs
- 6 built-in review types (general, security, migration, api, typescript, component)
- Define custom review types for your project via `.auggie-review.json`
- Pre-PR quality gate with structured PASS/FAIL verdicts
- Agentic delegation — auggie discovers and analyzes files itself (no context window limits)

## Prerequisites

```bash
npm install -g @augmentcode/auggie
auggie login
```

**Note:** The MCP server runs on Node.js 18+. The auggie CLI requires Node.js 22+.

## Quick Start

### Option 1: npx (no install)

Add to your MCP client config:

```json
{
  "mcpServers": {
    "auggie-review": {
      "command": "npx",
      "args": ["-y", "auggie-review-mcp"],
      "env": {
        "WORKSPACE_ROOT": "/path/to/your/repo"
      }
    }
  }
}
```

### Option 2: Global install

```bash
npm install -g auggie-review-mcp
```

```json
{
  "mcpServers": {
    "auggie-review": {
      "command": "auggie-review-mcp",
      "env": {
        "WORKSPACE_ROOT": "/path/to/your/repo"
      }
    }
  }
}
```

### Option 3: Clone and build

```bash
git clone https://github.com/zzelner/auggie-review-mcp.git
cd auggie-review-mcp
npm install
npm run build
```

```json
{
  "mcpServers": {
    "auggie-review": {
      "command": "node",
      "args": ["/path/to/auggie-review-mcp/dist/index.js"],
      "env": {
        "WORKSPACE_ROOT": "/path/to/your/repo"
      }
    }
  }
}
```

## Tools

| Tool | Description | Use When |
|------|-------------|----------|
| `review_branch_ref` | Review any branch or PR (primary tool) | Reviewing a PR or feature branch |
| `review_diff` | Review uncommitted/staged changes | Before committing |
| `review_branch` | Review current branch vs base | Before creating a PR |
| `review_files` | Review specific files (full contents) | Targeted file review |
| `review_pr_ready` | Comprehensive pre-PR quality gate | Final check before PR |
| `check_auth` | Verify auggie is installed and authenticated | Troubleshooting setup |

### `review_branch_ref` — The Primary Tool

This is the most powerful tool. Instead of stuffing a diff into the prompt, it delegates to auggie as an agentic task — auggie discovers changed files, reads code, and analyzes everything using its own tools. This means it works on PRs of any size without hitting context window limits.

```
review_branch_ref({
  branch: "feature/add-auth",
  base: "main",
  review_type: "security"
})
```

### `review_diff` — Review Uncommitted Changes

```
review_diff({
  diff_source: "staged",
  review_type: "general"
})
```

### `review_branch` — Review Current Branch

```
review_branch({
  base: "main",
  review_type: "typescript"
})
```

### `review_files` — Review Specific Files

```
review_files({
  paths: ["src/auth/login.ts", "src/api/users.ts"],
  review_type: "security"
})
```

Supports reviewing files from any git ref without checking it out:

```
review_files({
  paths: ["src/auth/login.ts"],
  git_ref: "origin/feature-branch",
  review_type: "security"
})
```

### `review_pr_ready` — Pre-PR Quality Gate

```
review_pr_ready({
  base: "main",
  files_filter: "src/**/*.ts",
  custom_instructions: "Focus on authentication changes"
})
```

Returns a structured report with a **PASS / PASS WITH COMMENTS / FAIL** verdict.

## Review Types

| Type | Focus |
|------|-------|
| `general` | Bugs, security basics, code quality, error handling |
| `security` | Auth, injection, secrets, access control |
| `migration` | Database safety, rollback, indexes, data integrity |
| `api` | Endpoint patterns, validation, error responses |
| `typescript` | Type safety, `any` avoidance, strict mode |
| `component` | React, accessibility, responsive design |

All tools accept a `custom_instructions` parameter for additional context:

```
review_branch_ref({
  branch: "feature/payments",
  review_type: "security",
  custom_instructions: "This PR integrates Stripe webhooks — pay special attention to signature verification"
})
```

## Custom Review Types

Create a `.auggie-review.json` in your repository root to customize or add review types:

```json
{
  "review_types": {
    "general": "Your custom general review prompt...",
    "django": "You are a Django specialist. Check for...",
    "graphql": "Review this GraphQL schema and resolvers for..."
  },
  "settings": {
    "timeout_ms": 600000,
    "max_diff_bytes": 200000,
    "auggie_bin": "/usr/local/bin/auggie"
  }
}
```

- **Config is read once at startup** — restart your MCP client after editing `.auggie-review.json`
- **Override built-in types** by using the same key (`general`, `security`, etc.)
- **Add custom types** by using any new key (`django`, `graphql`, `rust`, etc.)
- Built-in defaults are used for any type not specified in your config

See [`examples/outersignal-platform.json`](examples/outersignal-platform.json) for a real-world configuration from a multi-tenant SaaS platform.

## Architecture

```
MCP Client (Claude Code, Cursor, Cline, etc.)
       |
       v
+-----------------------------+
|  auggie-review-mcp (stdio)  |
|                             |
|  Config-driven prompts      |
|  Git diff / file helpers    |
|  Subprocess management      |
+-----------------------------+
       |
       v  spawn("auggie --print --quiet ...")
   auggie CLI
       |
       v
   Augment AI Engine
```

Two review patterns:

1. **Diff-stuffing** (`review_diff`, `review_branch`, `review_files`, `review_pr_ready`): The MCP server gathers git diffs or file contents and passes them to auggie along with the review prompt.

2. **Agentic delegation** (`review_branch_ref`): The MCP server gives auggie a short task instruction ("review branch X vs Y"). Auggie uses its own tools to fetch the diff, read files, and analyze code. This avoids context window limits on large PRs.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WORKSPACE_ROOT` | Yes | — | Repository root path |
| `AUGGIE_BIN` | No | `auggie` | Path to auggie binary |

`AUGGIE_BIN` can also be set via `.auggie-review.json` settings (`settings.auggie_bin`). `WORKSPACE_ROOT` must always be set as an environment variable.

## Timing Expectations

| Operation | Typical Duration |
|-----------|-----------------|
| `check_auth` | ~5 seconds |
| `review_files` (1-3 files) | 30-60 seconds |
| `review_diff` (small changes) | 1-2 minutes |
| `review_branch_ref` (small PR) | 2-4 minutes |
| `review_branch_ref` (large PR, 20+ files) | 5-8 minutes |
| Default timeout | 15 minutes |

## Troubleshooting

**"auggie: command not found"**
Install the CLI: `npm install -g @augmentcode/auggie` (requires Node.js 22+)

**"Authentication: FAILED"**
Re-authenticate: `auggie login`. Sessions expire periodically.

**"WORKSPACE_ROOT environment variable is required"**
Add `WORKSPACE_ROOT` to your MCP server config's `env` block pointing to your repo root.

**"Path outside workspace"**
File paths in `review_files` must be relative to the workspace root. Don't use absolute paths or `../`.

**Diff size warning**
The default limit is 100KB. Use `files_filter` to narrow scope, or increase `max_diff_bytes` in `.auggie-review.json`.

**Timeout errors on large PRs**
Use `review_branch_ref` instead of `review_branch` — it delegates to auggie agentically and avoids context window limits. You can also increase `timeout_ms` in `.auggie-review.json`.

**Reviews don't reflect config changes**
Config is read once at startup. Restart your MCP client after editing `.auggie-review.json`.

## Development

```bash
git clone https://github.com/zzelner/auggie-review-mcp.git
cd auggie-review-mcp
npm install
npm run dev    # Watch mode — recompiles on save
```

After making changes, restart your MCP client to pick up the new build.

## License

MIT
