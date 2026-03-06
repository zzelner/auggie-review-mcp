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

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { resolve } from 'path';

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_TIMEOUT_MS = 900_000; // 15 minutes
const DEFAULT_MAX_DIFF_BYTES = 100_000; // ~100KB diff limit before warning
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

let cachedConfig: AuggieReviewConfig | null = null;

async function loadConfig(workspaceRoot: string): Promise<AuggieReviewConfig> {
  if (cachedConfig) return cachedConfig;

  const configPath = resolve(workspaceRoot, '.auggie-review.json');
  try {
    const raw = await readFile(configPath, 'utf-8');
    cachedConfig = JSON.parse(raw) as AuggieReviewConfig;
    return cachedConfig;
  } catch {
    cachedConfig = {};
    return cachedConfig;
  }
}

function getTimeoutMs(config: AuggieReviewConfig): number {
  return config.settings?.timeout_ms || DEFAULT_TIMEOUT_MS;
}

function getMaxDiffBytes(config: AuggieReviewConfig): number {
  return config.settings?.max_diff_bytes || DEFAULT_MAX_DIFF_BYTES;
}

function getAuggieBin(config: AuggieReviewConfig): string {
  return config.settings?.auggie_bin || AUGGIE_BIN;
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
  // User overrides take precedence
  if (config.review_types?.[reviewType]) {
    return config.review_types[reviewType];
  }
  // Built-in defaults
  if (reviewType in DEFAULT_PROMPTS) {
    return DEFAULT_PROMPTS[reviewType as DefaultReviewType];
  }
  // Unknown type — fall back to general
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
 * These are short summaries — auggie gets the full prompt context from its own tools.
 */
function getReviewHint(
  reviewType: string,
  config: AuggieReviewConfig,
): string {
  // If user has a custom type, extract a hint from the first line
  if (config.review_types?.[reviewType]) {
    const firstLine = config.review_types[reviewType].split('\n')[0];
    return firstLine.length > 200 ? firstLine.slice(0, 200) + '...' : firstLine;
  }

  const defaultHints: Record<string, string> = {
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

  return defaultHints[reviewType] || defaultHints.general;
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
      signal: ac.signal,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    if (options.stdin) {
      proc.stdin.write(options.stdin);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on('error', (err: unknown) => {
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

async function getGitDiff(
  cwd: string,
  diffSource: string,
  filesFilter?: string,
): Promise<string> {
  const args = ['diff'];

  switch (diffSource) {
    case 'staged':
      args.push('--cached');
      break;
    case 'unstaged':
      break;
    case 'both':
    default:
      args.push('HEAD');
      break;
  }

  args.push('--stat', '--');
  if (filesFilter) args.push(filesFilter);

  const statResult = await execCommand('git', args, { cwd });

  const diffArgs = ['diff'];
  switch (diffSource) {
    case 'staged':
      diffArgs.push('--cached');
      break;
    case 'unstaged':
      break;
    case 'both':
    default:
      diffArgs.push('HEAD');
      break;
  }
  diffArgs.push('--');
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

async function getCurrentBranch(cwd: string): Promise<string> {
  const result = await execCommand('git', ['branch', '--show-current'], {
    cwd,
  });
  return result.stdout.trim();
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
// Tool Definitions
// ============================================================================

const REVIEW_TYPE_DESCRIPTION =
  'Review focus. Built-in types: "general" (default), "security", "migration", ' +
  '"api", "typescript", "component". Custom types can be defined in .auggie-review.json.';

const TOOLS = [
  {
    name: 'review_diff',
    description:
      'Review uncommitted or staged git changes using Augment AI. ' +
      'Runs auggie on the git diff output. No PR needed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        diff_source: {
          type: 'string',
          enum: ['staged', 'unstaged', 'both'],
          default: 'both',
          description:
            'Which changes to review: "staged" (git diff --cached), ' +
            '"unstaged" (git diff), or "both" (git diff HEAD)',
        },
        review_type: {
          type: 'string',
          default: 'general',
          description: REVIEW_TYPE_DESCRIPTION,
        },
        files_filter: {
          type: 'string',
          description:
            'Git pathspec to filter files (e.g., "src/**/*.go", "lib/**/*.ts")',
        },
        custom_instructions: {
          type: 'string',
          description:
            'Additional review instructions to append to the prompt',
        },
      },
    },
  },
  {
    name: 'review_branch',
    description:
      'Review all changes on the current branch compared to a base branch. ' +
      'Equivalent to reviewing git diff base...HEAD. No PR needed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        base: {
          type: 'string',
          default: 'main',
          description: 'Base branch to compare against (default: main)',
        },
        review_type: {
          type: 'string',
          default: 'general',
          description: REVIEW_TYPE_DESCRIPTION,
        },
        files_filter: {
          type: 'string',
          description: 'Git pathspec to filter reviewed files',
        },
        custom_instructions: {
          type: 'string',
          description: 'Additional review instructions',
        },
      },
    },
  },
  {
    name: 'review_files',
    description:
      'Review specific files for quality, security, and pattern compliance. ' +
      'Reviews the full file contents, not just diffs. ' +
      'Use git_ref to review files from any branch/tag/commit without checking it out.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths to review (relative to workspace root)',
        },
        git_ref: {
          type: 'string',
          description:
            'Git ref to read files from (e.g., "origin/feature-branch", "HEAD~3"). ' +
            'Files are read via "git show ref:path" instead of from disk.',
        },
        review_type: {
          type: 'string',
          default: 'general',
          description: REVIEW_TYPE_DESCRIPTION,
        },
        custom_instructions: {
          type: 'string',
          description: 'Additional review instructions',
        },
      },
      required: ['paths'],
    },
  },
  {
    name: 'review_pr_ready',
    description:
      'Comprehensive pre-PR review combining security, types, and quality checks. ' +
      'Returns a structured report with PASS/FAIL verdict. ' +
      'Reviews the full branch diff against the base branch.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        base: {
          type: 'string',
          default: 'main',
          description: 'Base branch to compare against',
        },
        files_filter: {
          type: 'string',
          description: 'Git pathspec to filter files',
        },
      },
    },
  },
  {
    name: 'review_branch_ref',
    description:
      'Review a remote branch or PR — the primary tool for code review. ' +
      'Delegates to auggie as an agentic task: auggie discovers changed files, ' +
      'reads code, and analyzes changes using its own tools. ' +
      'No need to specify files — auggie discovers everything automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        branch: {
          type: 'string',
          description:
            'Branch to review (e.g., "feature/my-change" or "origin/feature/my-change")',
        },
        base: {
          type: 'string',
          default: 'main',
          description: 'Base branch to compare against (default: main)',
        },
        review_type: {
          type: 'string',
          default: 'general',
          description: REVIEW_TYPE_DESCRIPTION,
        },
        custom_instructions: {
          type: 'string',
          description:
            'Additional review context (e.g., "This PR adds user authentication")',
        },
      },
      required: ['branch'],
    },
  },
  {
    name: 'check_auth',
    description:
      'Check if the auggie CLI is installed and authenticated. ' +
      'Returns version info, auth status, and workspace path.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
];

