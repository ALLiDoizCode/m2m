#!/usr/bin/env ts-node
/* eslint-disable no-console -- CLI script: console output is the intended interface */
/**
 * Admin API Inventory Drift Check
 * @packageDocumentation
 * @remarks
 * Validates that the machine-readable inventory matches actual route registrations
 * in the source code. Fails CI if routes are added without updating the inventory,
 * or if the inventory documents routes that no longer exist.
 *
 * **Story 38.1** — HTTP Endpoint Inventory Doc (AC 7)
 *
 * **Performance target:** < 2 seconds (static analysis only, no runtime boot)
 *
 * @example
 * ```bash
 * # Run via npm script
 * npm run lint:inventory
 *
 * # Run directly
 * npx ts-node scripts/check-admin-api-inventory.ts
 * ```
 */

import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import {
  ADMIN_API_INVENTORY,
  type InventoryEntry,
  type ServerName,
} from '../src/http/admin-api-inventory';

interface DiscoveredRoute {
  method: string;
  path: string;
  file: string;
  line: number;
  server: ServerName | 'Unknown';
  fullPath: string;
}

// ============================================================================
// Configuration
// ============================================================================

const SRC_DIR = join(__dirname, '..', 'src');
const EXCLUDE_PATTERNS = [/\.test\.ts$/, /\.d\.ts$/, /node_modules/];

// Route-registration patterns.
//   - `router.METHOD('path', ...)`            (Express Router)
//   - `this._app.METHOD('path', ...)`         (class-bound app instance)
//   - `app.METHOD('path', ...)` with negative look-behind to avoid matching
//     `this._app.` (F3) or any other `<word>.app.`.
const ROUTE_PATTERNS = [
  /router\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/gi,
  /this\._app\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/gi,
  /(?<![\w.])app\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/gi,
];

/**
 * Map a source file (relative to `packages/connector/src`) to the HTTP server
 * that mounts its routes and whether the `/admin` prefix must be added to
 * discovered paths.
 *
 * Returns `null` for files we do not recognize; the caller flags those as a
 * discovery warning so a future server file can't silently evade the check.
 */
function classifyFile(relFile: string): { server: ServerName; addAdminPrefix: boolean } | null {
  // admin-api.ts or any future split file like admin-api-peers.ts, admin-api-channels.ts
  if (/^http\/admin-api(-[\w.-]+)?\.ts$/.test(relFile)) {
    return { server: 'AdminServer', addAdminPrefix: true };
  }
  if (relFile === 'http/admin-server.ts') {
    return { server: 'AdminServer', addAdminPrefix: false };
  }
  if (relFile === 'http/health-server.ts') {
    return { server: 'HealthServer', addAdminPrefix: false };
  }
  if (relFile === 'settlement/settlement-api.ts') {
    return { server: 'HealthServer', addAdminPrefix: false };
  }
  return null;
}

// ============================================================================
// File discovery
// ============================================================================

function findTsFiles(dir: string): string[] {
  const files: string[] = [];
  function walk(currentDir: string): void {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !EXCLUDE_PATTERNS.some((p) => p.test(fullPath))
      ) {
        files.push(fullPath);
      }
    }
  }
  walk(dir);
  return files;
}

// ============================================================================
// Route discovery
// ============================================================================

function discoverRoutes(filePath: string): DiscoveredRoute[] {
  const relativePath = relative(SRC_DIR, filePath);
  if (!relativePath) return [];

  const classification = classifyFile(relativePath);
  // Scan only files classified as route-registering servers. Unclassified files
  // will be reported separately if they appear to register routes.
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const routes: DiscoveredRoute[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue; // F1: noUncheckedIndexedAccess guard

    for (const pattern of ROUTE_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        const methodRaw = match[1];
        const pathRaw = match[2];
        if (!methodRaw || !pathRaw) continue;

        const method = methodRaw.toUpperCase();
        const server: ServerName | 'Unknown' = classification?.server ?? 'Unknown';
        const fullPath =
          classification?.addAdminPrefix && !pathRaw.startsWith('/admin')
            ? '/admin' + pathRaw
            : pathRaw;

        routes.push({
          method,
          path: pathRaw,
          file: relativePath,
          line: i + 1,
          server,
          fullPath,
        });
      }
    }
  }

  return routes;
}

