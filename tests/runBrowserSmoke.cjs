const fs = require('node:fs');
const path = require('node:path');
const { runTests } = require('@vscode/test-web');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const browsers = new Set();
const originalLaunch = chromium.launch;

// test-web owns normal browser shutdown. Capture its browser for watchdog cleanup and intercept
// model downloads so this integration test remains a small lexical-fallback smoke test.
chromium.launch = async function (options) {
	const browser = await originalLaunch.call(this, options);
	browsers.add(browser);
	const originalContext = browser.newContext.bind(browser);
	browser.newContext = async function (contextOptions) {
		const context = await originalContext(contextOptions);
		await context.route(/^https:\/\/(?:[^/]+\.)?(?:huggingface\.co|hf\.co)\//, route => route.abort('blockedbyclient'));
		return context;
	};
	return browser;
};

async function main() {
	for (const file of ['dist/web/extension.js', 'dist/test/browserSmoke.js']) {
		if (!fs.existsSync(path.join(root, file))) throw new Error(`Build ${file} before running the browser smoke test.`);
	}
	let timer;
	try {
		await Promise.race([
			runTests({
				browserType: 'chromium', quality: 'stable', headless: true,
				extensionDevelopmentPath: root,
				extensionTestsPath: path.join(root, 'dist', 'test', 'browserSmoke.js'),
				folderPath: path.join(root, 'tests', 'fixtures', 'workspace'),
				testRunnerDataDir: path.join(root, '.vscode-test-web'),
				port: 3037, verbose: true,
			}),
			new Promise((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error('VS Code web smoke run exceeded 180 seconds, including startup/download.')), 180_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
		chromium.launch = originalLaunch;
		await Promise.allSettled([...browsers].map(browser => browser.close()));
	}
}

main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
