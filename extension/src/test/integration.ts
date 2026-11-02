import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function statusWhen(predicate: (status: any) => boolean): Promise<any> {
  const deadline = Date.now() + 25000;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const status = await vscode.commands.executeCommand<any>('codeconverge.test.status');
      if (status && predicate(status)) return status;
      last = status;
    } catch (error) { last = String(error); }
    await delay(200);
  }
  throw new Error(`Editor session did not become current: ${JSON.stringify(last)}`);
}

async function callMcp(tool: string, args: Record<string, unknown> = {}): Promise<any> {
  const definition = await vscode.commands.executeCommand<vscode.McpStdioServerDefinition>('codeconverge.test.mcpDefinition');
  assert.ok(definition);
  assert.ok(definition.env.CODECONVERGE_SESSION_ID, 'The provider published no editor session');
  assert.ok(definition.env.CODECONVERGE_SESSION_TOKEN, 'The provider published no session capability');
  const script = [
    'import asyncio,json,os,sys',
    'from mcp import Client',
    'from mcp.client.stdio import StdioServerParameters',
    'async def main():',
    ' async with Client(StdioServerParameters(command=sys.executable,args=["-m","codeconverge","mcp"],env=dict(os.environ))) as client:',
    '  response=await client.call_tool(sys.argv[1],json.loads(sys.argv[2]))',
    '  print(response.model_dump_json(by_alias=True))',
    'asyncio.run(main())'
  ].join('\n');
  const env: NodeJS.ProcessEnv = {...process.env};
  for (const [key, value] of Object.entries(definition.env)) {
    if (value === null) delete env[key]; else env[key] = String(value);
  }
  const {stdout} = await execFileAsync(definition.command, ['-c', script, tool, JSON.stringify(args)], {env, windowsHide: true, timeout: 20000});
  const response = JSON.parse(stdout.trim());
  assert.ok(!response.isError, JSON.stringify(response));
  return response.structuredContent ?? JSON.parse(response.content.find((c: any) => c.type === 'text').text);
}

export async function run(): Promise<void> {
  const evidencePath = process.env.CODECONVERGE_TEST_EVIDENCE;
  assert.ok(evidencePath, 'Test launcher must specify its evidence file');
  const checks: string[] = [];
  try {
    const extension = vscode.extensions.getExtension('codeconverge.codeconverge');
    assert.ok(extension);
    // Do not call extension.activate(): discovery must work after startup.
    // Ask the actual provider before local status can establish its session.
    // The launcher delays startup to exercise discovery racing the handshake.
    const deadline = Date.now() + 25000;
    let mcpStatus: any;
    while (Date.now() < deadline) {
      const commands = await vscode.commands.getCommands(true);
      if (commands.includes('codeconverge.test.mcpDefinition')) {
        mcpStatus = await callMcp('index_status');
        break;
      }
      await delay(50);
    }
    assert.ok(mcpStatus, 'The startup provider did not become available');
    checks.push('first provider discovery carries live window capability');
    const initial = await statusWhen(() => true);
    assert.ok(extension.isActive);
    checks.push('automatic startup activation');
    const folders = vscode.workspace.workspaceFolders ?? [];
    assert.equal(initial.roots.length, vscode.workspace.isTrusted ? folders.length : 0);
    checks.push('workspace API authority');
    assert.equal(mcpStatus.session_id, initial.session_id);
    assert.deepEqual(mcpStatus.roots, initial.roots);
    checks.push('actual stdio MCP invocation using editor-provided definition');
    let trustedSourceChecks = false;
    if (folders.length && vscode.workspace.isTrusted) {
      const knownMulti = process.env.CODECONVERGE_TEST_KNOWN_MULTI === '1';
      const found = await callMcp('find_symbol', {name: 'alpha_beacon'});
      assert.equal(found.results.length, 1);
      assert.equal(found.results[0].path, knownMulti ? 'dashboard.py' : 'alpha.py');
      assert.equal(found.results[0].start_line, knownMulti ? 4 : 1);
      checks.push('source-grounded definition and original lines');
      const bPath = process.env.CODECONVERGE_TEST_SECOND_ROOT;
      assert.ok(bPath);
      if (knownMulti) {
        assert.equal(folders.length, 2);
        assert.ok(vscode.workspace.updateWorkspaceFolders(1, 1));
        await statusWhen(s => s.roots.length === 1);
        assert.deepEqual((await callMcp('find_symbol', {name: 'beta_beacon'})).results, []);
        checks.push('removed root excluded from subsequent MCP results');
        assert.ok(vscode.workspace.updateWorkspaceFolders(1, 0, {uri: folders[1].uri, name: folders[1].name}));
        const restored = await statusWhen(s => s.roots.length === 2);
        assert.equal(restored.session_id, initial.session_id);
        assert.equal((await callMcp('find_symbol', {name: 'beta_beacon'})).results.length, 1);
        assert.deepEqual(restored.roots.map((r: any) => r.project_id), initial.roots.map((r: any) => r.project_id));
        checks.push('multi-root live restoration reuses project IDs');
      } else {
      assert.ok(vscode.workspace.updateWorkspaceFolders(folders.length, 0, {uri: vscode.Uri.file(bPath), name: 'second-root'}));
      const multi = await statusWhen(s => s.roots.length === initial.roots.length + 1);
      assert.equal(multi.session_id, initial.session_id);
      const beta = await callMcp('find_symbol', {name: 'beta_beacon'});
      assert.equal(beta.results.length, 1);
      checks.push('multi-root live addition');
      assert.ok(vscode.workspace.updateWorkspaceFolders(folders.length, 1));
      await statusWhen(s => s.roots.length === initial.roots.length);
      const revoked = await callMcp('find_symbol', {name: 'beta_beacon'});
      assert.deepEqual(revoked.results, []);
      checks.push('removed root excluded from subsequent MCP results');
      }
      trustedSourceChecks = true;
    } else if (folders.length) {
      const rejected = await callMcp('find_symbol', {name: 'alpha_beacon'});
      assert.equal(rejected.error.code, 'UNTRUSTED_WORKSPACE');
      assert.equal(initial.roots.length, 0);
      checks.push('untrusted workspace source access rejected');
    } else {
      const found = await callMcp('find_symbol', {name: 'alpha_beacon'});
      assert.equal(found.error.code, initial.trusted ? 'NO_ACTIVE_WORKSPACE' : 'UNTRUSTED_WORKSPACE');
      checks.push('empty window fails closed');
    }
    await fs.mkdir(path.dirname(evidencePath), {recursive: true});
    await fs.writeFile(evidencePath, JSON.stringify({passed: true, vscode: vscode.version, trusted: vscode.workspace.isTrusted, trustedSourceChecks, checks, actualCopilotInvocation: false}, null, 2));
  } catch (error) {
    await fs.mkdir(path.dirname(evidencePath), {recursive: true});
    await fs.writeFile(evidencePath, JSON.stringify({passed: false, checks, error: String(error), actualCopilotInvocation: false}, null, 2));
    throw error;
  }
}