// ============================================================================
// Key normalization — now server-aware (F2)
// ============================================================================

function discoveredKey(r: DiscoveredRoute): string {
  return `${r.server}|${r.method} ${r.fullPath}`;
}

function inventoryKey(e: InventoryEntry): string {
  const fullPath = e.mountPrefix ? e.mountPrefix + e.path : e.path;
  return `${e.server}|${e.method} ${fullPath}`;
}

// ============================================================================
// Main comparison logic
// ============================================================================

function runCheck(): { success: boolean; errors: string[] } {
  const errors: string[] = [];

  // 1. Discover all routes from source
  const sourceFiles = findTsFiles(SRC_DIR);
  const discoveredRoutes: DiscoveredRoute[] = [];
  for (const file of sourceFiles) {
    discoveredRoutes.push(...discoverRoutes(file));
  }

  // 2. Warn on routes discovered in files we do not classify — prevents a
  //    future server file from silently evading the drift check (F5 hardening).
  const unclassified = discoveredRoutes.filter((r) => r.server === 'Unknown');
  if (unclassified.length > 0) {
    errors.push(
      '❌ UNCLASSIFIED ROUTE-REGISTERING FILES (extend classifyFile() in scripts/check-admin-api-inventory.ts):'
    );
    const seen = new Set<string>();
    for (const r of unclassified) {
      const tag = `${r.file}:${r.line}  ${r.method} ${r.path}`;
      if (!seen.has(tag)) {
        seen.add(tag);
        errors.push(`   ${tag}`);
      }
    }
  }

  // 3. Build server-keyed sets
  const discoveredSet = new Map<string, DiscoveredRoute>();
  for (const route of discoveredRoutes) {
    if (route.server === 'Unknown') continue;
    discoveredSet.set(discoveredKey(route), route);
  }

  const inventorySet = new Map<string, InventoryEntry>();
  for (const entry of ADMIN_API_INVENTORY) {
    inventorySet.set(inventoryKey(entry), entry);
  }

  // 4. Routes in source but not in inventory
  const undocumentedRoutes: DiscoveredRoute[] = [];
  for (const [key, route] of discoveredSet) {
    if (!inventorySet.has(key)) undocumentedRoutes.push(route);
  }

  // 5. Routes in inventory but not in source
  const obsoleteRoutes: InventoryEntry[] = [];
  for (const [key, entry] of inventorySet) {
    if (!discoveredSet.has(key)) obsoleteRoutes.push(entry);
  }

  // 6. Report
  if (undocumentedRoutes.length > 0) {
    errors.push('❌ UNDOCUMENTED ROUTES (add to admin-api-inventory.ts):');
    for (const r of undocumentedRoutes) {
      errors.push(`   [${r.server}] ${r.method} ${r.fullPath} (${r.file}:${r.line})`);
    }
  }
  if (obsoleteRoutes.length > 0) {
    errors.push('❌ OBSOLETE INVENTORY ENTRIES (remove from admin-api-inventory.ts):');
    for (const e of obsoleteRoutes) {
      const fullPath = e.mountPrefix ? e.mountPrefix + e.path : e.path;
      errors.push(`   [${e.server}] ${e.method} ${fullPath}`);
    }
  }

  const success = errors.length === 0;
  if (success) {
    // Unique route count (dedupe against overlapping regex patterns — F3 safety)
    const uniqueDiscovered = new Set(discoveredRoutes.map(discoveredKey)).size;
    console.log(`✅ Admin API inventory check passed`);
    console.log(`   Discovered: ${uniqueDiscovered} unique routes in source`);
    console.log(`   Inventory:  ${ADMIN_API_INVENTORY.length} entries documented`);
    console.log(`   All routes documented ✓`);
  } else {
    console.error(errors.join('\n'));
    console.error(`\n❌ Admin API inventory drift detected!`);
    console.error(`   Update packages/connector/src/http/admin-api-inventory.ts`);
  }

  return { success, errors };
}

// ============================================================================
// Entry point
// ============================================================================

if (require.main === module) {
  const startTime = Date.now();
  const result = runCheck();
  const duration = Date.now() - startTime;
  console.log(`\n⏱️  Duration: ${duration}ms`);
  if (!result.success) process.exit(1);
}

export { runCheck, discoverRoutes };
