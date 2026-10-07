import { readFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';

/**
 * Runs once after the whole request-test run: removes ONLY the data of this run's workspace (`ws_<run slug>`),
 * so repeated runs never litter Atlas with per-run workspaces. The slug is generated in vitest.config.e2e.ts.
 */
export default function setup() {
  return async function teardown() {
    const slug = process.env.E2E_RUN_SLUG;
    if (!slug || slug === 'dev' || !/^t[a-z0-9]{8,}$/.test(slug)) return; // never touch anything that is not a generated run workspace
    const ws = `ws_${slug}`;
    const env = readFileSync('.env', 'utf8').split('\n');
    const get = (k: string) => env.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1);
    const client = new MongoClient(get('MONGODB_URI')!);
    await client.connect();
    const db = client.db(get('MANAGEMENT_DB_NAME') || 'management_db');
    for (const c of ['outbox', 'work_items', 'boards', 'issue_sequences', 'projects', 'team_memberships', 'teams', 'users']) await db.collection(c).deleteMany({ workspaceId: ws });
    await db.collection('workspaces').deleteOne({ _id: ws });
    await client.close();
  };
}
