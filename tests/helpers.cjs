const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Each load has its own module cache, so tests do not share extension state.
function loadTs(relativePath, mocks = {}) {
  const cache = new Map();
  function load(filename) {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    if (filename.endsWith('.html')) return fs.readFileSync(filename, 'utf8');
    const module = { exports: {} };
    cache.set(filename, module);
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: false },
      fileName: filename,
    }).outputText;
    const localRequire = specifier => {
      if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
      if (specifier.startsWith('.')) {
        const candidate = path.resolve(path.dirname(filename), specifier);
        return load(path.extname(candidate) ? candidate : candidate + '.ts');
      }
      return require(specifier);
    };
    vm.runInThisContext('(function(require,module,exports,__filename,__dirname){' + source + '\n})', { filename })(
      localRequire, module, module.exports, filename, path.dirname(filename),
    );
    return module.exports;
  }
  return load(path.resolve(__dirname, '..', relativePath));
}

module.exports = { loadTs };
