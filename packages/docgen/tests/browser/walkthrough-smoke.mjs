import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { runWalkthroughCaptureCommand, runWalkthroughReviewCommand } from '../../dist/commands/walkthrough.js';
import { runCheckCommand } from '../../dist/commands/check.js';
import { loadWalkthroughs } from '../../dist/walkthrough/store.js';
import { createLogger } from '../../dist/util/logger.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-browser-walkthrough-'));
const logger = createLogger({ level: 'silent' });
const html = '<!doctype html><html><head><title>Profile</title><style>body{font:18px system-ui;padding:40px;background:#eef2f7}main{padding:32px;background:white;border-radius:12px;max-width:650px}input{display:block;padding:8px;margin:12px 0}button{padding:12px;color:white;background:#234bb5;border:0}#private{background:#ddd}</style></head><body><main><h1>Profile settings</h1><input id="name" value="Sample user"><input type="password" value="PASSWORD"><input id="api-key" value="TOKEN"><div id="private">Private account details</div><button id="save" onclick="document.querySelector(\'#success\').textContent=\'Profile saved\'">Save profile</button><p id="success"></p></main></body></html>';
const server = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(html); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const previousSecret = process.env.DOCGEN_BROWSER_DEMO_SECRET;
process.env.DOCGEN_BROWSER_DEMO_SECRET = 'ENVIRONMENT_SECRET';
try {
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'browser-walkthrough-demo', private: true }));
  for (const args of [['init'], ['config', 'user.email', 'demo@example.com'], ['config', 'user.name', 'Walkthrough demo'], ['add', '.'], ['commit', '-m', 'demo baseline']]) {
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=disabled-hooks', ...args], { cwd: root, windowsHide: true, stdio: 'pipe', timeout: 10000 });
  }
  await fs.writeFile(path.join(root, 'flow.json'), JSON.stringify({
    schemaVersion: 1, id: 'profile', title: 'Update your profile', startUrl: `http://127.0.0.1:${address.port}/profile?token=QUERY_SECRET#private`,
    viewport: { width: 1100, height: 800 }, maskSelectors: ['#private'],
    steps: [
      { title: 'Open settings', instruction: 'Open profile settings.' },
      { title: 'Save profile', instruction: 'Enter a name and choose Save profile.', expected: 'Profile saved is visible.', actions: [{ type: 'fill', selector: '#name', value: 'Demo user' }, { type: 'fill', selector: '#api-key', valueEnv: 'DOCGEN_BROWSER_DEMO_SECRET' }, { type: 'click', selector: '#save' }, { type: 'wait', selector: '#success' }] },
    ],
  }));
  const channel = process.env.DOCGEN_BROWSER_CHANNEL;
  await runWalkthroughCaptureCommand({ cwd: root, file: 'flow.json', logger, ...(channel === undefined ? {} : { channel }) });
  let record = (await loadWalkthroughs(root))[0];
  assert.equal(record?.status, 'draft');
  assert.equal(record?.steps.length, 2);
  assert.notEqual(record.steps[0].screenshot.sha256, record.steps[1].screenshot.sha256);
  for (const step of record.steps) assert.ok((await fs.stat(path.join(root, step.screenshot.file))).size > 1000);
  const serialized = JSON.stringify(record);
  for (const secret of ['PASSWORD', 'TOKEN', 'QUERY_SECRET', 'ENVIRONMENT_SECRET', 'DOCGEN_BROWSER_DEMO_SECRET']) assert.ok(!serialized.includes(secret));
  await runCheckCommand({ cwd: root, logger });
  await runWalkthroughReviewCommand({ cwd: root, id: 'profile', logger });
  record = (await loadWalkthroughs(root))[0];
  assert.equal(record.review.reviewedBy, 'demo@example.com');
  await runCheckCommand({ cwd: root, logger });
  const guide = await fs.readFile(path.join(root, 'docs/generated/walkthroughs/profile.md'), 'utf8');
  assert.match(guide, /\!\[Save profile\]/);
  assert.match(guide, /Reviewed/);
  console.log('Real browser walkthrough capture, masking, review, and documentation checks passed.');
} finally {
  if (previousSecret === undefined) delete process.env.DOCGEN_BROWSER_DEMO_SECRET;
  else process.env.DOCGEN_BROWSER_DEMO_SECRET = previousSecret;
  await new Promise((resolve) => server.close(resolve));
  assert.ok(root.startsWith(path.join(os.tmpdir(), 'docgen-browser-walkthrough-')));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