// ============================================================================
// Tool Handlers
// ============================================================================

async function handleReviewDiff(
  args: Record<string, unknown>,
): Promise<string> {
  const cwd = getWorkspaceRoot();
  const config = await loadConfig(cwd);
  const diffSource =
    typeof args.diff_source === 'string' ? args.diff_source : 'both';
  const reviewType =
    typeof args.review_type === 'string' ? args.review_type : 'general';
  const filesFilter =
    typeof args.files_filter === 'string' ? args.files_filter : undefined;
  const customInstructions =
    typeof args.custom_instructions === 'string'
      ? args.custom_instructions
      : undefined;

  const diff = await getGitDiff(cwd, diffSource, filesFilter);

  if (!diff.trim() || diff.trim().split('\n').length <= 1) {
    return 'No changes found to review. Working tree is clean.';
  }

  const maxBytes = getMaxDiffBytes(config);
  if (Buffer.byteLength(diff) > maxBytes) {
    return (
      `WARNING: Diff is ${Math.round(Buffer.byteLength(diff) / 1024)}KB ` +
      `(limit: ${maxBytes / 1024}KB). Consider using files_filter to narrow scope.\n\n` +
      'Proceeding with review of the full diff...\n\n' +
      (await runReview(diff, reviewType, customInstructions, cwd, config))
    );
  }

  return runReview(diff, reviewType, customInstructions, cwd, config);
}

