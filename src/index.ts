#!/usr/bin/env node

/**
 * Auggie Review MCP Server
 *
 * On-demand code review via the Auggie CLI — no PR required.
 *
 * Wraps `auggie --print --quiet` to perform structured code reviews
 * using Augment's AI engine against local diffs, branches, or files.
 *
 * Review prompts are customizable via `.auggie-review.json` in your
 * repository root. Built-in defaults work for any codebase.
 *
 * Tools:
 * 1. review_diff       - Review uncommitted/staged changes
 * 2. review_branch     - Review all changes on current branch vs base
 * 3. review_files      - Review specific files for quality and security
 * 4. review_pr_ready   - Full pre-PR review with structured output
 * 5. review_branch_ref - Review a remote branch (for PRs) — auto-discovers changed files
 * 6. check_auth        - Verify auggie CLI is installed and authenticated
 *
 * Usage:
 *   Register in Claude Code settings, Cursor, or any MCP client:
 *   {
 *     "auggie-review": {
 *       "command": "npx",
 *       "args": ["auggie-review-mcp"],
 *       "env": { "WORKSPACE_ROOT": "/path/to/repo" }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { resolve as resolvePath } from 'path';
import { z } from 'zod';

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_TIMEOUT_MS = 900_000; // 15 minutes
const DEFAULT_MAX_DIFF_BYTES = 100_000; // ~100KB diff limit before warning
const MAX_BUFFER_BYTES = 50 * 1024 * 1024; // 50MB max stdout/stderr accumulation
const AUGGIE_BIN = process.env.AUGGIE_BIN || 'auggie';

function getWorkspaceRoot(): string {
  const root = process.env.WORKSPACE_ROOT;
  if (!root) {
    throw new Error(
      'WORKSPACE_ROOT environment variable is required. ' +
        'Set it to the repository root path.',
    );
  }
  return root;
}

// ============================================================================
// User Configuration (.auggie-review.json)
// ============================================================================

interface AuggieReviewConfig {
  /** Custom or overridden review type prompts. Merged over built-in defaults. */
  review_types?: Record<string, string>;
  /** Settings overrides */
  settings?: {
    /** Subprocess timeout in milliseconds (default: 900000 = 15 min) */
    timeout_ms?: number;
    /** Max diff size in bytes before warning (default: 100000) */
    max_diff_bytes?: number;
    /** Path to auggie binary (default: "auggie") */
    auggie_bin?: string;
  };
}

const ConfigSchema = z.object({
  review_types: z.record(z.string(), z.string()).optional(),
  settings: z
    .object({
      timeout_ms: z.number().positive().optional(),
      max_diff_bytes: z.number().positive().optional(),
      auggie_bin: z.string().optional(),
    })
    .optional(),
});

let cachedConfig: AuggieReviewConfig | null = null;

async function loadConfig(workspaceRoot: string): Promise<AuggieReviewConfig> {
  if (cachedConfig) return cachedConfig;

  const configPath = resolvePath(workspaceRoot, '.auggie-review.json');
  try {
    const raw = await readFile(configPath, 'utf-8');
    const parsed = ConfigSchema.safeParse(JSON.parse(raw));
    cachedConfig = parsed.success ? parsed.data : {};
    return cachedConfig;
  } catch {
    cachedConfig = {};
    return cachedConfig;
  }
}

function getTimeoutMs(config: AuggieReviewConfig): number {
  return config.settings?.timeout_ms ?? DEFAULT_TIMEOUT_MS;
}

function getMaxDiffBytes(config: AuggieReviewConfig): number {
  return config.settings?.max_diff_bytes ?? DEFAULT_MAX_DIFF_BYTES;
}

function getAuggieBin(config: AuggieReviewConfig): string {
  return config.settings?.auggie_bin ?? AUGGIE_BIN;
}

// ============================================================================
// Default Review Prompts (generic — work for any codebase)
// ============================================================================

const DEFAULT_REVIEW_TYPES = [
  'general',
  'security',
  'migration',
  'api',
  'typescript',
  'component',
] as const;

type DefaultReviewType = (typeof DEFAULT_REVIEW_TYPES)[number];

