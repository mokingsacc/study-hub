// Problem reports and the request traces behind them (worker/src/debug/, 0072_bug_capture.sql). Their routes are the
// hub's own (router.js); here only why neither table is in the export.
export const EXPORT_SKIP = {
  debug_traces: 'request traces kept for 7 days to debug a report; they mean nothing on another hub',
  bug_reports: 'problem reports for Claude Code to fix; screenshots live in the library bucket, and a closed report has done its job',
};