async function handleReviewBranch(
  args: Record<string, unknown>,
): Promise<string> {
  const cwd = getWorkspaceRoot();
  const config = await loadConfig(cwd);
  const base = typeof args.base === 'string' ? args.base : 'main';
  const reviewType =
    typeof args.review_type === 'string' ? args.review_type : 'general';
  const filesFilter =
    typeof args.files_filter === 'string' ? args.files_filter : undefined;
  const customInstructions =
    typeof args.custom_instructions === 'string'
      ? args.custom_instructions
      : undefined;

  const currentBranch = await getCurrentBranch(cwd);
  if (currentBranch === base) {
    return `Currently on ${base} — no branch diff to review. Switch to a feature branch first.`;
  }

  const diff = await getBranchDiff(cwd, base, filesFilter);

  if (!diff.trim() || diff.trim().split('\n').length <= 1) {
    return `No differences found between ${base} and ${currentBranch}.`;
  }

  const header = `Branch: ${currentBranch} vs ${base}\n\n`;
  const maxBytes = getMaxDiffBytes(config);

  if (Buffer.byteLength(diff) > maxBytes) {
    return (
      header +
      `WARNING: Diff is ${Math.round(Buffer.byteLength(diff) / 1024)}KB. ` +
      'Consider using files_filter to narrow scope.\n\n' +
      (await runReview(diff, reviewType, customInstructions, cwd, config))
    );
  }

  return (
    header + (await runReview(diff, reviewType, customInstructions, cwd, config))
  );
}

async function handleReviewFiles(
  args: Record<string, unknown>,
): Promise<string> {
  const cwd = getWorkspaceRoot();
  const config = await loadConfig(cwd);
  const reviewType =
    typeof args.review_type === 'string' ? args.review_type : 'general';
  const customInstructions =
    typeof args.custom_instructions === 'string'
      ? args.custom_instructions
      : undefined;
  const gitRef =
    typeof args.git_ref === 'string' ? args.git_ref : undefined;

  if (!Array.isArray(args.paths) || args.paths.length === 0) {
    return 'Error: paths array is required and must not be empty.';
  }
  const paths = args.paths.filter((p): p is string => typeof p === 'string');
  if (paths.length === 0) {
    return 'Error: paths array must contain string values.';
  }

  const fileContents: string[] = [];
  for (const filePath of paths) {
    try {
      const content = gitRef
        ? await getFileFromGitRef(cwd, gitRef, filePath)
        : await readFile(resolve(cwd, filePath), 'utf-8');
      fileContents.push(`--- ${filePath} ---\n${content}\n`);
    } catch {
      const source = gitRef ? `${gitRef}:${filePath}` : filePath;
      fileContents.push(
        `--- ${source} --- (ERROR: file not found or unreadable)\n`,
      );
    }
  }

  const combined = fileContents.join('\n');
  const prompt = buildPrompt(reviewType, config, customInstructions);
  const refNote = gitRef
    ? `\nReviewing files from git ref: ${gitRef}\n`
    : '';
  const fullPrompt = `${prompt}${refNote}\n\nFiles to review:\n\n${combined}`;

  return runAuggieReview(fullPrompt, cwd, config);
}

async function handleReviewBranchRef(
  args: Record<string, unknown>,
): Promise<string> {
  const cwd = getWorkspaceRoot();
  const config = await loadConfig(cwd);
  const branch = typeof args.branch === 'string' ? args.branch : '';
  const base = typeof args.base === 'string' ? args.base : 'main';
  const reviewType =
    typeof args.review_type === 'string' ? args.review_type : 'general';
  const customInstructions =
    typeof args.custom_instructions === 'string'
      ? args.custom_instructions
      : undefined;

  if (!branch) {
    return 'Error: branch is required.';
  }

  // Detect repo from git remote
  const remoteResult = await execCommand(
    'git',
    ['remote', 'get-url', 'origin'],
    { cwd, timeout: 10_000 },
  );
  const remoteUrl = remoteResult.stdout.trim();
  const repoMatch = remoteUrl.match(/[:/]([^/]+\/[^/]+?)(\.git)?$/);
  const repo = repoMatch ? repoMatch[1] : 'unknown/repo';

  const hint = getReviewHint(reviewType, config);
  const customPart = customInstructions
    ? ` Additional context: ${customInstructions}`
    : '';

  // Agentic delegation: give auggie a task, not a diff.
  // Auggie uses its own tools to fetch the diff, read files, and analyze.
  const instruction =
    `Review the changes on branch "${branch}" compared to "${base}" ` +
    `in ${repo}. Analyze all changed files. ${hint}${customPart} ` +
    `Post your findings as a structured review with severity levels ` +
    `(CRITICAL/HIGH/MEDIUM). Do not post comments to GitHub — just ` +
    `output your review to stdout.`;

  return runAuggieReview(instruction, cwd, config);
}

