/* eslint-disable no-console */
/**
 * `connector app` — the "nginx server block" UX for locally terminated routes.
 *
 * `app add <name> --upstream <url> --route <path> --price <n> --chains <list>`
 * registers a terminated route via `POST /admin/routes` (additive — it does not
 * disturb other routes, unlike the declarative `PUT /admin/desired-state`) — a
 * route whose entry carries the issue-#218 termination fields
 * (`upstream`/`price`/`chains` + optional `ilpAddress`/`settlementAddresses`).
 * `app ls [--json]` lists the terminated routes (those whose entry carries an
 * `upstream`), distinguished from plain transit routes.
 *
 * @module cli/commands/app
 */

import { Command } from 'commander';
import type { TerminationChain } from '../../config/types';
import type { RouteInput } from '../../client/connector-admin-client';
import {
  AdminCommonOptions,
  DEFAULT_ADMIN_URL,
  makeAdminClient,
  printJson,
  runAdmin,
} from '../admin-client-factory';

interface ListedRoute {
  prefix: string;
  nextHop: string;
  priority: number;
  termination?: {
    upstream?: string;
    price?: string;
    chains?: TerminationChain[];
    ilpAddress?: string;
    settlementAddresses?: Partial<Record<TerminationChain, string>>;
  };
}

interface ListRoutesResponse {
  nodeId: string;
  routeCount: number;
  routes: ListedRoute[];
}

/**
 * Parse a `--chains base,solana` list into the canonical
 * `('evm'|'solana'|'mina')[]`. The friendly alias `base` (a popular EVM L2) maps
 * to `evm`; `eth`/`ethereum` likewise map to `evm`. Unknown chains throw.
 */
export function parseChains(raw: string): TerminationChain[] {
  const aliases: Record<string, TerminationChain> = {
    base: 'evm',
    eth: 'evm',
    ethereum: 'evm',
    evm: 'evm',
    solana: 'solana',
    sol: 'solana',
    mina: 'mina',
  };
  const out: TerminationChain[] = [];
  for (const part of raw.split(',')) {
    const key = part.trim().toLowerCase();
    if (key.length === 0) continue;
    const chain = aliases[key];
    if (!chain) {
      throw new Error(`unknown chain '${part.trim()}' (expected base/evm, solana, or mina)`);
    }
    if (!out.includes(chain)) out.push(chain);
  }
  if (out.length === 0) {
    throw new Error('--chains must list at least one chain (e.g. base,solana)');
  }
  return out;
}

/**
 * Parse a `--settlement evm=0xabc,solana=Abc...` list into
 * `Partial<Record<TerminationChain, string>>`. Chain names accept the same
 * aliases as {@link parseChains}.
 */
export function parseSettlement(raw: string): Partial<Record<TerminationChain, string>> {
  const out: Partial<Record<TerminationChain, string>> = {};
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) {
      throw new Error(`--settlement entry '${trimmed}' must be <chain>=<address>`);
    }
    const chains = parseChains(trimmed.slice(0, eq));
    const chain = chains[0];
    if (!chain) {
      throw new Error(`--settlement entry '${trimmed}' has no chain`);
    }
    const addr = trimmed.slice(eq + 1).trim();
    if (addr.length === 0) {
      throw new Error(`--settlement entry '${trimmed}' is missing an address`);
    }
    out[chain] = addr;
  }
  return out;
}

/** Attach `--url` / `--api-key` to a command. */
function withCommonOptions(cmd: Command): Command {
  return cmd
    .option('-u, --url <url>', 'Admin API base URL', DEFAULT_ADMIN_URL)
    .option('--api-key <key>', 'Admin API key (falls back to ADMIN_API_KEY env var)');
}

/** Build the `app` command group. */
export function buildAppCommand(): Command {
  const app = new Command('app').description('Manage locally terminated apps (server blocks)');

  withCommonOptions(
    app
      .command('add <name>')
      .description('Register a terminated app: a route that reverse-proxies to an upstream')
      .requiredOption('--upstream <url>', 'Upstream HTTP(S) base URL to proxy deliveries to')
      .requiredOption(
        '--route <path>',
        'ILP address prefix this app terminates (e.g. g.node.greet)'
      )
      .requiredOption('--price <n>', 'Price to terminate, atomic units (nano-USDC, 6dp)')
      .requiredOption(
        '--chains <list>',
        'Comma-separated settlement chains (e.g. base,solana,mina)'
      )
      .option(
        '--ilp-address <addr>',
        'Connector ILP address advertised for the toon-channel upgrade'
      )
      .option('--settlement <list>', 'Comma-separated <chain>=<addr> settlement addresses')
  ).action(
    async (
      name: string,
      opts: AdminCommonOptions & {
        upstream: string;
        route: string;
        price: string;
        chains: string;
        ilpAddress?: string;
        settlement?: string;
      }
    ) => {
      await runAdmin(async () => {
        const client = makeAdminClient(opts);
        const chains = parseChains(opts.chains);
        const settlementAddresses = opts.settlement ? parseSettlement(opts.settlement) : undefined;

        const route: RouteInput = {
          prefix: opts.route,
          // A terminated route is locally delivered; the next-hop is this node
          // itself (the admin API treats an unknown/local next-hop as 'local').
          nextHop: 'local',
          upstream: opts.upstream,
          price: opts.price,
          chains,
          // The connector requires a non-empty ilpAddress for a terminated route
          // (it is advertised in the toon-channel upgrade). Default it to the
          // route's own prefix when --ilp-address is omitted.
          ilpAddress: opts.ilpAddress ?? opts.route,
          ...(settlementAddresses ? { settlementAddresses } : {}),
        };

        await client.addRoute(route);
        console.log(`App '${name}' added: ${opts.route} -> ${opts.upstream}`);
        console.log(`  price: ${opts.price}  chains: ${chains.join(', ')}`);
      });
    }
  );

  withCommonOptions(
    app
      .command('ls')
      .description('List terminated apps (routes carrying an upstream)')
      .option('--json', 'Output the raw admin response as JSON')
  ).action(async (opts: AdminCommonOptions & { json?: boolean }) => {
    await runAdmin(async () => {
      const client = makeAdminClient(opts);
      const res = (await client.listRoutes()) as ListRoutesResponse;
      const apps = res.routes.filter((r) => r.termination?.upstream);

      if (opts.json) {
        printJson({ nodeId: res.nodeId, appCount: apps.length, apps });
        return;
      }

      console.log(`Apps (${apps.length}):`);
      if (apps.length === 0) {
        console.log('  (none)');
        return;
      }
      for (const r of apps) {
        const t = r.termination ?? {};
        const chains = t.chains?.join(', ') ?? '';
        console.log(`  ${r.prefix} -> ${t.upstream}`);
        console.log(`    price: ${t.price ?? '?'}  chains: ${chains}`);
      }
    });
  });

  app.addHelpText(
    'after',
    `
Examples:
  # Add an app (the "nginx server block"): terminate g.node.greet, proxy to a local upstream
  $ connector app add greet --upstream http://127.0.0.1:8080 --route g.node.greet \\
      --price 1000 --chains base,solana,mina

  # Add an app with an explicit ILP address and EVM settlement address
  $ connector app add greet --upstream http://127.0.0.1:8080 --route g.node.greet \\
      --price 1000 --chains base --settlement evm=0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28

  # List terminated apps as JSON
  $ connector app ls --json --url http://localhost:8081
`
  );

  return app;
}