function isDefaultReviewType(value: string): value is DefaultReviewType {
  return (DEFAULT_REVIEW_TYPES as readonly string[]).includes(value);
}

const DEFAULT_PROMPTS: Record<DefaultReviewType, string> = {
  general: `You are a senior software engineer performing a code review.

Review the provided code for:

## CRITICAL (blocks merge)
- Security: authentication and authorization checks present where needed
- No hardcoded secrets, API keys, or credentials
- SQL injection, XSS, or command injection vulnerabilities
- Data access not properly scoped (missing tenant/user filtering if applicable)

## HIGH (should fix)
- Input validation on user-provided data
- Error handling on async operations (uncaught promise rejections, missing try-catch)
- Unused variables, imports, or dead code
- Functions exceeding 50 lines (consider splitting)
- Missing null/undefined checks on optional values

## MEDIUM (consider)
- Code duplication that could be extracted
- Performance concerns (N+1 queries, missing pagination, unbounded loops)
- Naming clarity (variables, functions, types)
- Missing or misleading comments on complex logic

Format each finding as:
**[SEVERITY]** file:line — description

End with a summary: X critical, Y high, Z medium findings.`,

  security: `You are a security specialist auditing code for vulnerabilities.

## Authentication & Authorization
- All protected endpoints check authentication before processing
- Authorization verified — users can only access their own resources
- No auth bypass patterns (early returns before auth check)
- Session/token validation present

## Injection & Input Handling
- All user input validated and sanitized
- SQL queries use parameterized statements (no string concatenation)
- No command injection vectors (user input in shell commands)
- XSS prevention (output encoding/sanitization)
- Path traversal prevention on file operations

## Secrets & Credentials
- No hardcoded secrets, API keys, tokens, or passwords
- Secrets loaded from environment variables or secret managers
- No sensitive data in logs, error messages, or client responses
- .env files excluded from version control

## Data Access
- Queries scoped to the authenticated user/tenant
- No mass assignment vulnerabilities
- Sensitive fields excluded from API responses

Format each finding as:
**[CRITICAL|HIGH|MEDIUM]** file:line — description
Include a remediation suggestion for each finding.`,

  migration: `You are a database migration specialist reviewing SQL migrations.

Check for:

## CRITICAL
- Destructive operations (DROP TABLE, DROP COLUMN) have a rollback strategy
- Data migrations handle NULL values and edge cases
- No breaking changes to columns actively read by the application
- Locks considered — will this block reads/writes on large tables?

## HIGH
- Indexes on frequently queried columns
- NOT NULL constraints on required fields
- Foreign key constraints where referential integrity matters
- Data types match existing conventions in the schema
- Default values specified for new NOT NULL columns on existing tables

## MEDIUM
- Migration is idempotent where possible (IF NOT EXISTS, IF EXISTS)
- Column and table naming follows project conventions
- Comments on complex constraints or triggers
- Estimated impact on table size / query plans

Format findings as:
**[SEVERITY]** line — description`,

  api: `You are an API endpoint specialist reviewing HTTP route handlers.

Check for:

## CRITICAL
- Authentication check present before any data access
- Input validation on all parameters (path, query, body)
- Authorization — user can only access their own resources
- No mass assignment (allowlisting fields, not blocklisting)

## HIGH
- Consistent error response format
- Proper HTTP status codes (don't return 200 for errors)
- Request body size limits on upload/POST endpoints
- Rate limiting considerations for public endpoints
- Pagination on list endpoints

## MEDIUM
- Response shape documented or typed
- Consistent naming conventions (camelCase vs snake_case)
- Idempotency considerations for PUT/DELETE operations
- Cache headers where appropriate

Format findings as:
**[SEVERITY]** file:line — description`,

  typescript: `You are a TypeScript type safety specialist reviewing code with strict mode enabled.

Check for:

## CRITICAL
- \`any\` types in production code (use \`unknown\` and narrow)
- Type assertions (\`as\`) without justification — these bypass the type system
- Missing return types on exported/public functions

## HIGH
- Implicit \`any\` from untyped dependencies or missing generics
- Non-exhaustive switch statements on union types (missing \`default\` or case)
- Optional chaining (\`?.\`) masking bugs — should the value actually be required?
- Generic constraints too loose (\`T\` vs \`T extends SomeBase\`)

## MEDIUM
- Interface vs type usage consistency
- Discriminated unions preferred over type guards where applicable
- Enums vs const objects vs union types — appropriate choice for use case
- Re-exported types properly narrowed (not leaking internal types)

Format findings as:
**[SEVERITY]** file:line — description`,

  component: `You are a frontend component specialist reviewing UI code.

Check for:

## CRITICAL
- Accessibility: interactive elements have labels (aria-label, aria-labelledby)
- Accessibility: keyboard navigation works (no mouse-only interactions)
- XSS: user-provided content is sanitized before rendering (no dangerouslySetInnerHTML with user data)

## HIGH
- Loading and error states handled (not just the happy path)
- Forms validate input before submission
- Event handlers cleaned up (useEffect cleanup, removeEventListener)
- Images have alt text
- Focus management on modals/dialogs

## MEDIUM
- Responsive design considered (does it work on mobile viewports?)
- Consistent spacing and styling (design tokens/theme vs hardcoded values)
- Component props well-typed and documented
- Performance: unnecessary re-renders (missing memo, unstable references)
- Semantic HTML (button vs div with onClick, nav vs div)

Format findings as:
**[SEVERITY]** file:line — description`,
};

