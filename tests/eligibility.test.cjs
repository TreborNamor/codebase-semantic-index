const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTs } = require('./helpers.cjs');

class Uri {
  constructor(path, scheme = 'file', authority = '', query = '') { Object.assign(this, { path, scheme, authority, query, fragment: '' }); }
  with(changes) { return Object.assign(new Uri(this.path, this.scheme, this.authority, this.query), this, changes); }
  toString() { return `${this.scheme}://${this.authority}${this.path}${this.query ? '?' + this.query : ''}`; }
  static joinPath(base, ...parts) { return base.with({ path: base.path.replace(/\/$/, '') + '/' + parts.join('/') }); }
}
class FileSystemError extends Error { constructor(code) { super(code); this.code = code; } }
function utils(overrides = {}) {
  const vscode = {
    Uri, FileSystemError, RelativePattern: class { constructor(base, pattern) { this.baseUri = base; this.pattern = pattern; } },
    workspace: {
      getConfiguration: () => ({ get: () => undefined }),
      findFiles: async () => [],
      fs: { readFile: async () => { throw new FileSystemError('FileNotFound'); } },
      ...overrides,
    },
  };
  return loadTs('src/utils.ts', { vscode });
}

test('root membership distinguishes sibling directories, remote authorities, schemes, and queries', () => {
  const { relativeWorkspacePath, workspaceKey, isInsideWorkspaceRoot } = utils();
  const root = new Uri('/repo', 'vscode-remote', 'ssh-remote+hostA');
  assert.equal(relativeWorkspacePath(new Uri('/repo/src/main.ts', root.scheme, root.authority), root), 'src/main.ts');
  for (const uri of [new Uri('/repo-other/a.ts', root.scheme, root.authority), new Uri('/repo/a.ts', root.scheme, 'ssh-remote+hostB'), new Uri('/repo/a.ts'), new Uri('/repo/../other/a.ts', root.scheme, root.authority), new Uri('/repo/a.ts', root.scheme, root.authority, 'other-checkout')]) {
    assert.equal(isInsideWorkspaceRoot(uri, root), false);
  }
  assert.notEqual(workspaceKey(root), workspaceKey(root.with({ authority: 'ssh-remote+hostB' })));
  assert.equal(workspaceKey(root), workspaceKey(root.with({ path: '/repo/' })));
  assert.equal(relativeWorkspacePath(new Uri('/a.ts'), new Uri('/')), 'a.ts');
});

test('root-scoped exclusion defaults can be overridden without disabling mandatory exclusions', () => {
  const root = new Uri('/repo');
  const scopes = [];
  const { buildExcludeGlob } = utils({ getConfiguration(section, uri) {
    scopes.push(uri);
    const values = {
      files: { exclude: { '**/hidden/**': true, '**/conditional/**': { when: '$(basename).js' } } },
      search: { exclude: { '**/hidden/**': false, '**/logs/**': true } },
      codebaseSemanticIndex: { exclude: { '**/dist/**': false, '**/fixtures/**': true, '**/.git/**': false } },
    };
    return { get: key => values[section]?.[key] };
  } });
  const glob = buildExcludeGlob(root);
  assert.ok(glob.includes('**/.git/**'));
  assert.ok(glob.includes('**/hidden/**'));
  assert.ok(glob.includes('**/logs/**'));
  assert.ok(glob.includes('**/fixtures/**'));
  assert.ok(!glob.includes('**/dist/**'));
  assert.ok(!glob.includes('**/conditional/**'));
  assert.ok(scopes.every(scope => scope === root));
});

test('nested gitignore rules honor negation, anchoring, escaped names, and ignored parent directories', () => {
  const { createGitignoreFilter } = loadTs('src/eligibility.ts');
  const ignored = createGitignoreFilter([
    { base: '', contents: '*.generated.ts\n/root-only.ts\nblocked/\n\\#literal.ts\n' },
    { base: 'src', contents: '!keep.generated.ts\nlocal.ts\n' },
    { base: 'blocked', contents: '!resurrect.ts\n' },
  ]);
  assert.equal(ignored('main.generated.ts'), true);
  assert.equal(ignored('src/keep.generated.ts'), false);
  assert.equal(ignored('src/deeper/keep.generated.ts'), false);
  assert.equal(ignored('root-only.ts'), true);
  assert.equal(ignored('src/root-only.ts'), false);
  assert.equal(ignored('src/local.ts'), true);
  assert.equal(ignored('blocked/resurrect.ts'), true);
  assert.equal(ignored('#literal.ts'), true);
  assert.equal(ignored('../outside.ts'), true);
});

test('gitignore snapshot reads root and nested rules and excludes foreign roots', async () => {
  const root = new Uri('/repo');
  const nested = new Uri('/repo/src/.gitignore');
  const files = new Map([['/repo/.gitignore', '*.tmp.ts\n'], [nested.path, 'private.ts\n']]);
  const { buildGitignoreFilter } = utils({
    findFiles: async () => [nested],
    fs: { readFile: async uri => {
      if (!files.has(uri.path)) throw new FileSystemError('FileNotFound');
      return new TextEncoder().encode(files.get(uri.path));
    } },
  });
  const ignored = await buildGitignoreFilter(root);
  assert.equal(ignored(new Uri('/repo/a.tmp.ts')), true);
  assert.equal(ignored(new Uri('/repo/src/private.ts')), true);
  assert.equal(ignored(new Uri('/repo/src/public.ts')), false);
  assert.equal(ignored(new Uri('/other/public.ts')), true);
});

test('unreadable ignore rules fail closed rather than silently widening index eligibility', async () => {
  const { buildGitignoreFilter } = utils({ fs: { readFile: async () => { throw new Error('permission denied'); } } });
  await assert.rejects(() => buildGitignoreFilter(new Uri('/repo')), /permission denied/);
});

test('opting a generated directory back in also restores its nested gitignore semantics', async () => {
  const { mockVscode } = require('./mockVscode.cjs');
  const env = mockVscode();
  const root = env.vscode.Uri.parse('file:///repo');
  env.addRoot(root, 'app');
  env.addFile(root, 'vendor/.gitignore', 'private.ts\n');
  const privateFile = env.addFile(root, 'vendor/private.ts', 'private();');
  const publicFile = env.addFile(root, 'vendor/public.ts', 'public();');
  env.settings.set(root.toString() + ':codebaseSemanticIndex.exclude', { '**/vendor/**': false });
  const { buildGitignoreFilter, buildExcludeGlob } = loadTs('src/utils.ts', { vscode: env.vscode });
  assert.ok(!buildExcludeGlob(root).includes('**/vendor/**'));
  const ignored = await buildGitignoreFilter(root);
  assert.equal(ignored(privateFile), true);
  assert.equal(ignored(publicFile), false);
});
