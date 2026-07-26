// Mint a FRESH GitHub App installation token, on demand, on the host.
//
// WHY THIS EXISTS — root cause of connector#462
// --------------------------------------------
// GitHub App installation tokens expire ONE HOUR after issue. The workflow
// minted a single token in an early step (`actions/create-github-app-token@v2`)
// and the runner pushed only after the implementer AND the reviewer had both
// finished. Any run longer than an hour therefore died at the very last step:
//
//     remote: Invalid username or token. Password authentication is not
//     supported for Git operations.
//     Error: git push of 'sandcastle/issue-N' failed (exit 128).
//
// Observed on issue #430 (push at 77 min) and twice on #422 (61 min, 73 min).
// Every one of those runs lost a COMPLETED implementation — the failure lands
// after all the expensive work is done. Raising `timeout-minutes` on its own
// makes this worse, not better: the extra minutes are spent and the push still
// fails.
//
// THE FIX
// -------
// Keep the App's private key on the HOST (never in the sandbox container) and
// mint a brand-new installation token immediately before each push. The token is
// then at most seconds old, so run length stops mattering entirely.
//
// We mint here rather than adding a second `create-github-app-token@v2` step
// because the push happens from INSIDE the sandbox, part-way through this
// runner's execution — there is no workflow step boundary at that moment to hang
// an action off. See agent-implement-issue.ts for how the minted token is
// handed to git without ever appearing in argv or in the logs.
//
// LOCAL DEV / NO-APP FALLBACK
// --------------------------
// When APP_ID or APP_PRIVATE_KEY is absent (local runs, forks) this falls back
// to the ambient GH_TOKEN, so behaviour is exactly what it was before. The
// expiry problem is a CI-long-run problem; a local run has a token in the env
// already and no way to mint.

import { createSign } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** Minted token plus where it came from, for logging without leaking the value. */
export interface MintedToken {
  readonly token: string;
  /** 'app' = freshly minted (expiry reset). 'ambient' = pre-existing GH_TOKEN. */
  readonly source: 'app' | 'ambient';
}

/**
 * `owner/repo` for the current run. `GITHUB_REPOSITORY` is always set by
 * Actions; the `gh` fallback covers local invocation.
 */
function nameWithOwner(): string {
  const fromEnv = process.env.GITHUB_REPOSITORY?.trim();
  if (fromEnv) return fromEnv;
  return execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
    encoding: 'utf8',
  }).trim();
}

/**
 * RS256 JWT asserting the App's identity, valid for 9 minutes (GitHub rejects
 * anything over 10). `iat` is backdated 60s to absorb clock skew between the
 * runner and GitHub, which is the documented recommendation.
 */
function appJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: appId,
  })}`;

  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  // APP_PRIVATE_KEY is a PEM. GitHub secrets preserve newlines, but a key that
  // has been round-tripped through a shell can arrive with literal `\n`; accept
  // both so a mis-pasted secret fails loudly at the API call rather than with an
  // opaque OpenSSL error here.
  const pem = privateKey.includes('\\n') ? privateKey.replace(/\\n/g, '\n') : privateKey;
  return `${unsigned}.${signer.sign(pem, 'base64url')}`;
}

async function githubJson(path: string, jwt: string, method: 'GET' | 'POST'): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'toon-protocol-sandcastle-runner',
    },
  });
  if (!res.ok) {
    // Body is App-level metadata, never the installation token itself (that is
    // only returned on success), so it is safe to surface.
    throw new Error(
      `GitHub API ${method} ${path} failed: ${res.status} ${res.statusText}\n${await res.text()}`
    );
  }
  return res.json();
}

/**
 * Mint a fresh installation token scoped to this repository.
 *
 * Requires `APP_ID` + `APP_PRIVATE_KEY` on the host. Falls back to the ambient
 * `GH_TOKEN` when they are absent. Throws if neither is available, since every
 * caller needs *some* credential.
 */
export async function mintAppToken(): Promise<MintedToken> {
  const appId = process.env.APP_ID?.trim();
  const privateKey = process.env.APP_PRIVATE_KEY;

  if (!appId || !privateKey) {
    const ambient = process.env.GH_TOKEN?.trim();
    if (!ambient) {
      throw new Error(
        'Cannot obtain a GitHub credential: APP_ID/APP_PRIVATE_KEY are unset ' +
          'and there is no GH_TOKEN to fall back to.'
      );
    }
    return { token: ambient, source: 'ambient' };
  }

  const jwt = appJwt(appId, privateKey);

  // The App is installed org-wide; ask GitHub which installation covers this
  // repo rather than hard-coding an installation id.
  const installation = (await githubJson(`/repos/${nameWithOwner()}/installation`, jwt, 'GET')) as {
    id?: number;
  };
  if (typeof installation.id !== 'number') {
    throw new Error(
      `GitHub returned no installation id for ${nameWithOwner()} — is the App installed on this repo?`
    );
  }

  const minted = (await githubJson(
    `/app/installations/${installation.id}/access_tokens`,
    jwt,
    'POST'
  )) as { token?: string };
  if (!minted.token) {
    throw new Error('GitHub returned an installation-token response with no `token` field.');
  }

  return { token: minted.token, source: 'app' };
}
