/**
 * Runs inside each request-test worker BEFORE the test file imports the app: gives every test file its own
 * workspace (`ws_<run slug><3 random chars>`), so files cannot see each other's rows and the result no longer
 * depends on file order. test/global-teardown.ts removes every workspace of the run afterwards.
 */
process.env.WORKSPACE_SLUG = `${process.env.E2E_RUN_SLUG}${Math.random().toString(36).slice(2, 5)}`;