async function handleReviewPrReady(
  args: Record<string, unknown>,
): Promise<string> {
  const cwd = getWorkspaceRoot();
  const config = await loadConfig(cwd);
  const base = typeof args.base === 'string' ? args.base : 'main';
  const filesFilter =
    typeof args.files_filter === 'string' ? args.files_filter : undefined;

  const currentBranch = await getCurrentBranch(cwd);
  if (currentBranch === base) {
    return `Currently on ${base} — switch to a feature branch first.`;
  }

  const diff = await getBranchDiff(cwd, base, filesFilter);

  if (!diff.trim() || diff.trim().split('\n').length <= 1) {
    return `No differences found between ${base} and ${currentBranch}.`;
  }

  const prReadyPrompt = `You are performing a comprehensive pre-PR review.
This is the final quality gate before creating a pull request.

Review this diff against ALL of the following criteria:

### 1. Security (CRITICAL — blocks PR)
- Authentication checks present on all protected endpoints
- No hardcoded secrets or credentials
- Input validation on user-provided data
- Data access properly scoped

### 2. Type Safety (CRITICAL)
- No unsafe type assertions or \`any\` types
- Functions have explicit return types
- Null/undefined handled properly

### 3. Code Quality (HIGH)
- No unused variables/imports
- Error handling on async operations
- Functions are focused and reasonably sized
- No console.log in production code

### 4. Architecture (MEDIUM)
- Follows existing codebase conventions
- No unnecessary code duplication
- Proper separation of concerns

### 5. Testing Indicators
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

  return runAuggieReview(`${prReadyPrompt}\n\nDiff:\n\n${diff}`, cwd, config);
}

async function handleCheckAuth(): Promise<string> {
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
    return lines.join('\n');
  }

  // Check auth with a trivial operation
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
      {
        cwd: (() => {
          try {
            return getWorkspaceRoot();
          } catch {
            return process.cwd();
          }
        })(),
        timeout: 30_000,
      },
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

    // Check for config file
    const config = await loadConfig(root);
    const hasCustomTypes = Object.keys(config.review_types || {}).length > 0;
    if (hasCustomTypes) {
      lines.push(
        `Config: .auggie-review.json found (${Object.keys(config.review_types!).length} custom review types)`,
      );
    } else {
      lines.push('Config: using built-in defaults (no .auggie-review.json)');
    }
  } catch {
    lines.push('Workspace: NOT SET (WORKSPACE_ROOT env var required)');
  }

  return lines.join('\n');
}

// ============================================================================
// Server Setup
// ============================================================================

const server = new Server(
  {
    name: 'auggie-review-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const safeArgs = (args || {}) as Record<string, unknown>;

  try {
    let result: string;

    switch (name) {
      case 'review_diff':
        result = await handleReviewDiff(safeArgs);
        break;
      case 'review_branch':
        result = await handleReviewBranch(safeArgs);
        break;
      case 'review_files':
        result = await handleReviewFiles(safeArgs);
        break;
      case 'review_branch_ref':
        result = await handleReviewBranchRef(safeArgs);
        break;
      case 'review_pr_ready':
        result = await handleReviewPrReady(safeArgs);
        break;
      case 'check_auth':
        result = await handleCheckAuth();
        break;
      default:
        result = `Unknown tool: ${name}`;
    }

    return {
      content: [{ type: 'text' as const, text: result }],
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
});

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