// ============================================================================
// Prompt Resolution
// ============================================================================

/**
 * Resolve a review type to its prompt string.
 * Priority: user config > built-in defaults > general fallback.
 */
function getReviewPrompt(
  reviewType: string,
  config: AuggieReviewConfig,
): string {
  if (config.review_types?.[reviewType]) {
    return config.review_types[reviewType];
  }
  if (isDefaultReviewType(reviewType)) {
    return DEFAULT_PROMPTS[reviewType];
  }
  return DEFAULT_PROMPTS.general;
}

function buildPrompt(
  reviewType: string,
  config: AuggieReviewConfig,
  customInstructions?: string,
): string {
  const basePrompt = getReviewPrompt(reviewType, config);
  if (customInstructions) {
    return `${basePrompt}\n\nAdditional instructions:\n${customInstructions}`;
  }
  return basePrompt;
}

/**
 * Review type hints for the agentic review_branch_ref tool.
 */
function getReviewHint(
  reviewType: string,
  config: AuggieReviewConfig,
): string {
  if (config.review_types?.[reviewType]) {
    const firstLine = config.review_types[reviewType].split('\n')[0];
    return firstLine.length > 200 ? firstLine.slice(0, 200) + '...' : firstLine;
  }

  const defaultHints: Record<DefaultReviewType, string> = {
    general:
      'Focus on bugs, security issues, code quality, and architecture.',
    security:
      'Focus on authentication, authorization, injection vulnerabilities, and secrets exposure.',
    migration:
      'Focus on database migration safety, rollback strategy, locks, and data integrity.',
    api: 'Focus on API endpoint patterns, auth checks, input validation, and response format.',
    typescript:
      'Focus on type safety, zero any types, explicit return types, and proper typing.',
    component:
      'Focus on component quality, accessibility, error handling, and responsive design.',
  };

  return isDefaultReviewType(reviewType)
    ? defaultHints[reviewType]
    : defaultHints.general;
}

// ============================================================================
// Shell Execution
// ============================================================================

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute a command and return stdout/stderr/exitCode.
 * Uses spawn (not exec) to avoid shell injection and handle large output.
 */
