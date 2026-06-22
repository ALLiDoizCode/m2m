/* eslint-disable no-console */
/**
 * `connector route` — generic routing-table surface.
 *
 * `route add <prefix> --next-hop <peer> [--priority <n>]` maps to the admin
 * `POST /admin/routes` endpoint; `route ls [--json]` maps to `GET /admin/routes`.
 * These are the transit-routing primitives, distinct from `app add`/`app ls`
 * which deal in locally terminated routes (`upstream`-carrying).
 *
 * @module cli/commands/route
 */

import { Command } from 'commander';
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
  termination?: { upstream?: string };
}

interface ListRoutesResponse {
  nodeId: string;
  routeCount: number;
  routes: ListedRoute[];
}

/** Attach `--url` / `--api-key` to a command. */
function withCommonOptions(cmd: Command): Command {
  return cmd
    .option('-u, --url <url>', 'Admin API base URL', DEFAULT_ADMIN_URL)
    .option('--api-key <key>', 'Admin API key (falls back to ADMIN_API_KEY env var)');
}

/** Build the `route` command group. */
export function buildRouteCommand(): Command {
  const route = new Command('route').description('Manage the connector routing table');

  withCommonOptions(
    route
      .command('add <prefix>')
      .description('Add a routing-table entry forwarding <prefix> to a next-hop peer')
      .requiredOption('--next-hop <peer>', 'Peer ID to forward matching packets to')
      .option('--priority <n>', 'Route priority (higher wins, default 0)', '0')
  ).action(
    async (prefix: string, opts: AdminCommonOptions & { nextHop: string; priority: string }) => {
      await runAdmin(async () => {
        const client = makeAdminClient(opts);
        const priority = Number.parseInt(opts.priority, 10);
        if (Number.isNaN(priority)) {
          throw new Error(`--priority must be an integer (got ${opts.priority})`);
        }
        await client.addRoute({ prefix, nextHop: opts.nextHop, priority });
        console.log(`Route added: ${prefix} -> ${opts.nextHop} (priority ${priority})`);
      });
    }
  );

  withCommonOptions(
    route
      .command('ls')
      .description('List all routing-table entries')
      .option('--json', 'Output the raw admin response as JSON')
  ).action(async (opts: AdminCommonOptions & { json?: boolean }) => {
    await runAdmin(async () => {
      const client = makeAdminClient(opts);
      const res = (await client.listRoutes()) as ListRoutesResponse;
      if (opts.json) {
        printJson(res);
        return;
      }
      console.log(`Routes (${res.routeCount}):`);
      if (res.routes.length === 0) {
        console.log('  (none)');
        return;
      }
      for (const r of res.routes) {
        const kind = r.termination?.upstream ? 'app' : 'transit';
        console.log(`  ${r.prefix} -> ${r.nextHop} (priority ${r.priority}) [${kind}]`);
      }
    });
  });

  route.addHelpText(
    'after',
    `
Examples:
  # Add a transit route forwarding a prefix to a peer
  $ connector route add g.alice --next-hop alice-peer --priority 10

  # List all routes (human-readable)
  $ connector route ls

  # List all routes as JSON
  $ connector route ls --json --url http://localhost:8081
`
  );

  return route;
}