function execCommand(
  cmd: string,
  args: string[],
  options: {
    cwd?: string;
    timeout?: number;
    stdin?: string;
  } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeout || DEFAULT_TIMEOUT_MS;
    const ac = new AbortController();

    const timer = setTimeout(() => {
      ac.abort();
    }, timeoutMs);

    const proc = spawn(cmd, args, {
      cwd: options.cwd,
      shell: false,
      signal: ac.signal,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;

    proc.stdout.on('data', (data: Buffer) => {
      if (truncated) return;
      stdout += data.toString();
      if (stdout.length > MAX_BUFFER_BYTES) {
        truncated = true;
        ac.abort();
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      if (truncated) return;
      stderr += data.toString();
      if (stderr.length > MAX_BUFFER_BYTES) {
        truncated = true;
        ac.abort();
      }
    });

    if (options.stdin) {
      proc.stdin.write(options.stdin);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }

    let settled = false;

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on('error', (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        resolve({
          stdout,
          stderr: `Command timed out after ${timeoutMs}ms`,
          exitCode: 124,
        });
      } else {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

// ============================================================================
// Git Helpers
// ============================================================================

function buildDiffArgs(diffSource: string): string[] {
  switch (diffSource) {
    case 'staged':
      return ['diff', '--cached'];
    case 'unstaged':
      return ['diff'];
    case 'both':
    default:
      return ['diff', 'HEAD'];
  }
}

async function getGitDiff(
  cwd: string,
  diffSource: string,
  filesFilter?: string,
): Promise<string> {
  const statArgs = [...buildDiffArgs(diffSource), '--stat', '--'];
  if (filesFilter) statArgs.push(filesFilter);
  const statResult = await execCommand('git', statArgs, { cwd });

  const diffArgs = [...buildDiffArgs(diffSource), '--'];
  if (filesFilter) diffArgs.push(filesFilter);
  const diffResult = await execCommand('git', diffArgs, { cwd });

  return `${statResult.stdout}\n\n${diffResult.stdout}`;
}

async function getBranchDiff(
  cwd: string,
  base: string,
  filesFilter?: string,
): Promise<string> {
  const statArgs = ['diff', `${base}...HEAD`, '--stat'];
  if (filesFilter) statArgs.push('--', filesFilter);
  const statResult = await execCommand('git', statArgs, { cwd });

  const diffArgs = ['diff', `${base}...HEAD`];
  if (filesFilter) diffArgs.push('--', filesFilter);
  const diffResult = await execCommand('git', diffArgs, { cwd });
  return `${statResult.stdout}\n\n${diffResult.stdout}`;
}

async function getFileFromGitRef(
  cwd: string,
  ref: string,
  filePath: string,
): Promise<string> {
  const result = await execCommand('git', ['show', `${ref}:${filePath}`], {
    cwd,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git show ${ref}:${filePath} failed: ${result.stderr}`);
  }
  return result.stdout;
}

async function getCurrentBranch(cwd: string): Promise<string | null> {
  const result = await execCommand('git', ['branch', '--show-current'], {
    cwd,
  });
  const branch = result.stdout.trim();
  return branch || null; // null in detached HEAD state
}

// ============================================================================
// Auggie CLI Wrapper
// ============================================================================

async function runAuggieReview(
  prompt: string,
  cwd: string,
  config: AuggieReviewConfig,
  options: {
    timeout?: number;
    rulesPath?: string;
    model?: string;
    maxTurns?: number;
    outputFormat?: string;
  } = {},
): Promise<string> {
  const auggieBin = getAuggieBin(config);
  const args = ['--print', '--quiet', '--workspace-root', cwd];

  if (options.rulesPath) args.push('--rules', options.rulesPath);
  if (options.model) args.push('--model', options.model);
  if (options.maxTurns) args.push('--max-turns', String(options.maxTurns));
  if (options.outputFormat)
    args.push('--output-format', options.outputFormat);

  args.push(prompt);

  const result = await execCommand(auggieBin, args, {
    cwd,
    timeout: options.timeout || getTimeoutMs(config),
  });

  if (result.exitCode !== 0) {
    const errorMsg = result.stderr || result.stdout || 'Unknown error';
    throw new Error(
      `Auggie CLI exited with code ${result.exitCode}: ${errorMsg}`,
    );
  }

  return result.stdout;
}

// ============================================================================
// Review Runner
// ============================================================================

async function runReview(
  diff: string,
  reviewType: string,
  customInstructions: string | undefined,
  cwd: string,
  config: AuggieReviewConfig,
): Promise<string> {
  const prompt = buildPrompt(reviewType, config, customInstructions);
  const fullPrompt = `${prompt}\n\nCode to review:\n\n${diff}`;
  return runAuggieReview(fullPrompt, cwd, config);
}

// ============================================================================
// Shared Annotations
// ============================================================================

const REVIEW_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false, // LLM output is non-deterministic
  openWorldHint: true, // Calls Augment's cloud API
} as const;

const CHECK_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true, // Version/auth check IS idempotent
  openWorldHint: true, // Auth check calls Augment's API
} as const;

// ============================================================================
// Shared Schema Definitions
// ============================================================================

const REVIEW_TYPE_DESC =
  'Review focus. Built-in types: "general" (default), "security", "migration", ' +
  '"api", "typescript", "component". Custom types via .auggie-review.json. ' +
  'Unknown types fall back to "general".';

// ============================================================================
// Server Setup (McpServer + registerTool)
// ============================================================================

const server = new McpServer({
  name: 'auggie-review-mcp',
  version: '1.0.0',
});

// ---------------------------------------------------------------------------
// Tool 1: review_diff
// ---------------------------------------------------------------------------

server.registerTool(
  'review_diff',
  {
    title: 'Review Diff',
    description:
      'Review uncommitted or staged git changes using Augment AI. ' +
      'Use this when reviewing local work before committing. No PR needed.',
    inputSchema: {
      diff_source: z
        .enum(['staged', 'unstaged', 'both'])
        .default('both')
        .describe(
          'Which changes to review: "staged" (git diff --cached), ' +
          '"unstaged" (git diff), or "both" (git diff HEAD)',
        ),
      review_type: z.string().max(500).default('general').describe(REVIEW_TYPE_DESC),
      files_filter: z
        .string()
        .max(500)
        .optional()
        .describe('Git pathspec to filter files (e.g., "src/**/*.go", "lib/**/*.ts")'),
      custom_instructions: z
        .string()
        .max(100_000)
        .optional()
        .describe('Additional review instructions to append to the prompt'),
    },
    annotations: REVIEW_ANNOTATIONS,
  },
  async ({ diff_source, review_type, files_filter, custom_instructions }) => {
    const cwd = getWorkspaceRoot();
    const config = await loadConfig(cwd);

    const diff = await getGitDiff(cwd, diff_source, files_filter);

    if (!diff.trim() || diff.trim().split('\n').length <= 1) {
      return { content: [{ type: 'text', text: 'No changes found to review. Working tree is clean.' }] };
    }

    const maxBytes = getMaxDiffBytes(config);
    let warning = '';
    if (Buffer.byteLength(diff) > maxBytes) {
      warning =
        `WARNING: Diff is ${Math.round(Buffer.byteLength(diff) / 1024)}KB ` +
        `(limit: ${maxBytes / 1024}KB). Consider using files_filter to narrow scope.\n\n`;
    }

    const result = await runReview(diff, review_type, custom_instructions, cwd, config);
    return { content: [{ type: 'text', text: warning + result }] };
  },
);

// ---------------------------------------------------------------------------
// Tool 2: review_branch
// ---------------------------------------------------------------------------

server.registerTool(
  'review_branch',
  {
    title: 'Review Current Branch',
    description:
      'Review all changes on the current branch compared to a base branch. ' +
      'Use this when you are already checked out on the feature branch. ' +
      'Requires being on the feature branch (not main). No PR needed.',
    inputSchema: {
      base: z.string().max(500).default('main').refine(v => !v.startsWith('-'), 'Must not start with a dash').describe('Base branch to compare against (default: main)'),
      review_type: z.string().max(500).default('general').describe(REVIEW_TYPE_DESC),
      files_filter: z.string().max(500).optional().describe('Git pathspec to filter reviewed files'),
      custom_instructions: z.string().max(100_000).optional().describe('Additional review instructions'),
    },
    annotations: REVIEW_ANNOTATIONS,
  },
  async ({ base, review_type, files_filter, custom_instructions }) => {
    const cwd = getWorkspaceRoot();
    const config = await loadConfig(cwd);

    const currentBranch = await getCurrentBranch(cwd);
    if (!currentBranch) {
      return { content: [{ type: 'text', text: 'HEAD is detached — switch to a feature branch first.' }] };
    }
    if (currentBranch === base) {
      return { content: [{ type: 'text', text: `Currently on ${base} — no branch diff to review. Switch to a feature branch first.` }] };
    }

    const diff = await getBranchDiff(cwd, base, files_filter);

    if (!diff.trim() || diff.trim().split('\n').length <= 1) {
      return { content: [{ type: 'text', text: `No differences found between ${base} and ${currentBranch}.` }] };
    }

    const header = `Branch: ${currentBranch} vs ${base}\n\n`;
    const maxBytes = getMaxDiffBytes(config);
    let warning = '';
    if (Buffer.byteLength(diff) > maxBytes) {
      warning = `WARNING: Diff is ${Math.round(Buffer.byteLength(diff) / 1024)}KB. Consider using files_filter to narrow scope.\n\n`;
    }

    const result = await runReview(diff, review_type, custom_instructions, cwd, config);
    return { content: [{ type: 'text', text: header + warning + result }] };
  },
);

// ---------------------------------------------------------------------------
// Tool 3: review_files
// ---------------------------------------------------------------------------

server.registerTool(
  'review_files',
  {
    title: 'Review Files',
    description:
      'Review specific files for quality, security, and pattern compliance. ' +
      'Use this for targeted review of specific files (full contents, not diffs). ' +
      'Use git_ref to review files from any branch/tag/commit without checking it out.',
    inputSchema: {
      paths: z
        .array(z.string().max(1000))
        .min(1)
        .describe('File paths to review (relative to workspace root)'),
      git_ref: z
        .string()
        .max(500)
        .refine(v => !v.startsWith('-'), 'Must not start with a dash')
        .optional()
        .describe(
          'Git ref to read files from (e.g., "origin/feature-branch", "HEAD~3"). ' +
          'Files are read via "git show ref:path" instead of from disk.',
        ),
      review_type: z.string().max(500).default('general').describe(REVIEW_TYPE_DESC),
      custom_instructions: z.string().max(100_000).optional().describe('Additional review instructions'),
    },
    annotations: REVIEW_ANNOTATIONS,
  },
  async ({ paths, git_ref, review_type, custom_instructions }) => {
    const cwd = getWorkspaceRoot();
    const config = await loadConfig(cwd);

    const fileContents: string[] = [];
    let successCount = 0;
    for (const filePath of paths) {
      try {
        let content: string;
        if (git_ref) {
          content = await getFileFromGitRef(cwd, git_ref, filePath);
        } else {
          const resolved = resolvePath(cwd, filePath);
          if (!resolved.startsWith(resolvePath(cwd) + '/')) {
            throw new Error(`Path outside workspace: ${filePath}`);
          }
          content = await readFile(resolved, 'utf-8');
        }
        fileContents.push(`--- ${filePath} ---\n${content}\n`);
        successCount++;
      } catch {
        const source = git_ref ? `${git_ref}:${filePath}` : filePath;
        fileContents.push(
          `--- ${source} --- (ERROR: file not found or unreadable)\n`,
        );
      }
    }

    if (successCount === 0) {
      return {
        content: [{ type: 'text', text: `Error: none of the ${paths.length} file(s) could be read. Check that paths are relative to the workspace root.` }],
        isError: true,
      };
    }

    const combined = fileContents.join('\n');
    const prompt = buildPrompt(review_type, config, custom_instructions);
    const refNote = git_ref ? `\nReviewing files from git ref: ${git_ref}\n` : '';
    const fullPrompt = `${prompt}${refNote}\n\nFiles to review:\n\n${combined}`;

    const result = await runAuggieReview(fullPrompt, cwd, config);
    return { content: [{ type: 'text', text: result }] };
  },
);

// ---------------------------------------------------------------------------
// Tool 4: review_pr_ready
// ---------------------------------------------------------------------------

server.registerTool(
  'review_pr_ready',
  {
    title: 'Pre-PR Quality Gate',
    description:
      'Comprehensive pre-PR quality gate combining security and general review. ' +
      'Use this as a final check before creating a pull request. ' +
      'Returns a structured report with PASS/FAIL verdict. ' +
      'Requires being on the feature branch.',
    inputSchema: {
      base: z.string().max(500).default('main').refine(v => !v.startsWith('-'), 'Must not start with a dash').describe('Base branch to compare against'),
      files_filter: z.string().max(500).optional().describe('Git pathspec to filter files'),
      custom_instructions: z.string().max(100_000).optional().describe('Additional review instructions to include'),
    },
    annotations: REVIEW_ANNOTATIONS,
  },
  async ({ base, files_filter, custom_instructions }) => {
    const cwd = getWorkspaceRoot();
    const config = await loadConfig(cwd);

    const currentBranch = await getCurrentBranch(cwd);
    if (!currentBranch) {
      return { content: [{ type: 'text', text: 'HEAD is detached — switch to a feature branch first.' }] };
    }
    if (currentBranch === base) {
      return { content: [{ type: 'text', text: `Currently on ${base} — switch to a feature branch first.` }] };
    }

    const diff = await getBranchDiff(cwd, base, files_filter);

    if (!diff.trim() || diff.trim().split('\n').length <= 1) {
      return { content: [{ type: 'text', text: `No differences found between ${base} and ${currentBranch}.` }] };
    }

    // Compose PR-ready prompt from user's configured review types
    const securityPrompt = getReviewPrompt('security', config);
    const generalPrompt = getReviewPrompt('general', config);

    const prReadyPrompt = `You are performing a comprehensive pre-PR review.
This is the final quality gate before creating a pull request.

Review this diff against ALL of the following criteria:

--- SECURITY REVIEW ---
${securityPrompt}

--- GENERAL CODE REVIEW ---
${generalPrompt}

--- ADDITIONAL CHECKS ---
### Testing Indicators
- Do the changes suggest missing tests?
- Are there edge cases not covered?

Output a structured report:

## Pre-PR Review Report
**Branch:** ${currentBranch} → ${base}
**Files changed:** (from diff stat)

### Critical Findings (blocks PR)
- ...

### High Findings (should fix before merge)
- ...

### Medium Findings (consider)
- ...

### Summary
- Critical: N | High: N | Medium: N
- **Verdict:** PASS / PASS WITH COMMENTS / FAIL

If there are zero critical findings, verdict is PASS or PASS WITH COMMENTS.
If there are any critical findings, verdict is FAIL.`;

    const customPart = custom_instructions
      ? `\n\n--- ADDITIONAL CONTEXT ---\n${custom_instructions}`
      : '';

    const result = await runAuggieReview(
      `${prReadyPrompt}${customPart}\n\nDiff:\n\n${diff}`,
      cwd,
      config,
    );
    return { content: [{ type: 'text', text: result }] };
  },
);

// ---------------------------------------------------------------------------
// Tool 5: review_branch_ref
// ---------------------------------------------------------------------------

server.registerTool(
  'review_branch_ref',
  {
    title: 'Review Branch',
    description:
      'Review any branch or PR — the primary and most common review tool. ' +
      'Use this to review a branch without needing to check it out. ' +
      'Delegates to auggie as an agentic task: auggie discovers changed files, ' +
      'reads code, and analyzes changes using its own tools. Works on large PRs.',
    inputSchema: {
      branch: z
        .string()
        .max(500)
        .refine(v => !v.startsWith('-'), 'Must not start with a dash')
        .describe('Branch to review (e.g., "feature/my-change" or "origin/feature/my-change")'),
      base: z.string().max(500).default('main').refine(v => !v.startsWith('-'), 'Must not start with a dash').describe('Base branch to compare against (default: main)'),
      review_type: z.string().max(500).default('general').describe(REVIEW_TYPE_DESC),
      custom_instructions: z
        .string()
        .max(100_000)
        .optional()
        .describe('Additional review context (e.g., "This PR adds user authentication")'),
    },
    annotations: REVIEW_ANNOTATIONS,
  },
  async ({ branch, base, review_type, custom_instructions }) => {
    const cwd = getWorkspaceRoot();
    const config = await loadConfig(cwd);

    // Detect repo from git remote
    const remoteResult = await execCommand(
      'git',
      ['remote', 'get-url', 'origin'],
      { cwd, timeout: 10_000 },
    );
    let repo = 'unknown/repo';
    if (remoteResult.exitCode === 0) {
      const repoMatch = remoteResult.stdout.trim().match(/[:/]([^/]+\/[^/]+?)(\.git)?$/);
      if (repoMatch) repo = repoMatch[1];
    }

    const hint = getReviewHint(review_type, config);
    const customPart = custom_instructions
      ? ` Additional context: ${custom_instructions}`
      : '';

    // Agentic delegation: give auggie a task, not a diff.
    const instruction =
      `Review the changes on branch "${branch}" compared to "${base}" ` +
      `in ${repo}. Analyze all changed files. ${hint}${customPart} ` +
      `Post your findings as a structured review with severity levels ` +
      `(CRITICAL/HIGH/MEDIUM). Do not post comments to GitHub — just ` +
      `output your review to stdout.`;

    const result = await runAuggieReview(instruction, cwd, config);
    return { content: [{ type: 'text', text: result }] };
  },
);

// ---------------------------------------------------------------------------
// Tool 6: check_auth
// ---------------------------------------------------------------------------

server.registerTool(
  'check_auth',
  {
    title: 'Check Auth',
    description:
      'Check if the auggie CLI is installed and authenticated. ' +
      'Returns version info, auth status, workspace path, and git repo status.',
    inputSchema: {},
    annotations: CHECK_ANNOTATIONS,
  },
  async () => {
    const lines: string[] = [];

    // Check auggie binary
    let auggieBin = AUGGIE_BIN;
    try {
      const cwd = getWorkspaceRoot();
      const config = await loadConfig(cwd);
      auggieBin = getAuggieBin(config);
    } catch {
      // WORKSPACE_ROOT not set — use default binary
    }

    try {
      const versionResult = await execCommand(auggieBin, ['--version'], {
        timeout: 10_000,
      });
      lines.push(`auggie CLI: installed (${versionResult.stdout.trim()})`);
    } catch {
      lines.push(
        `auggie CLI: NOT FOUND at "${auggieBin}"\n` +
          'Install with: npm install -g @augmentcode/auggie\n' +
          'Then authenticate: auggie login',
      );
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // Check auth with a trivial operation
    let authCwd: string;
    try {
      authCwd = getWorkspaceRoot();
    } catch {
      authCwd = process.cwd();
    }

    try {
      const testResult = await execCommand(
        auggieBin,
        [
          '--print',
          '--quiet',
          '--max-turns',
          '1',
          'Say "auth OK" and nothing else.',
        ],
        { cwd: authCwd, timeout: 30_000 },
      );
      if (testResult.exitCode === 0) {
        lines.push('Authentication: OK');
      } else {
        lines.push(
          `Authentication: FAILED (exit code ${testResult.exitCode})\n` +
            `Error: ${testResult.stderr || testResult.stdout}\n` +
            'Run: auggie login',
        );
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      lines.push(`Authentication: ERROR — ${errMsg}`);
    }

    // Check workspace
    try {
      const root = getWorkspaceRoot();
      lines.push(`Workspace: ${root}`);

      // Check if workspace is a git repo
      const gitCheck = await execCommand(
        'git',
        ['rev-parse', '--is-inside-work-tree'],
        { cwd: root, timeout: 5_000 },
      );
      if (gitCheck.exitCode === 0) {
        lines.push('Git repository: YES');
      } else {
        lines.push('Git repository: NO (git-dependent tools will fail)');
      }

      // Check for config file
      const config = await loadConfig(root);
      const hasCustomTypes = Object.keys(config.review_types || {}).length > 0;
      if (hasCustomTypes) {
        lines.push(
          `Config: .auggie-review.json found (${Object.keys(config.review_types ?? {}).length} custom review types)`,
        );
      } else {
        lines.push('Config: using built-in defaults (no .auggie-review.json)');
      }
    } catch {
      lines.push('Workspace: NOT SET (WORKSPACE_ROOT env var required)');
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error('Fatal error:', msg);
  process.exit(1);
});
